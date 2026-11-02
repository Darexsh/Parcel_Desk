import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { xlcourierStage } from './status.js';

export const PROVIDER = 'XLCourier';
// A long history is a few kilobytes.
export const XLCOURIER_MAX_BYTES = 256 * 1024;
// The tracking page's own check: XLC and ten to twelve digits, or ZX and eight.
const NUMBER = /^(?:XLC\d{10,12}|ZX\d{8})$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
// The backend's message for every number it holds no shipment for.
const NOT_FOUND = /^parse tracking response failed$/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** An XLCourier number, in capitals as the page sends it; anything else is not one XLCourier issues. */
export function normalizeXlcourierNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'XLCourier numbers are XLC and ten to twelve digits, or ZX and eight digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `XLCourier returned an invalid ${key}`);
  return clean(value, maxLength);
}

// A run of nine or more digits, as phone numbers are written, and e-mail addresses.
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Free text without phone numbers or e-mail addresses. */
function scrubbed(value: string): string {
  return clean(value.replace(EMAIL, '').replace(PHONE, '').replace(/\s+([,;:.!])/g, '$1')).replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '');
}

/**
 * A scan's wording: the line the page shows under its title, else the title,
 * then the reason the page adds to a scan that did not go to plan.
 */
export function xlcourierWording(title: string, line: string, reason: string): string {
  const head = scrubbed(line) || scrubbed(title);
  const why = scrubbed(reason);
  if (!why) return head;
  if (!head) return `Reason: ${why}`;
  return `${/[.!?]$/.test(head) ? head : `${head}.`} Reason: ${why}`;
}

// The depot or hub a receiving scan names: "Your parcel has arrived safely at …".
const ARRIVED_AT = /\barrived(?:\s+safely)?\s+at\s+(?:our\s+)?(.+?)[\s.!]*$/i;

/** The depot or hub a scan's line names as the place the parcel arrived at. */
export function xlcourierLocation(line: string): string {
  const place = ARRIVED_AT.exec(scrubbed(line))?.[1] ?? '';
  return clean(place, 80);
}

/**
 * A scan's clock, `updated_at_localized`: a wall clock to the second. The
 * reply and the page name no zone, so the clock stays local.
 */
function scanClock(row: Record<string, unknown>): string {
  const wall = text(row, 'updated_at_localized', 32);
  const local = wall.replace(' ', 'T');
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!WALL_CLOCK.test(wall) || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'XLCourier returned an invalid scan time');
  }
  return local;
}

function projectRow(row: Record<string, unknown>): { key: string; event: CarrierEvent & { local_time: string } } {
  const code = cleanScalar(row.tracking_event_status_id, 16);
  const title = text(row, 'title', 120);
  const line = text(row, 'description');
  const description = xlcourierWording(title, line, text(row, 'reason'));
  if (!description) throw new SchemaError(PROVIDER, 'XLCourier returned a scan without wording');
  const local = scanClock(row);
  const location = xlcourierLocation(line);
  const staged = xlcourierStage(code, `${title}. ${line}`);
  const event = {
    local_time: local,
    ...(location ? { location } : {}),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([local, code, description, location]), event };
}

/**
 * The reply of `getLogisticsTrack/{number}`, the lookup the tracking page
 * makes: `code` "0" with the scans, oldest first, and the recipient's address,
 * which the page pins on a map and the adapter never reads. Any other code is
 * what the page reports as not found; the backend gives "parse tracking
 * response failed" for every number it holds no shipment for. The reply does
 * not echo the number: the scans are those of the whole number in the request.
 */
export function parseXlcourier(payload: unknown, raw: string): CarrierResult {
  normalizeXlcourierNumber(raw);
  if (!isRecord(payload) || !Object.hasOwn(payload, 'code')) throw new SchemaError(PROVIDER, 'XLCourier returned an invalid envelope');
  const code = cleanScalar(payload.code, 16);
  if (code !== '0') {
    if (payload.data === null && NOT_FOUND.test(text(payload, 'msg', 200))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'XLCourier did not complete the lookup');
  }
  const data = payload.data;
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'XLCourier returned a shipment without its details');
  const rows = data.events ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'XLCourier returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'XLCourier returned an oversized history');

  const seen = new Set<string>();
  const scans: { event: CarrierEvent & { local_time: string }; index: number }[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'XLCourier returned an invalid scan');
    const scan = projectRow(row);
    if (seen.has(scan.key)) return;
    seen.add(scan.key);
    scans.push({ event: scan.event, index });
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock; scans on the same clock keep the reply's order turned round.
  scans.sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index);
  const events = scans.map((scan) => scan.event);

  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
