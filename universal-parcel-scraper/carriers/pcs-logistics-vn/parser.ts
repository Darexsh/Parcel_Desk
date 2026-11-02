import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, firstOccurrence } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { pcsStage } from './status.js';

export const PROVIDER = 'PCS Logistics';
/** The lookup the tracker page on pcs-logistics.com makes for the numbers typed in. */
export const PCS_API = 'https://apiv2.pcs.vn/api/shipment-customer/track-trace-public';
// A long history is a few kilobytes.
export const PCS_MAX_BYTES = 256 * 1024;

// The tracker takes up to 25 numbers, one per line. The adapter sends one
// number of eight to forty letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z\d]{8,40}$/;
const ZONE = 'Asia/Ho_Chi_Minh';
// A scan's clock, day first, to the second: "15/06/2026 10:49:01".
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2})$/;
// The clock a scan's time is on, as the page shows it under the time.
const VIETNAM_TIME = /^VIETNAM Time$/i;
const MAX_RESULTS = 25;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A number for PCS's tracker, in capitals; anything else is not one it issues. */
export function normalizePcsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'PCS numbers are eight to forty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `PCS returned an invalid ${key}`);
  return clean(value.normalize('NFC'), maxLength);
}

/** The country after the last comma of a place: "HA NOI, VIETNAM". */
function placeCountry(place: string): string | null {
  const country = /,\s*([^,]+)$/.exec(place)?.[1];
  return country ? countryCode(country) : null;
}

/** The wall clock of `STRDETTIME`, in ISO form; anything else is a changed reply. */
function wallClock(value: string): string {
  const parts = CLOCK.exec(value);
  const wall = parts ? `${parts[3]}-${parts[2]}-${parts[1]}T${parts[4]}` : '';
  // Parsing in UTC checks the calendar digits only. Luxon rolls 24:00:00 over to the next day.
  const checked = DateTime.fromISO(wall, { zone: 'UTC' });
  if (!parts || !checked.isValid || checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'PCS returned an invalid scan time');
  }
  return wall;
}

function projectRow(row: unknown, number: string): { key: string; wall: string; event: CarrierEvent } {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PCS returned an invalid scan');
  const hawb = text(row, 'HAWB', 64);
  if (hawb && normalizeTrackingNumber(hawb).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'PCS answered with another number’s scan');
  const wall = wallClock(text(row, 'STRDETTIME', 32));
  const location = text(row, 'LOCATION', 120);
  const description = text(row, 'STATUS_VN', 200);
  if (![undefined, null].includes(row.STATUS_ID as null) && !['string', 'number'].includes(typeof row.STATUS_ID)) {
    throw new SchemaError(PROVIDER, 'PCS returned an invalid STATUS_ID');
  }
  const code = cleanScalar(row.STATUS_ID, 16);
  // A scan the page labels with Vietnam's clock, at a place in Vietnam, is an
  // instant there; Vietnam keeps one offset all year. Any other scan keeps its wall clock.
  const domestic = VIETNAM_TIME.test(text(row, 'TIME_LOCATION', 40)) && placeCountry(location) === 'VN';
  const clock = domestic
    ? { time: firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })).toISO({ suppressMilliseconds: true })! }
    : { local_time: wall };
  const staged = pcsStage(code, description);
  // The page shows a scan without wording too, with its time and place; it has no stage.
  const event: CarrierEvent = {
    ...clock,
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  return { key: JSON.stringify([wall, location, code, description]), wall, event };
}

/**
 * The reply of `track-trace-public` for one number: `Result` holds one entry
 * per number the tracker knows, each with `shipmentInfo` and its
 * `shipmentStatuses`, newest first. A number it does not know has no entry,
 * which the page reports as not found. The entry must name the whole number as
 * its waybill (`HAWB_NO`); the page also finds a parcel by its reference
 * (`DATA_CODE`), which says nothing about whose waybill the number is. The
 * recipient, reference, weight, pieces, origin and the scans' comments are
 * never read.
 */
export function parsePcs(payload: unknown, raw: string): CarrierResult {
  const number = normalizePcsNumber(raw);
  if (!isRecord(payload) || typeof payload.StatusCode !== 'number') throw new SchemaError(PROVIDER, 'PCS returned an invalid envelope');
  // The service's own failure names its status and message, without results.
  if (payload.StatusCode !== 200) throw new IndeterminateError(PROVIDER, 'PCS did not complete the lookup');
  if (!Array.isArray(payload.Result)) throw new SchemaError(PROVIDER, 'PCS returned an invalid envelope');
  const results = payload.Result as unknown[];
  if (results.length > MAX_RESULTS) throw new SchemaError(PROVIDER, 'PCS returned invalid results');
  const infos = results.map((result) => {
    const info = isRecord(result) ? result.shipmentInfo : undefined;
    if (!isRecord(result) || !isRecord(info) || typeof info.HAWB_NO !== 'string') throw new SchemaError(PROVIDER, 'PCS returned a result without its number');
    return { result, info };
  });
  if (!infos.length) throw new NotFoundError(PROVIDER);
  const own = infos.filter(({ info }) => {
    const waybill = info.HAWB_NO as string;
    return waybill.length <= 64 && normalizeTrackingNumber(waybill).toUpperCase() === number;
  });
  if (own.length !== 1) throw new IndeterminateError(PROVIDER, own.length ? 'PCS answered with several shipments for the number' : 'PCS answered for another number');
  const { result, info } = own[0]!;
  const rows = result.shipmentStatuses ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'PCS returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'PCS returned an oversized history');

  const seen = new Set<string>();
  const scans: ReturnType<typeof projectRow>[] = [];
  for (const row of rows) {
    const scan = projectRow(row, number);
    // The tracker can list one scan twice.
    if (seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // The reply lists the scans newest first, as the result does.
  if (scans[0]!.wall < scans.at(-1)!.wall) scans.reverse();
  const events = scans.map(({ event }) => event);

  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const service = text(info, 'TOS', 80);
  const country = placeCountry(text(info, 'RECEIVER_LOCATION', 120));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: events.find((event) => event.description)?.description ?? null,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    ...(service ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
