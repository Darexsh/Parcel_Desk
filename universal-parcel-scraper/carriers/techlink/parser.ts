import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { techlinkStage } from './status.js';

export const PROVIDER = 'Techlink';
// A reply is a few kilobytes.
export const TECHLINK_MAX_BYTES = 256 * 1024;

// ZHPHD, the date as six digits, six more digits and ML.
const NUMBER = /^ZHPHD\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{6}ML$/;
// The delivering carrier's number.
const PARTNER_NUMBER = /^(?=.*\d)[A-Z0-9]{4,40}$/;
// "2029-12-14 18:35:22", the scan's wall clock.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const COUNTRY = /^[A-Z]{2}$/;
// The entry's word for an order the tracker does not have.
const NO_ORDER = '无订单信息';
const BEIJING = 'Asia/Shanghai';
const MAX_ENTRIES = 50;
const MAX_SCANS = 200;
const countries = new Intl.DisplayNames(['en'], { type: 'region' });

/** A Techlink waybill, in capitals; anything else is not one Techlink issues. */
export function normalizeTechlinkNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Techlink waybills are ZHPHD, twelve digits starting with a date, and ML');
  return number;
}

/** An optional text field; anything but a string or null is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Techlink returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's clock as an ISO wall time, to the second; the day and time must exist. */
function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const date = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!date || Number(match![4]) > 23 || Number(match![5]) > 59 || Number(match![6]) > 59) {
    throw new SchemaError(PROVIDER, 'Techlink returned an invalid scan time');
  }
  return `${date}T${match![4]}:${match![5]}:${match![6]}`;
}

/** A country code as its English name; anything else as given. */
function place(location: string): string {
  return COUNTRY.test(location) ? countries.of(location) ?? location : location;
}

/**
 * One scan. Techlink's own records are on Beijing's clock: the order's
 * electronic information, which has no place, and the scans at its warehouse
 * in China. A scan anywhere else keeps its wall clock.
 */
function scan(row: unknown, number: string): CarrierEvent {
  if (!isRecord(row) || typeof row.order_num !== 'string') throw new SchemaError(PROVIDER, 'Techlink returned an invalid scan');
  // Every scan names the shipment it belongs to.
  if (normalizeTrackingNumber(row.order_num) !== number) throw new IndeterminateError(PROVIDER, 'Techlink answered for another shipment');
  const code = text(row, 'track_sub_code', 64) || text(row, 'track_code', 64);
  if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'Techlink returned an invalid scan code');
  const description = text(row, 'description', 1000) || text(row, 'track_name', 1000);
  if (!description) throw new SchemaError(PROVIDER, 'Techlink returned a scan without its wording');
  const local = wallClock(text(row, 'actual_time', 40) || text(row, 'create_date', 40));
  const location = text(row, 'location', 120);
  const own = location === 'CN' || (!location && text(row, 'track_code', 64) === 'InfoReceived');
  const time = own ? isoTime(local, BEIJING)?.iso : null;
  const staged = techlinkStage(code, description);
  return {
    ...(time ? { time } : { local_time: local }),
    description,
    ...(location ? { location: place(location) } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The reply of `POST /api/trackinfo/` for one number:
 * `{"data":[{order_num, track_list, new_track, msg}],"msg":"success","code":200}`,
 * one entry per number asked, its scans newest first in `track_list` and the
 * newest again in `new_track`. An order the tracker does not have has no scans
 * and the entry's `msg` says so; an order it has before its first scan has
 * none and `success`. Every scan must name the whole number asked.
 */
export function parseTechlink(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTechlinkNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'Techlink returned an invalid envelope');
  if (payload.code !== 200) throw new IndeterminateError(PROVIDER, 'Techlink did not complete the lookup');
  if (!Array.isArray(payload.data) || payload.data.length > MAX_ENTRIES) throw new SchemaError(PROVIDER, 'Techlink returned an invalid result');
  const mine = payload.data.filter((entry) => isRecord(entry) && typeof entry.order_num === 'string'
    && normalizeTrackingNumber(entry.order_num) === number) as Record<string, unknown>[];
  if (!mine.length) throw new IndeterminateError(PROVIDER, 'Techlink answered for another number');
  if (mine.length > 1) throw new IndeterminateError(PROVIDER, 'Techlink returned several results for the number');
  const entry = mine[0]!;
  if (!Array.isArray(entry.track_list) || entry.track_list.length > MAX_SCANS) {
    throw new SchemaError(PROVIDER, 'Techlink returned a shipment with invalid scans');
  }
  const message = text(entry, 'msg', 200);
  if (!entry.track_list.length) {
    if (message === NO_ORDER) throw new NotFoundError(PROVIDER);
    if (message === 'success') throw new NoHistoryError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Techlink returned an unexpected answer');
  }

  const rows = entry.track_list as Record<string, unknown>[];
  const read = rows.map((row) => scan(row, number));
  // Newest first, as the tracker lists them; an oldest-first reply is turned round.
  const wall = (index: number) => text(rows[index]!, 'actual_time', 40) || text(rows[index]!, 'create_date', 40);
  const events = wall(0) < wall(rows.length - 1) ? read.reverse() : read;
  const destination = text(rows[0]!, 'receive_country', 8);
  const partners = new Set(rows.map((row) => normalizeTrackingNumber(text(row, 'lm_track_num', 200))).filter((partner) => partner && partner !== number));
  const [partner] = partners;
  const newest = events[0]!;
  const scanned = events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(COUNTRY.test(destination) ? { destination_country: destination } : {}),
    // The delivering carrier's number, when the scans carry one; the reply does not name the carrier.
    ...(partners.size === 1 && PARTNER_NUMBER.test(partner!) ? { delivery_tracking_number: partner! } : {}),
    events,
  };
}
