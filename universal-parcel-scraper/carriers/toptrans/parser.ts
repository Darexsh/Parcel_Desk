import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, MaintenanceError, NoHistoryError, NotFoundError, SchemaError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { toptransStage } from './status.js';

export const PROVIDER = 'TOPTRANS';
// A long history is about ten kilobytes, most of it the page's style sheet.
export const TOPTRANS_MAX_BYTES = 512 * 1024;

// Czech and Slovak depots keep the same clocks.
const ZONE = 'Europe/Prague';
// A shipment number is eleven digits. Its pieces are numbered with thirteen
// digits, and some with ten.
const SHIPMENT = /^\d{11}$/;
const PIECE = /^(?:\d{10}|\d{13})$/;
const DIGITS = /^\d{6,20}$/;
// "08.07.26 16:56 - Zásilka doručena": the depot's wall clock, then the status.
const SCAN = /^(\d{2})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}) - (\S.*)$/;
// "815 - Trenčín": the depot's number, then its town; " - " for a scan without one.
const DEPOT = /^(?:\d{1,4}\s*)?-\s*/;
const WEIGHT = /^(\d{1,6}(?:[.,]\d{1,3})?)$/;
// The page's labels, in the Czech it always answers in.
const SHIPMENT_LABEL = 'Číslo př.listu';
const FIRST_PIECE = 'Číslo kusů od';
const LAST_PIECE = 'Číslo kusů do';
const PIECES = 'Kusů';
const WEIGHT_LABEL = 'Hmotnost kg';
const STATUS_LABEL = 'Stav zásilky';
const NOT_FOUND = 'Zásilka nenalezena';
const HISTORY_HEADER = ['Depo', 'Čas - Status'];
// Bot checks a firewall or CDN could put in place of the page: F5's rejection
// notice, Cloudflare's interstitials and CAPTCHA widgets.
const CHALLENGE = /The requested URL was rejected|Request Rejected|<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;
// TOPTRANS's notice that its APIS system is down.
const OUTAGE = /problém se systémem APIS/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 200;

export interface ToptransNumber {
  number: string;
  kind: 'shipment' | 'piece';
}

/** A shipment or piece number; anything else is not a number TOPTRANS issues. */
export function normalizeToptransNumber(raw: string): ToptransNumber {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (SHIPMENT.test(number)) return { number, kind: 'shipment' };
  if (PIECE.test(number)) return { number, kind: 'piece' };
  throw new InvalidInputError(PROVIDER, 'TOPTRANS numbers are an eleven-digit shipment number or a piece number');
}

interface Row {
  event: CarrierEvent;
  timestamp: number;
  index: number;
}

interface Page {
  fields: Map<string, string>;
  rows: Row[];
  absent: boolean;
}

/** A scan's wall clock read in Prague, or null when the digits are not a calendar time. */
function instantOf(day: string, month: string, year: string, hour: string, minute: string): DateTime | null {
  const wall = firstOccurrence(DateTime.fromObject({ year: 2000 + Number(year), month: Number(month), day: Number(day), hour: Number(hour),
    minute: Number(minute) }, { zone: ZONE }));
  return wall.isValid ? wall : null;
}

function rowOf(depot: string, scan: string, index: number): Row {
  const match = SCAN.exec(scan);
  const at = match ? instantOf(match[1]!, match[2]!, match[3]!, match[4]!, match[5]!) : null;
  if (!match || !at) throw new SchemaError(PROVIDER, 'TOPTRANS returned an invalid scan');
  const description = clean(match[6], 300);
  const location = clean(depot.replace(DEPOT, ''), 120).replace(/^-$/, '');
  const staged = toptransStage(description);
  return {
    index,
    timestamp: at.toMillis(),
    event: {
      time: at.toISO({ suppressMilliseconds: true })!,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

/**
 * The page's one table: label and value rows for the shipment, then its
 * history under a "Depo" and "Čas - Status" header, oldest first. An unknown
 * number gets the table with only its not-found heading.
 */
function pageOf($: CheerioAPI, html: string): Page {
  const tables = $('table.default-table');
  if (tables.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TOPTRANS answered with a browser check');
    if (OUTAGE.test(html.slice(0, 64_000))) throw new MaintenanceError(PROVIDER, 'TOPTRANS says its tracking system is down');
    throw new SchemaError(PROVIDER, 'TOPTRANS did not return its tracking page');
  }
  const fields = new Map<string, string>();
  const rows: Row[] = [];
  let absent = false;
  let history = false;
  tables.find('tr').each((_, tr) => {
    const headings = $(tr).children('th').toArray().map(th => clean($(th).text(), 80));
    const cells = $(tr).children('td').toArray().map(td => clean($(td).text(), 300));
    if (history) {
      if (headings.length || cells.length !== 2) throw new SchemaError(PROVIDER, 'TOPTRANS returned a scan without its fields');
      if (rows.length >= MAX_ROWS) throw new SchemaError(PROVIDER, 'TOPTRANS returned too many scans');
      rows.push(rowOf(cells[0]!, cells[1]!, rows.length));
    } else if (headings.length === 2 && headings[0] === HISTORY_HEADER[0] && headings[1] === HISTORY_HEADER[1] && !cells.length) {
      history = true;
    } else if (headings.length === 1 && cells.length === 1) {
      if (fields.has(headings[0]!)) throw new SchemaError(PROVIDER, 'TOPTRANS returned a field twice');
      fields.set(headings[0]!, cells[0]!);
    } else if (headings.length === 1 && !cells.length && headings[0] === NOT_FOUND) {
      absent = true;
    }
  });
  return { fields, rows, absent };
}

/** Whether the shipment's range of piece numbers holds the piece asked for. */
function holdsPiece(fields: Map<string, string>, piece: string): boolean {
  const first = fields.get(FIRST_PIECE) ?? '';
  const last = fields.get(LAST_PIECE) ?? '';
  if (first.length !== piece.length || last.length !== piece.length || !DIGITS.test(first) || !DIGITS.test(last)) return false;
  if (piece === first || piece === last) return true;
  // Pieces are numbered in a run; the run spans no more numbers than the shipment has pieces.
  const pieces = Number(fields.get(PIECES));
  const [low, high, value] = [Number(first), Number(last), Number(piece)];
  return Number.isInteger(pieces) && pieces > 0 && high - low + 1 <= pieces && low < value && value < high;
}

/** The shipment's weight in kilograms. */
function weightOf(fields: Map<string, string>): number | undefined {
  const match = WEIGHT.exec(fields.get(WEIGHT_LABEL) ?? '');
  const weight = match ? Number(match[1]!.replace(',', '.')) : Number.NaN;
  return Number.isFinite(weight) && weight > 0 ? weight : undefined;
}

/**
 * The page TOPTRANS's tracking service on apis.toptrans.cz renders for one
 * shipment or piece number. The shipment number must be the one asked, or its
 * range of piece numbers must hold the piece asked. The pickup and delivery
 * drivers, the driver's text message, who took the shipment, the sender's
 * reference, the note and the cash on delivery are never read.
 */
export function parseToptrans(html: string, raw: string): CarrierResult {
  const { number, kind } = normalizeToptransNumber(raw);
  const { fields, rows, absent } = pageOf(load(html), html);
  if (!fields.size && !rows.length) {
    if (absent) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'TOPTRANS returned an empty tracking page');
  }
  if (absent) throw new SchemaError(PROVIDER, 'TOPTRANS returned a shipment under its not-found notice');
  const shipment = fields.get(SHIPMENT_LABEL) ?? '';
  if (!DIGITS.test(shipment)) throw new SchemaError(PROVIDER, 'TOPTRANS returned a shipment without its number');
  if (kind === 'shipment' ? shipment !== number : !holdsPiece(fields, number)) {
    throw new IndeterminateError(PROVIDER, 'TOPTRANS answered for another shipment');
  }

  // Newest first; scans in the same minute keep the page's order, reversed.
  rows.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const seen = new Set<string>();
  const events = rows.map(({ event }) => event).filter((event) => {
    const identity = JSON.stringify([event.time, event.description, event.location ?? null]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  // A shipment without scans still has the status the page shows over them.
  const summary = fields.get(STATUS_LABEL) ?? '';
  if (!events.length && !summary) throw new NoHistoryError(PROVIDER);
  const scanned = events.find((event) => event.stage);
  const shown = events.length ? null : toptransStage(summary);
  const stage = (scanned?.stage ?? shown?.stage) as Stage | undefined;
  const source = scanned?.stage_source ?? shown?.source;
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered')?.time : undefined;
  const weight = weightOf(fields);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source ?? 'carrier_map' } : {}),
    last_status_text: events[0]?.description ?? summary,
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    ...(kind === 'piece' ? { canonical_tracking_number: shipment } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
