import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { ajexStage } from './status.js';

export const PROVIDER = 'AJEX';
// A long history is a few kilobytes once decrypted.
export const AJEX_MAX_BYTES = 512 * 1024;
// `AJA` or `AJS` and twelve digits, or `A` and ten digits for the newer system.
const NUMBER = /^(?:AJ[AS]\d{12}|A\d{10})$/;
// The service's own words for a number it does not know and for a shape it refuses.
const NOT_FOUND = /^waybill number does not exist$/i;
const INVALID_FORMAT = /^invalid waybill number format$/i;
// Scan clocks are epoch milliseconds; anything outside these years is a changed reply.
const EARLIEST = Date.UTC(2000, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A number for AJEX's tracker, in upper case as the page sends it; anything else is not one it issues. */
export function normalizeAjexNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'AJEX numbers are AJA or AJS and twelve digits, or A and ten digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `AJEX returned an invalid ${key}`);
  return clean(value, maxLength);
}

// A run of nine or more digits, with spaces, brackets, dots or hyphens
// between them, as phone numbers are written.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * A scan's wording: its `status`, as the page shows it. The newer system's
 * `note` says more than its status for holds and delays ("Trip Exception:
 * Load to destination - LH-Delay"), so it follows the status unless it only
 * repeats it. A delivery's note is left out, since it could name who took the
 * parcel. The older system's notes restate the status.
 */
export function ajexWording(status: string, note: string, newer: boolean, stage?: Stage): string {
  const own = clean(status.replace(PHONE, ''));
  const extra = clean(note.replace(PHONE, '')).replace(/^[\s,;:.\-–]+|[\s,;:.\-–]+$/g, '');
  if (!newer || !extra || stage === 'delivered') return own;
  const [a, b] = [squash(own), squash(extra)];
  return a.includes(b) || b.includes(a) ? own : `${own}: ${extra}`;
}

/** A scan's instant, from its epoch milliseconds. */
function scanTime(row: Record<string, unknown>): { iso: string; millis: number } {
  const millis = row.actionTime;
  if (typeof millis !== 'number' || !Number.isSafeInteger(millis) || millis < EARLIEST || millis >= LATEST) {
    throw new SchemaError(PROVIDER, 'AJEX returned an invalid scan time');
  }
  return { iso: DateTime.fromMillis(millis, { zone: 'utc' }).toISO({ suppressMilliseconds: true })!, millis };
}

/**
 * A scan's code: the newer system's `eventCode`, else the older one's
 * `statusCode`. The newer system's status code is always 0.
 */
function scanCode(row: Record<string, unknown>): string {
  const event = cleanScalar(row.eventCode, 16).toUpperCase();
  if (event) return event;
  const status = row.statusCode;
  if (status !== null && status !== undefined && typeof status !== 'number' && typeof status !== 'string') {
    throw new SchemaError(PROVIDER, 'AJEX returned an invalid statusCode');
  }
  const code = cleanScalar(status, 16);
  return code === '0' ? '' : code;
}

interface Scan {
  readonly key: string;
  readonly millis: number;
  readonly event: CarrierEvent;
}

function projectRow(row: Record<string, unknown>): Scan | null {
  const status = text(row, 'status');
  // The page leaves out rows without a status, such as a pickup driver being assigned.
  if (!status) return null;
  const code = scanCode(row);
  const newer = /^AJ\d/.test(code);
  const note = text(row, 'note');
  const { iso, millis } = scanTime(row);
  // The page takes "AJEX" out of a city's name.
  const location = clean(text(row, 'cityName', 120).replace(/\bAJEX\b/gi, ''));
  const staged = ajexStage(code, status);
  const description = ajexWording(status, note, newer, staged?.stage);
  if (!description) throw new SchemaError(PROVIDER, 'AJEX returned a scan without wording');
  const event: CarrierEvent = {
    time: iso,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([iso, code, description, location]), millis, event };
}

/** The destination country, from the city line the page shows; the rest of the address is not read. */
function destination(shipment: Record<string, unknown>): Pick<CarrierResult, 'destination_country' | 'destination_country_name'> {
  const details = isRecord(shipment.orderTackingDetails) ? shipment.orderTackingDetails : {};
  const receiver = isRecord(details.receiverDetails) ? details.receiverDetails : {};
  const country = typeof receiver.country === 'string' ? clean(receiver.country, 60) : '';
  if (!country) return {};
  const code = countryCode(country);
  return code ? { destination_country: code } : { destination_country_name: country };
}

/**
 * The decrypted reply of `trackAjexShipments` for one number. It answers
 * `status` 200 with one shipment per number asked, oldest scan first, and
 * `status` 500 with a message otherwise. A shipment must name the number asked.
 */
export function parseAjex(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAjexNumber(raw);
  if (!isRecord(payload) || typeof payload.status !== 'number') throw new SchemaError(PROVIDER, 'AJEX returned an invalid envelope');
  const message = typeof payload.msg === 'string' ? clean(payload.msg, 200) : '';
  // The page sends a visitor home when the reply says 429.
  if (payload.status === 429) throw new RateLimitedError(PROVIDER);
  if (payload.status !== 200) {
    if (NOT_FOUND.test(message)) throw new NotFoundError(PROVIDER);
    if (INVALID_FORMAT.test(message)) throw new InvalidInputError(PROVIDER, 'AJEX\'s tracker does not take numbers of this format', { reason: 'wrong_number' });
    // The newer system's unknown numbers come without a message, and so could its failures.
    throw new IndeterminateError(PROVIDER, 'AJEX did not complete the lookup');
  }
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'AJEX returned a reply without shipments');
  if (payload.data.some((entry) => !isRecord(entry) || typeof entry.waybillNumber !== 'string')) {
    throw new SchemaError(PROVIDER, 'AJEX returned a shipment without its number');
  }
  const shipment = (payload.data as Record<string, unknown>[])
    .find((entry) => normalizeTrackingNumber(clean(entry.waybillNumber, 64)).toUpperCase() === number);
  if (!shipment) throw new IndeterminateError(PROVIDER, 'AJEX answered for another shipment');
  const rows = shipment.orderTrackingHistory ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'AJEX returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'AJEX returned an oversized history');

  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'AJEX returned an invalid scan');
    const scan = projectRow(row);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first, as the page lists them; the reply lists them oldest first.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  const events = scans.sort((a, b) => b.millis - a.millis).map((scan) => scan.event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? scanned!.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...destination(shipment),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
