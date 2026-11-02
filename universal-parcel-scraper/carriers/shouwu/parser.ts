import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { shouwuStage, shouwuStatusLabel, shouwuStatusStage } from './status.js';
import { withoutCountryCode } from './place.js';

export const PROVIDER = 'Shouwu International';
// One parcel's reply is a few kilobytes.
export const SHOUWU_MAX_BYTES = 256 * 1024;

// SWECN, twelve digits and YQ: the waybills the tracker answers.
const NUMBER = /^SWECN\d{12}YQ$/;
const STATUS = /^[A-Z][A-Z0-9_]{0,63}$/;
const COUNTRY = /^[A-Z]{2}$/;
// Epoch seconds. The page reads the first ten digits, so milliseconds read as the same second.
const EPOCH = /^\d{10}(?:\d{3})?$/;
// The zone Shouwu's back office reads every scan's wall clock in.
const BACK_OFFICE = 'Asia/Shanghai';
// A facility's or a town's name. Anything with a digit, as a postcode, a street number or a phone number has, is dropped.
const PLACE = /^\p{L}[\p{L}\p{M} .,'’()&/-]{0,59}$/u;
const MAX_ENTRIES = 20;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
/**
 * The stages each status covers without naming them, as the page explains
 * the status: a newest scan staged one of them refines it. Shouwu's four
 * statuses name no handover, customs, delivery round, pickup point or return.
 */
const REFINES: Partial<Record<Stage, ReadonlySet<string>>> = {
  registered: new Set(['accepted']),
  in_transit: new Set(['accepted', 'customs', 'out_for_delivery', 'failed_attempt', 'ready_for_pickup', 'returned', 'exception']),
  failed_attempt: new Set(['ready_for_pickup', 'returned', 'exception']),
};

/** A Shouwu waybill in capitals; anything else is not one Shouwu issues. */
export function normalizeShouwuNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shouwu International waybills are SWECN, twelve digits and YQ');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Shouwu returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * A scan's wall clock, from epoch seconds as a number or digits. Shouwu's
 * back office reads each scan's wall clock on Beijing time, a scan abroad's
 * too, so the epoch shows the scan's own wall clock in Beijing. The page
 * shows no time for an empty or zero value, and neither is read as one.
 */
function scanClock(row: Record<string, unknown>): { seconds: number; wall: string } | null {
  const value = row.traceTime;
  if (value === null || value === undefined || value === '' || value === 0) return null;
  const digits = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  const seconds = EPOCH.test(digits) ? Number(digits.slice(0, 10)) : 0;
  if (seconds <= 0) throw new SchemaError(PROVIDER, 'Shouwu returned an invalid scan time');
  return { seconds, wall: DateTime.fromSeconds(seconds, { zone: BACK_OFFICE }).toFormat("yyyy-MM-dd'T'HH:mm:ss") };
}

/** The facility or town a scan names, at most; anything that could be an address is dropped. */
function place(row: Record<string, unknown>): string {
  const name = withoutCountryCode(text(row, 'traceLocation', 120));
  return PLACE.test(name) ? name : '';
}

interface Parcel {
  status: string;
  country: string;
  events: CarrierEvent[];
  /** The newest scan's epoch seconds, or -Infinity without a scan. */
  newest: number;
}

/** One entry of the reply: its status, its destination and its scans, newest first, without rows that have no wording or time or repeat one. */
function readParcel(entry: Record<string, unknown>, order: Record<string, unknown>): Parcel {
  const status = text(order, 'traceStatus', 64);
  if (status && !STATUS.test(status)) throw new SchemaError(PROVIDER, 'Shouwu returned an invalid status');
  const country = text(order, 'countryCodeTwo', 8).toUpperCase();
  const rows = entry.traces ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Shouwu returned a parcel with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Shouwu returned an oversized history');
  const seen = new Set<string>();
  const scans: { event: CarrierEvent; timestamp: number }[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Shouwu returned an invalid scan');
    const clock = scanClock(row);
    const description = text(row, 'traceDesc');
    const location = place(row);
    // A row without wording or a time places nothing.
    if (!clock || !description) continue;
    const key = JSON.stringify([clock.seconds, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = shouwuStage(description);
    scans.push({ timestamp: clock.seconds, event: {
      local_time: clock.wall,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  // Newest first; equal instants keep the reply's order, which lists the newest first.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((left, right) => right.timestamp - left.timestamp);
  return { status, country: COUNTRY.test(country) ? country : '', events: scans.map((scan) => scan.event), newest: scans[0]?.timestamp ?? -Infinity };
}

/**
 * The reply of the tracking page's `getOrderTrace` lookup:
 * `{"result":{"code":0},"data":[…]}` with one entry per parcel it has under
 * the numbers asked, and none for a number it does not have. Another code
 * is a failed lookup. An entry is `order`, with the number in `orderNo`, the
 * status code in `traceStatus` and the destination in `countryCodeTwo`, and
 * `traces`, each with epoch seconds in `traceTime`, wording in `traceDesc`
 * and a place in `traceLocation`. A scan keeps the wall clock its epoch shows
 * in Beijing, for its place to date. Only entries naming the whole number asked
 * are read, and of them only those fields.
 */
export function parseShouwu(payload: unknown, raw: string): CarrierResult {
  const number = normalizeShouwuNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.result)) throw new SchemaError(PROVIDER, 'Shouwu returned an invalid reply');
  const outcome = payload.result.code;
  if (typeof outcome !== 'number' || !Number.isInteger(outcome)) throw new SchemaError(PROVIDER, 'Shouwu returned an invalid reply');
  // A failure, such as a request the tracker could not read, has another code and no data.
  if (outcome !== 0) throw new IndeterminateError(PROVIDER, 'Shouwu’s tracker did not complete the lookup');
  const entries = payload.data;
  if (!Array.isArray(entries)) throw new SchemaError(PROVIDER, 'Shouwu returned a reply without its parcels');
  if (entries.length > MAX_ENTRIES) throw new SchemaError(PROVIDER, 'Shouwu returned an oversized reply');

  let found: Parcel | undefined;
  let others = 0;
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.order) || typeof entry.order.orderNo !== 'string') {
      throw new SchemaError(PROVIDER, 'Shouwu returned an invalid parcel');
    }
    if (normalizeTrackingNumber(entry.order.orderNo) !== number) {
      others += 1;
      continue;
    }
    // The page lists every entry under a number; the one with the newest scan is the parcel.
    const parcel = readParcel(entry, entry.order);
    if (!found || parcel.newest > found.newest) found = parcel;
  }
  if (!found) {
    if (others) throw new IndeterminateError(PROVIDER, 'Shouwu answered for another number');
    // The page reads a number missing from the reply as not found.
    throw new NotFoundError(PROVIDER, 'Shouwu International has no parcel under this number');
  }

  const { status: code, country, events } = found;
  const summary = code ? shouwuStatusStage(code) : undefined;
  // A record of the booking logged after the parcel moved is no step back.
  const scanned = events.find((event) => event.stage && event.stage !== 'registered') ?? events.find((event) => event.stage);
  // The tracker's status decides, as on the page; a scan refines it within what the status covers, and
  // a status the map does not know leaves the newest staged scan.
  // In Transit on the order data alone rests on the row Shouwu writes two hours after it, before
  // anyone has the parcel, so the order data's stage stands.
  const ordered = summary === 'in_transit' && events.every((event) => event.stage === 'registered');
  const refined = summary && scanned && (ordered || REFINES[summary]?.has(scanned.stage!)) ? scanned : undefined;
  const stage = (refined?.stage ?? summary ?? scanned?.stage) as Stage | undefined;
  const source = refined?.stage_source ?? (summary ? 'carrier_map' : scanned?.stage_source);
  const destination = country ? { destination_country: country } : {};
  if (!events.length) {
    if (!summary) throw new NoHistoryError(PROVIDER);
    // A parcel can have its status before its first scan.
    return {
      status: languageStageStatus(summary),
      current_stage: summary,
      current_stage_source: 'carrier_map',
      provider_code: code,
      last_status_text: shouwuStatusLabel(code) ?? null,
      last_update: null,
      expected_delivery: null,
      ...destination,
      summary_only: true,
      events: [],
    };
  }
  const newest = events[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...destination,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
