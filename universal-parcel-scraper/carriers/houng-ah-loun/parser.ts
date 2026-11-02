import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { halStage, RETURN_STATE } from './status.js';

export const PROVIDER = 'HAL Express';
// A history of two dozen scans is about twelve kilobytes.
export const HAL_MAX_BYTES = 512 * 1024;
// The sending province's code, two to four letters, then digits: eleven in
// every bill seen. The page sends a run of digits to its phone search instead.
const NUMBER = /^[A-Z]{2,4}\d{8,14}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A HAL Express bill number in capitals; anything else is not one HAL issues. */
export function normalizeHalNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HAL Express bills are a province code and digits');
  return number;
}

/** The lookup's own answer for a bill it does not know, which it sends with HTTP 404. */
export function isHalNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.error === true && payload.data === null
    && typeof payload.message === 'string' && /no provided shipment bill number match/i.test(payload.message);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `HAL Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

// The clauses after " - " that name a branch, a branch's warehouse or a
// sorting centre, as the return scan's sending branch.
const PLACE_CLAUSE = /^(?:ສາຂາ|ສາງ|ສູນ)/;
// A staff member's title (ທ. or ທ້າວ for a man, ນ. or ນາງ for a woman) and
// everything after it: the name of whoever scanned the parcel.
const STAFF = /(?:^|[\s-])(?:ທ\.|ນ\.|ທ້າວ|ນາງ)\s[\s\S]*$/;
// "Phone" and the number after it, and any other run of eight or more digits.
const PHONE_LABEL = /ເບີໂທ[\s:]*[\d\s()+-]*/g;
const PHONE = /(?<![A-Z\d])\+?\d(?:[\s().-]{0,2}\d){7,}(?![A-Z\d])/gi;

/**
 * A scan's message without the staff member who scanned the parcel and the
 * branch phone number, which HAL Express appends after " - ".
 */
export function halWording(message: string): string {
  const [first = '', ...rest] = message.split(/\s+-\s+/);
  return [first, ...rest.filter((clause) => PLACE_CLAUSE.test(clause.trim()))]
    .map((clause) => clean(clause.replace(STAFF, '').replace(PHONE_LABEL, ' ').replace(PHONE, ' ')))
    .filter(Boolean).join(' - ');
}

/**
 * A scan's clock: the reply's `date`, to the second, with no zone. HAL works in
 * Laos, but nothing in the reply establishes the zone, so it stays a wall clock.
 */
function scanClock(row: Record<string, unknown>): string {
  const parts = CLOCK.exec(text(row, 'date', 32));
  const local = parts ? `${parts[1]}T${parts[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parts || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'HAL Express returned an invalid scan time');
  }
  return local;
}

interface Row { code: string; local: string; description: string; location: string; order: number }

function readRow(row: unknown, order: number): Row {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'HAL Express returned an invalid scan');
  const state = row.delivery_state;
  if (typeof state !== 'number' || !Number.isSafeInteger(state) || state < 0) {
    throw new SchemaError(PROVIDER, 'HAL Express returned a scan without its state');
  }
  const description = halWording(text(row, 'message', 1000)) || text(row, 'delivery_state_name', 80);
  if (!description) throw new SchemaError(PROVIDER, 'HAL Express returned a scan without wording');
  return { code: String(state), local: scanClock(row), description, location: text(row, 'place', 120), order };
}

/**
 * The reply of the tracking page's `/v1/orders/tracking/{number}`: the bill's
 * summary and its scans, oldest first. The bill must be the number asked. The
 * summary's names, phone numbers, charges and parcel details are not kept.
 */
export function parseHal(payload: unknown, raw: string): CarrierResult {
  const number = normalizeHalNumber(raw);
  if (isHalNotFound(payload)) throw new NotFoundError(PROVIDER);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'HAL Express returned an invalid envelope');
  if (payload.error === true) throw new IndeterminateError(PROVIDER, 'HAL Express did not complete the lookup');
  const info = payload.shipment_info;
  if (!isRecord(info) || typeof info.bill_number !== 'string') throw new SchemaError(PROVIDER, 'HAL Express returned a shipment without its number');
  if (clean(info.bill_number, 64).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'HAL Express answered for another shipment');
  const list = payload.tracking_events ?? [];
  if (!Array.isArray(list)) throw new SchemaError(PROVIDER, 'HAL Express returned a shipment with invalid scans');
  if (list.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'HAL Express returned an oversized history');

  // Oldest first, as the page reads them, so a return marks every scan after it.
  const rows = list.map(readRow).sort((a, b) => a.local.localeCompare(b.local) || a.order - b.order);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  let returning = false;
  for (const row of rows) {
    returning ||= row.code === RETURN_STATE;
    const key = JSON.stringify([row.local, row.code, row.description, row.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = halStage(row.code, returning);
    events.push({
      local_time: row.local,
      ...(row.location ? { location: row.location } : {}),
      description: row.description,
      provider_code: row.code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      ...(returning ? { provider_leg: 'return' } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newestFirst = events.reverse();

  const newest = newestFirst[0]!;
  const scanned = newestFirst.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
