import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { proshipsStage } from './status.js';

export const PROVIDER = 'ProShips';
// The tracking page is about 130 kB of site around the inline script that holds the nonce.
export const PROSHIPS_PAGE_MAX_BYTES = 1_000_000;
// A long history is a few kilobytes of HTML inside the JSON reply.
export const PROSHIPS_MAX_BYTES = 256 * 1024;

// ProShips delivers parcels under the numbers their senders gave them (S10,
// MailAmericas, SHEIN), so the adapter takes any letters and digits with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z\d]{8,40}$/;
// The nonce the page's own script sends with the lookup.
const NONCE = /formData\.append\(\s*'nonce'\s*,\s*'([0-9a-f]{10})'\s*\)/g;
const ACTION = /formData\.append\(\s*'action'\s*,\s*'get_tracking_info'\s*\)/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied)|_cf_chl_opt|cf-turnstile|challenge-platform/i;
// "22-08-2026 12:26"
const CLOCK = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/;
const NOT_FOUND = /^No se encontraron paquetes para el código:\s*(\S{1,64})$/;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A number for ProShips' tracker: eight to forty letters and digits, at least one a digit. */
export function normalizeProshipsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ProShips tracks eight to forty letters and digits');
  return number;
}

/** Whether a number the reply names is the number asked; the tracker echoes it as it was sent. */
function sameNumber(value: string, number: string): boolean {
  return value.length <= 64 && normalizeTrackingNumber(value) === number;
}

/**
 * The WordPress nonce the tracking page gives its lookup. A page without it
 * is a block page or a changed site.
 */
export function parseProshipsNonce(html: string): string {
  const nonces = new Set([...html.matchAll(NONCE)].map((match) => match[1]!));
  if (nonces.size === 1 && ACTION.test(html)) return [...nonces][0]!;
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ProShips answered with a block page');
  throw new SchemaError(PROVIDER, 'ProShips tracking page did not carry its lookup nonce');
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// Who received or signed for the parcel, after a delivery's wording.
const SIGNATORY = /\s*[,;:.\-–(]?\s*\b(?:recibido|recibida|firmado|firmada)\s+por\b[\s\S]*$/i;

/** A scan's wording without a signatory or phone numbers. */
export function proshipsWording(raw: string): string {
  return clean(raw.replace(SIGNATORY, '').replace(PHONE, ''), 200).replace(/^[\s,;:.\-–/]+|[\s,;:\-–/]+$/g, '');
}

/** A scan's date and minute as one wall time. The page gives no zone. */
function wallClock(text: string): string {
  const match = CLOCK.exec(text);
  // UTC only checks the calendar fields; no offset is assigned.
  const parsed = match ? DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]),
    hour: Number(match[4]), minute: Number(match[5]) }, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed?.isValid || parsed.year < 2000 || parsed.toFormat('dd-MM-yyyy HH:mm') !== text) {
    throw new SchemaError(PROVIDER, 'ProShips returned an invalid scan time');
  }
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The headline status's stage for a parcel whose journey ended or stopped. */
function headlineStage(headline: string): Stage | undefined {
  const stage = headline ? proshipsStage(headline)?.stage : undefined;
  return stage === 'delivered' || stage === 'returned' || stage === 'exception' ? stage : undefined;
}

/**
 * The reply of the tracking page's WordPress action for one number. An
 * unknown number is `{"success":false}` with a sentence that names it; a
 * found one carries the HTML the page shows: the number, the current status
 * and the scans, newest first, each a date to the minute and a wording.
 */
export function parseProships(payload: unknown, raw: string): CarrierResult {
  const number = normalizeProshipsNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean' || typeof payload.data !== 'string') {
    throw new SchemaError(PROVIDER, 'ProShips returned an invalid envelope');
  }
  if (!payload.success) {
    const missing = NOT_FOUND.exec(clean(payload.data, 200));
    if (!missing) throw new IndeterminateError(PROVIDER, 'ProShips did not complete the lookup');
    if (!sameNumber(missing[1]!, number)) throw new IndeterminateError(PROVIDER, 'ProShips answered for another number');
    throw new NotFoundError(PROVIDER);
  }

  const $ = load(payload.data);
  const containers = $('.tracking-container');
  if (containers.length !== 1) throw new SchemaError(PROVIDER, 'ProShips tracking reply changed');
  const shown = containers.find('.tracking-header h3');
  if (shown.length !== 1) throw new SchemaError(PROVIDER, 'ProShips did not name the number');
  if (!sameNumber(clean(shown.text(), 80), number)) throw new IndeterminateError(PROVIDER, 'ProShips answered for another shipment');
  const headlines = containers.find('.current-status h3');
  if (headlines.length > 1) throw new SchemaError(PROVIDER, 'ProShips tracking reply changed');
  const headline = proshipsWording(headlines.text());

  const rows = containers.find('.tracking-events .tracking-event');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'ProShips returned too many scans');
  const scans: { event: CarrierEvent; local: string }[] = [];
  const seen = new Set<string>();
  rows.each((_, node) => {
    const row = $(node);
    const date = row.find('.event-date');
    const title = row.find('.event-title');
    if (date.length !== 1 || title.length !== 1) throw new SchemaError(PROVIDER, 'ProShips scan layout changed');
    const local = wallClock(clean(date.text(), 40));
    const description = proshipsWording(title.text());
    if (!description) throw new SchemaError(PROVIDER, 'ProShips returned a scan without wording');
    // The same scan can be listed twice.
    const identity = JSON.stringify([local, description]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const stage = proshipsStage(description);
    scans.push({ local, event: { local_time: local, description, ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) } });
  });
  // Newest first; equal clocks keep the page's order, turned round when it lists the oldest first.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => right.local.localeCompare(left.local));
  const events = scans.map(({ event }) => event);

  const ended = headlineStage(headline);
  if (!events.length) {
    if (!ended) throw new NoHistoryError(PROVIDER);
    return { status: languageStageStatus(ended), current_stage: ended, current_stage_source: 'carrier_map',
      last_status_text: headline, last_update: null, summary_only: true, events: [] };
  }
  const newest = events[0]!;
  const fromHeadline = Boolean(ended && ended !== newest.stage);
  const stage = (fromHeadline ? ended : newest.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: fromHeadline ? 'carrier_map' : newest.stage_source } : {}),
    last_status_text: fromHeadline ? headline : newest.description!,
    last_update: null,
    last_update_local: scans[0]!.local,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
