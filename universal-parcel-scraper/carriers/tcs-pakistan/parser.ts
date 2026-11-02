import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { tcsCodeStage, tcsStage, tcsWordingStage } from './status.js';

export const PROVIDER = 'TCS';
// A long history is a few kilobytes.
export const TCS_MAX_BYTES = 256 * 1024;
// Consignment numbers seen are eleven, twelve or fourteen digits. The tracker
// takes the digits as typed: a leading zero names another consignment.
const NUMBER = /^\d{11,14}$/;
const ZONE = 'Asia/Karachi';
const PAKISTAN = 'PAK';
// The weekday, month, day, year and a time of day to the minute, as "Saturday Sep 12, 2026 20:48".
const CLOCK_FORMAT = 'cccc LLL d, yyyy HH:mm';
const NOT_FOUND = /^No Data Found\b/i;
// Checkpoints that name the TCS station in `recievedby`; on the others the
// field is empty or names who took the parcel.
const STATION_SCAN = /\bTCS Facility\b|\bPicked Up\b/i;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A TCS consignment number: eleven to fourteen digits. */
export function normalizeTcsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TCS consignment numbers are eleven to fourteen digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `TCS returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A list of rows, which the reply leaves null when it has none. */
function rows(data: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = data[key];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS || !value.every(isRecord)) throw new SchemaError(PROVIDER, `TCS returned an invalid ${key}`);
  return value;
}

/** Every row names the consignment asked for. */
function bind(list: Record<string, unknown>[], number: string): void {
  for (const row of list) {
    const named = text(row, 'consignmentno', 64);
    if (!/^\d+$/.test(named)) throw new SchemaError(PROVIDER, 'TCS returned a row without its consignment number');
    if (named !== number) throw new IndeterminateError(PROVIDER, 'TCS answered for another consignment');
  }
}

interface Clock { time?: string; local_time?: string; at: number }

/**
 * A wall clock to the minute without an offset. Pakistan keeps one zone
 * without daylight saving, so a consignment booked and delivered there has its
 * clocks read in Karachi time; an international one keeps its wall clocks.
 */
function clock(value: string, domestic: boolean): Clock {
  const written = value.split(/\s+/).join(' ');
  // UTC only checks the calendar fields and the weekday. Luxon rolls 24:00 over to the next day.
  const checked = DateTime.fromFormat(written, CLOCK_FORMAT, { zone: 'UTC', locale: 'en-US' });
  if (!checked.isValid || checked.toFormat(CLOCK_FORMAT, { locale: 'en-US' }) !== written) {
    throw new SchemaError(PROVIDER, 'TCS returned an invalid time');
  }
  const wall = checked.toFormat("yyyy-MM-dd'T'HH:mm");
  // Wall clocks are ordered as if read in Karachi.
  const zoned = firstOccurrence(DateTime.fromISO(wall, { zone: ZONE }));
  if (!domestic) return { local_time: wall, at: zoned.toMillis() };
  return { time: zoned.toISO({ suppressMilliseconds: true })!, at: zoned.toMillis() };
}

interface Scan { event: CarrierEvent; at: number; order: number }

/** A checkpoint: TCS's wording, the station for a facility or pickup scan, and the clock. */
function readCheckpoint(row: Record<string, unknown>, order: number, domestic: boolean): Scan {
  const description = text(row, 'status');
  if (!description) throw new SchemaError(PROVIDER, 'TCS returned a checkpoint without wording');
  const when = clock(text(row, 'datetime', 64), domestic);
  const station = STATION_SCAN.test(description) ? text(row, 'recievedby', 120) : '';
  const staged = tcsStage('', description);
  const event: CarrierEvent = {
    ...(when.time ? { time: when.time } : { local_time: when.local_time! }),
    description,
    ...(station ? { location: station } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { event, at: when.at, order };
}

/**
 * The summary's own status line, as "Your shipment is in Transit". Its other
 * lines greet, give TCS's contact numbers or name who signed for the parcel.
 */
function summaryStatus(summary: string): string {
  for (const line of summary.split(/\n/)) {
    const status = /^\s*(your shipment is [^,\n]+)/i.exec(line)?.[1];
    if (status) return clean(status, 120);
  }
  return '';
}

/** The delivery date the summary promises before the delivery round, as "Expected Delivery Date : 12-APR-25 …". */
function expectedDate(summary: string): string | null {
  const match = /^\s*Expected Delivery Date\s*:\s*(\d{2})-([A-Z]{3})-(\d{2})\b/im.exec(summary);
  if (!match) return null;
  const [, day, month, year] = match;
  const date = DateTime.fromFormat(`${day}-${month![0]}${month!.slice(1).toLowerCase()}-${year}`, 'dd-LLL-yy', { zone: 'UTC', locale: 'en-US' });
  return date.isValid ? date.toISODate() : null;
}

/** The envelope the site's bridge wraps TCS's tracking reply in. */
function responseData(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || typeof payload.isSuccess !== 'boolean' || !isRecord(payload.responseData)) {
    throw new SchemaError(PROVIDER, 'TCS returned an invalid envelope');
  }
  const data = payload.responseData;
  if (!payload.isSuccess) {
    // The bridge relays the tracking service's refusal with its status.
    if (data.status === 429) throw new RateLimitedError(PROVIDER, undefined, 'TCS refused the lookup as too frequent');
    if (typeof data.status === 'number' && data.status >= 500) throw new IndeterminateError(PROVIDER, 'TCS could not complete the lookup');
    throw new SchemaError(PROVIDER, 'TCS refused the lookup');
  }
  // The page shows nothing for a reply without this word.
  if (data.message !== 'SUCCESS') throw new IndeterminateError(PROVIDER, 'TCS did not complete the lookup');
  return data;
}

/**
 * The reply of the bridge `www.tcsexpress.com/apibridge` relays from TCS's
 * `trackapinew` for one consignment: its booking details, its delivery
 * records newest first and its checkpoints newest first. A consignment TCS
 * does not know is answered with empty lists and "No Data Found/Invalid CN".
 * Names, the signatory and the merchant's reference are not read.
 */
export function parseTcs(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTcsNumber(raw);
  const data = responseData(payload);
  // Kept as lines: the summary puts each statement on its own.
  const summary = data.shipmentsummary ?? '';
  if (typeof summary !== 'string') throw new SchemaError(PROVIDER, 'TCS returned an invalid summary');
  const shipments = rows(data, 'shipmentinfo');
  const deliveries = rows(data, 'deliveryinfo');
  const checkpoints = rows(data, 'checkpoints');
  if (!shipments.length) {
    if (!deliveries.length && !checkpoints.length && NOT_FOUND.test(summary.trim())) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'TCS returned a reply without its booking details');
  }
  bind(shipments, number);
  bind(deliveries, number);
  bind(checkpoints, number);
  const booking = shipments[0]!;
  const domestic = text(booking, 'origincountry', 8).toUpperCase() === PAKISTAN && text(booking, 'destinationcountry', 8).toUpperCase() === PAKISTAN;

  // The newest delivery record, which the page shows as the current status.
  const record = deliveries[0];
  const recordCode = record ? text(record, 'code', 16).toUpperCase() : '';
  const recordWording = record ? text(record, 'status') : '';
  if (record && !recordWording) throw new SchemaError(PROVIDER, 'TCS returned a delivery record without wording');
  const recordStage = record ? (recordCode ? tcsCodeStage(recordCode) : undefined) ?? tcsWordingStage(recordWording) : undefined;
  const recordClock = record ? clock(text(record, 'datetime', 64), domestic) : undefined;

  const seen = new Set<string>();
  // Newest first; equal clocks keep the reply's order, which is newest first.
  const events = checkpoints.map((row, order) => readCheckpoint(row, order, domestic))
    .filter(({ event }) => {
      const identity = JSON.stringify([event.time ?? event.local_time, event.description, event.location]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    }).sort((a, b) => b.at - a.at || a.order - b.order).map(({ event }) => event);

  const delivered = recordStage === 'delivered';
  const expected = delivered ? null : expectedDate(summary);
  if (!events.length) {
    const status = recordWording || summaryStatus(summary);
    if (!status) throw new NoHistoryError(PROVIDER);
    const staged = tcsStage(recordCode, status);
    return {
      status: staged ? languageStageStatus(staged.stage) : 'unknown',
      ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
      last_status_text: status,
      ...(recordCode ? { provider_code: recordCode } : {}),
      ...(recordClock?.time ? { last_update: recordClock.time } : { last_update: null }),
      ...(recordClock?.local_time ? { last_update_local: recordClock.local_time } : {}),
      expected_delivery: expected,
      ...(delivered && recordClock?.time ? { delivered_at: recordClock.time } : {}),
      summary_only: true,
      events: [],
    };
  }

  const newest = events[0]!;
  // A delivery record stands over a checkpoint logged after it.
  const final = delivered ? events.find((event) => event.stage === 'delivered') : undefined;
  const current = delivered ? final : events.find((event) => event.stage);
  const stage = (delivered ? 'delivered' : current?.stage) as Stage | undefined;
  const source = current?.stage_source ?? 'carrier_map';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: final?.description ?? (delivered ? recordWording : newest.description!),
    ...(newest.time ? { last_update: newest.time } : { last_update: null, last_update_local: newest.local_time }),
    expected_delivery: expected,
    ...(delivered && recordClock?.time ? { delivered_at: recordClock.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
