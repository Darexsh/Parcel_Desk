import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  GEODIS_PL_CANCEL, GEODIS_PL_CANCELLED, GEODIS_PL_CLAIM, GEODIS_PL_LABELS, geodisPlStage,
} from './status.js';

export const PROVIDER = 'GEODIS Poland';
// The search page is about 25 kB and a history about 1 kB.
export const GEODIS_PL_MAX_BYTES = 512 * 1024;
// PL and sixteen digits, as the network's own shipments are numbered.
const NUMBER = /^PL\d{16}$/;
// The English page's answer for a number it does not hold, and its (Polish) answer for an input it refuses.
const NOT_FOUND = 'Shipment with such number does not exist';
const REFUSED = 'Proszę wprowadzić właściwy numer przesyłki.';
// The summary rows this parser reads. The delivery location (postcode and town) and every other row are never read.
const SHIPMENT = 'Shipment No.';
const STATUS = 'Status';
const DESTINATION = 'Delivery Country';
const SUMMARY_LABELS = new Set([SHIPMENT, STATUS, DESTINATION]);
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required/i;
// A terminal code: the country, then the terminal ("PLWAW").
const BRANCH = /^([A-Z]{2})[A-Z0-9]{1,8}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(?:\.\d{1,6})?$/;
const HOME = 'Europe/Warsaw';
// Handheld clocks can run a little early; a scan further ahead of the read is not one yet.
const CLOCK_SKEW_MS = 3_600_000;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A GEODIS Poland shipment number; anything else is a number its tracker is not asked for. */
export function normalizeGeodisPlNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GEODIS Poland shipment numbers are PL and sixteen digits');
  return number;
}

/** What the search page says about the shipment: its current status and where it goes. */
export interface GeodisPlSummary {
  status: string;
  destinationCountry?: string;
}

/**
 * The search page for one number (`GET /en/?ShNumber=`). It names the shipment
 * it found, which must be the number asked, or answers the number it echoes in
 * its search field with a not-found or refusal notice.
 */
export function parseGeodisPlSummary(html: string, raw: string): GeodisPlSummary {
  const number = normalizeGeodisPlNumber(raw);
  const $ = load(html);
  const article = $('#formularz-wyszukiwania-przesylki');
  if (article.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GEODIS Poland answered with a browser check');
    throw new SchemaError(PROVIDER, 'GEODIS Poland tracking form changed');
  }
  const fields = article.find('input[name="ShNumber"]');
  const echoed = fields.length === 1 ? normalizeTrackingNumber(clean(fields.attr('value'), 80)) : '';
  const details = article.find('dl.package-details');
  const notices = article.children('p').map((_, node) => clean($(node).text(), 200)).get();
  if (!details.length) {
    if (echoed !== number) throw new SchemaError(PROVIDER, 'GEODIS Poland did not answer for the requested number');
    if (notices.length === 1 && notices[0] === NOT_FOUND) throw new NotFoundError(PROVIDER);
    if (notices.length === 1 && notices[0] === REFUSED) throw new InvalidInputError(PROVIDER, 'GEODIS Poland refused the shipment number', { reason: 'wrong_number' });
    throw new SchemaError(PROVIDER, 'GEODIS Poland returned neither a shipment nor its not-found notice');
  }
  if (details.length !== 1 || notices.includes(NOT_FOUND)) throw new SchemaError(PROVIDER, 'GEODIS Poland returned an ambiguous search page');

  const summary = new Map<string, string>();
  for (const label of details.children('dt').toArray()) {
    const name = clean($(label).text(), 64);
    if (!SUMMARY_LABELS.has(name)) continue;
    if (summary.has(name)) throw new SchemaError(PROVIDER, 'GEODIS Poland summary repeats a row');
    const value = $(label).next('dd').clone();
    value.find('a').remove();
    summary.set(name, clean(value.text(), 200));
  }
  const shipment = normalizeTrackingNumber(summary.get(SHIPMENT) ?? '');
  if (!shipment) throw new SchemaError(PROVIDER, 'GEODIS Poland summary has no shipment number');
  const linked = details.find('a.jsHistoryLink').map((_, node) => normalizeTrackingNumber(clean($(node).attr('data-package-no'), 80))).get();
  if (shipment !== number || linked.some((value) => value !== number)) {
    throw new IndeterminateError(PROVIDER, 'GEODIS Poland answered with another shipment');
  }
  const status = summary.get(STATUS);
  if (!status) throw new SchemaError(PROVIDER, 'GEODIS Poland summary has no status');
  const destination = summary.get(DESTINATION) ?? '';
  return { status, ...(/^[A-Z]{2}$/.test(destination) ? { destinationCountry: destination } : {}) };
}

interface Scan {
  code: string;
  wall: string;
  event: CarrierEvent;
}

/** A required text field; a number only where the reply may send a code as one. */
function field(row: Record<string, unknown>, key: string, maxLength: number, scalar = false): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && !(scalar && typeof value === 'number')) {
    throw new SchemaError(PROVIDER, `GEODIS Poland returned an invalid ${key}`);
  }
  return scalar ? cleanScalar(value, maxLength) : clean(value, maxLength);
}

/** A row's wall clock, `yyyy-MM-ddTHH:mm:ss`; the history gives no offset. */
function wallClock(stamp: string): string {
  const match = CLOCK.exec(stamp);
  const wall = match ? `${match[1]}T${match[2]}:${match[3] ?? '00'}` : '';
  const parsed = wall ? DateTime.fromISO(wall, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'GEODIS Poland returned an invalid scan time');
  }
  return wall;
}

/**
 * One history row. A Polish terminal's scan is on Polish time; a terminal
 * abroad keeps its wall clock. `TS_REMARKS` is never read.
 */
function projectRow(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GEODIS Poland returned an invalid scan');
  const code = field(row, 'TS_SCAN', 8, true);
  if (!/^\d{1,4}$/.test(code)) throw new SchemaError(PROVIDER, 'GEODIS Poland returned a scan without its code');
  const wall = wallClock(field(row, 'TS_TIME', 40));
  const branch = field(row, 'TS_SCAN_BRANCH', 16).toUpperCase();
  const place = field(row, 'TS_SCAN_PLACE', 100);
  const description = GEODIS_PL_LABELS[code] ?? field(row, 'TS_SCAN_TEXT', 200);
  if (!description) throw new SchemaError(PROVIDER, 'GEODIS Poland returned a scan without its wording');
  const country = BRANCH.exec(branch)?.[1];
  const instant = country === 'PL' ? zonedTime(wall, "yyyy-MM-dd'T'HH:mm:ss", HOME) : null;
  const location = place && country && country !== 'PL' ? `${place} - ${country}` : place;
  return {
    code,
    wall,
    event: {
      ...(instant ? { time: instant.iso } : { local_time: wall }),
      description,
      ...(location ? { location } : {}),
      provider_code: code,
    },
  };
}

/** A shipment the search page knows but whose history holds no scans (yet). */
function summaryOnly(summary: GeodisPlSummary): CarrierResult {
  const worded = classifyWording(summary.status, 'registered');
  return {
    status: languageStageStatus(worded.stage),
    current_stage: worded.stage,
    current_stage_source: worded.source,
    last_status_text: summary.status,
    last_update: null,
    expected_delivery: null,
    ...(summary.destinationCountry ? { destination_country: summary.destinationCountry } : {}),
    summary_only: true,
    events: [],
  };
}

/** What a reply other than rows holds, without its values: `false`, a string, or an object and its first keys. */
function jsonKind(value: unknown): string {
  if (typeof value === 'boolean') return String(value);
  if (!isRecord(value)) return `a ${typeof value}`;
  const keys = Object.keys(value);
  return `an object${keys.length ? ` keyed ${keys.slice(0, 4).map((key) => key.slice(0, 20)).join(', ')}${keys.length > 4 ? ', …' : ''}` : ''}`;
}

/**
 * The shipment's history (`GET /en/?ltlHistory=`): JSON rows oldest first, or
 * `null` when it holds none. It does not echo the number; the search page,
 * read first, binds the shipment. Identical rows are one scan. A pseudo-scan
 * (300) cancels the delivery, return and claim scans before it and is dropped
 * with them. A scan dated over an hour after the read is held back.
 */
export function parseGeodisPlHistory(payload: unknown, summary: GeodisPlSummary, readAt = Date.now()): CarrierResult {
  if (payload === null) return summaryOnly(summary);
  if (!Array.isArray(payload)) throw new SchemaError(PROVIDER, `GEODIS Poland returned an invalid history (${jsonKind(payload)})`);
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GEODIS Poland returned an oversized history');

  const seen = new Set<string>();
  const rows: Scan[] = [];
  for (const row of payload) {
    const scan = projectRow(row);
    const key = JSON.stringify([scan.code, scan.wall, scan.event.location ?? '', scan.event.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (scan.event.time && Date.parse(scan.event.time) > readAt + CLOCK_SKEW_MS) continue;
    rows.push(scan);
  }
  // Oldest first by wall clock; a stable sort keeps the reply's order on one clock.
  rows.sort((a, b) => (a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : 0));

  let kept: Scan[] = [];
  for (const scan of rows) {
    if (scan.code === GEODIS_PL_CANCEL) {
      kept = kept.filter((earlier) => !GEODIS_PL_CANCELLED.has(earlier.code));
      continue;
    }
    kept.push(scan);
  }
  // A claim keeps the stage the shipment had; other rows take their code's stage, else the wording's.
  let previous: Stage | undefined;
  for (const { code, event } of kept) {
    if (code === GEODIS_PL_CLAIM) {
      if (previous) Object.assign(event, { stage: previous, stage_source: 'none' });
      continue;
    }
    const staged = geodisPlStage(code, event.description!);
    if (!staged) continue;
    Object.assign(event, { stage: staged.stage, stage_source: staged.source });
    previous = staged.stage;
  }
  if (!kept.length) return summaryOnly(summary);

  const events = kept.map((scan) => scan.event).reverse();
  const newest = events[0]!;
  // The newest scan that moved the shipment decides its status; a claim does not.
  const current = [...kept].reverse().find((scan) => scan.code !== GEODIS_PL_CLAIM && scan.event.stage)?.event;
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: (current ?? newest).description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    ...(summary.destinationCountry ? { destination_country: summary.destinationCountry } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
