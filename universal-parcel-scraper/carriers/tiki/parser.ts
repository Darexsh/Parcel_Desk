import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError,
  SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { tikiStage } from './status.js';

export const PROVIDER = 'TIKI';
// A consignment of ten pieces, each with its own history, is about fifteen kilobytes.
export const TIKI_MAX_BYTES = 512 * 1024;
// TIKI prints a twelve-digit resi; the service finds nothing for a piece suffix.
const NUMBER = /^\d{12}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z]{2,5}(?: \d{1,3})?$/;
const SERVICE = /^[A-Z0-9]{2,8}$/;
const MAX_PIECES = 200;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const FINAL: ReadonlySet<string> = new Set(['delivered', 'returned']);

/** A TIKI resi: twelve digits. Anything else is not a number TIKI issues. */
export function normalizeTikiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TIKI resi numbers are twelve digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `TIKI returned an invalid ${key}`);
  return clean(value, maxLength);
}

// A delivery or a return names who took the parcel after a colon, as
// "Success / [M] RECEIVED BY : NAME (OTHER)"; a receiver named elsewhere
// follows "RECEIVED BY" or "DITERIMA OLEH".
const HANDOVER = /^POD\b/;
const AFTER_COLON = /\s*:[\s\S]*$/;
const RECEIVER = /\b(RECEIVED BY|DITERIMA OLEH)\b[\s\S]*$/i;
// An Indonesian phone number, written with or without the country code.
const PHONE = /(?<![\dA-Z])(?:\+?62|0)[\s.-]?8(?:[\s.-]?\d){7,11}(?![\dA-Z])/gi;

/** A scan's wording without the receiver a delivery or return names, or phone numbers. */
export function tikiWording(noted: string, code = ''): string {
  const own = HANDOVER.test(code) ? noted.replace(AFTER_COLON, '') : noted;
  return clean(own.replace(RECEIVER, '$1').replace(PHONE, ''), 300).replace(/[\s,;:–-]+$/, '');
}

/** The scan's town: its own field, else the town in brackets after the office's name, else the office. */
function placeOf(row: Record<string, unknown>): string {
  const place = text(row, 'entry_place', 120);
  if (place) return place;
  const office = text(row, 'entry_name', 160);
  const town = /\[([^\]]+)\]\s*$/.exec(office)?.[1]?.trim();
  return clean(town || office.replace(/\s*\[\s*\]\s*$/, ''), 120);
}

/**
 * A scan's clock: the scanning office's wall clock to the second, without a
 * zone. Indonesia keeps three and the reply names none, so it stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const match = CLOCK.exec(text(row, 'entry_date', 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'TIKI returned an invalid scan time');
  }
  return local;
}

function scanOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'TIKI returned an invalid scan');
  const code = text(row, 'status', 20).toUpperCase();
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'TIKI returned a scan without a valid code');
  const local = scanClock(row);
  const description = tikiWording(text(row, 'noted', 600), code) || code;
  const location = placeOf(row);
  const staged = tikiStage(code, description);
  return {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

interface Piece { readonly scans: Array<{ event: CarrierEvent; order: number }>; readonly record: Record<string, unknown> }

/** Newest first by wall clock; of scans made the same second, the one the reply lists as newer. */
function newestFirst<T extends { event: CarrierEvent; order: number }>(scans: T[]): T[] {
  return scans.sort((a, b) => String(b.event.local_time).localeCompare(String(a.event.local_time)) || a.order - b.order);
}

/** One piece of the consignment, bound to the whole requested number. */
function pieceOf(value: unknown, number: string, offset: number): Piece {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'TIKI returned an invalid shipment');
  if (typeof value.cnno !== 'string') throw new SchemaError(PROVIDER, 'TIKI returned a shipment without its number');
  if (normalizeTrackingNumber(value.cnno) !== number) throw new IndeterminateError(PROVIDER, 'TIKI answered for another shipment');
  if (!Number.isInteger(value.seq_no) || (value.seq_no as number) < 0) throw new SchemaError(PROVIDER, 'TIKI returned a piece without its number');
  const rows = value.history ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'TIKI returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'TIKI returned an oversized history');
  const events = rows.map(scanOf);
  if (listsNewestFirst(events) === false) events.reverse();
  return { record: value, scans: newestFirst(events.map((event, index) => ({ event, order: offset + index }))) };
}

/** The delivery estimate, a calendar day, or nothing. */
function estimate(record: Record<string, unknown>): string | null {
  const value = text(record, 'est_date', 16);
  return DATE.test(value) && DateTime.fromISO(value, { zone: 'UTC' }).isValid ? value : null;
}

/** The consignment's weight in kilograms, which every piece repeats; nothing when they disagree or it is missing. */
function weightOf(pieces: Piece[]): number | null {
  const weights = new Set(pieces.map(piece => piece.record.weight));
  const [weight] = weights;
  return weights.size === 1 && typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight <= 100_000 ? weight : null;
}

/** The product code the tracker shows beside the number, as REG or ONS. */
function serviceOf(record: Record<string, unknown>): string {
  const product = text(record, 'product', 16).toUpperCase();
  return SERVICE.test(product) ? product : '';
}

/**
 * The scan that decides a consignment's stage. A delivery or a return of some
 * pieces leaves the others on their way, so it decides only when every piece
 * has one; until then the newest scan of a piece still travelling does.
 */
function decidingScan(pieces: Piece[]): CarrierEvent {
  const latest = pieces.map(piece => piece.scans[0]!);
  const open = latest.filter(scan => !FINAL.has(String(scan.event.stage)));
  return newestFirst(open.length ? open : latest)[0]!.event;
}

/**
 * The reply of the app's `connote/information` for one number: `status`,
 * `msg` and `response`, the list of the consignment's pieces. A consignment
 * of one piece is one entry with `seq_no` 0; one of several lists each piece
 * from 1 with its own history. Every entry must name the whole requested
 * number. An empty list is the app's "not found".
 */
export function parseTiki(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTikiNumber(raw);
  if (!isRecord(payload) || typeof payload.status !== 'number') throw new SchemaError(PROVIDER, 'TIKI returned an invalid envelope');
  if (payload.status === 403) throw new ChallengeError(PROVIDER, 'TIKI refused the app\'s token', { status: 403 });
  if (payload.status === 429) throw new RateLimitedError(PROVIDER, undefined, 'TIKI refused the lookup as too frequent', { status: 429 });
  if (payload.status !== 200) throw new IndeterminateError(PROVIDER, 'TIKI did not complete the lookup');
  const entries = payload.response;
  if (!Array.isArray(entries)) throw new SchemaError(PROVIDER, 'TIKI returned a reply without its shipment list');
  if (!entries.length) throw new NotFoundError(PROVIDER);
  if (entries.length > MAX_PIECES) throw new SchemaError(PROVIDER, 'TIKI returned too many pieces');

  let offset = 0;
  const pieces = entries.map((entry) => {
    const piece = pieceOf(entry, number, offset);
    offset += MAX_ROWS;
    return piece;
  });
  // Pieces that travel together can share a scan; it is kept once.
  const seen = new Set<string>();
  const scans: Array<{ event: CarrierEvent; order: number }> = [];
  for (const scan of pieces.flatMap(piece => piece.scans)) {
    const key = JSON.stringify([scan.event.local_time, scan.event.provider_code, scan.event.description, scan.event.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push(scan);
  }
  const started = pieces.filter(piece => piece.scans.length);
  if (!started.length) throw new NoHistoryError(PROVIDER);
  const events = newestFirst(scans).map(scan => scan.event);

  const deciding = decidingScan(started);
  const stage = deciding.stage as Stage | undefined;
  const first = pieces[0]!.record;
  const service = serviceOf(first);
  const weight = weightOf(pieces);
  const expected = stage && FINAL.has(stage) ? null : estimate(first);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: deciding.stage_source } : {}),
    last_status_text: deciding.description!,
    last_update: null,
    last_update_local: events[0]!.local_time,
    expected_delivery: expected,
    ...(service ? { service_name: service } : {}),
    ...(weight ? { weight_kg: weight } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
