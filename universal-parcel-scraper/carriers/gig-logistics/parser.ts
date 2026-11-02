import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gigLogisticsCodeWording, gigLogisticsStage } from './status.js';

export const PROVIDER = 'GIG Logistics';
// One waybill's reply is a few kilobytes.
export const GIG_LOGISTICS_MAX_BYTES = 512 * 1024;

const WAYBILL = /^\d{10}$/;
// What the tracker could take as its undocumented Alphacode.
const OTHER_REFERENCE = /^[A-Z0-9]{1,40}$/;
// A .NET clock: date, time, up to seven decimals, and an offset when one is stated.
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/;
const CODE = /^[A-Z0-9]{1,12}$/;
// A service centre's name. Digits or commas, which an address or a phone number has, are never read.
const PLACE = /^\p{L}[\p{L} .'&()/-]{0,59}$/u;
const UNKNOWN_WAYBILL = /^Invalid waybill number\b/i;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/**
 * A GIG waybill, ten digits. Another reference the tracker may take as an
 * Alphacode is left to the universal providers, without a request: its
 * layout is undocumented and the reply could not be bound to it.
 */
export function normalizeGigLogisticsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (WAYBILL.test(number)) return number;
  if (OTHER_REFERENCE.test(number)) throw new IndeterminateError(PROVIDER, 'The adapter reads GIG Logistics waybills, which are ten digits');
  throw new InvalidInputError(PROVIDER, 'GIG Logistics waybills are ten digits');
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `GIG Logistics returned an invalid ${key}`);
  return clean(value, maxLength);
}

interface Clock { local: string; order: string; instant?: { iso: string; timestamp: number } }

/** A scan's wall clock to the second, and its instant when the clock states an offset. */
function scanClock(row: Record<string, unknown>): Clock {
  const raw = text(row, 'DateTime', 40);
  const match = CLOCK.exec(raw);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00:00 over, so only a clock
  // that reads back unchanged is kept. A year before 2000 is .NET's empty date.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.year < 2000 || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'GIG Logistics returned an invalid scan time');
  }
  const instant = match[4] ? explicitOffsetTime(`${local}${match[4]}`) : null;
  // The decimals keep scans logged within one second in order.
  const order = `${local}${(match[3] ?? '.').padEnd(8, '0')}`;
  return instant ? { local, order, instant } : { local, order };
}

/** The service centre a scan names, at most; anything that could be an address is dropped. */
function place(row: Record<string, unknown>): string {
  const name = clean(text(row, 'Location', 120).replace(/_/g, ' '), 60);
  return PLACE.test(name) ? name : '';
}

/**
 * The reply of the tracking page's `api/portal/trackshipment/{waybill}`
 * lookup. A waybill it has gets `Code` "200" and its scans in
 * `Object.MobileShipmentTrackings`, each naming its waybill, with a code and
 * the code's fixed wording in `ScanStatus`. A waybill it does not have gets
 * `Code` "400" and "Invalid waybill number!!". Only scans naming the whole
 * waybill asked are read, and of them only the code, its wording, the clock
 * and the service centre: the origin and destination addresses, the incident
 * text the page shows, which can name the receiver, and the scanning staff
 * are never read.
 */
export function parseGigLogistics(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGigLogisticsNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'GIG Logistics returned an invalid reply');
  const code = cleanScalar(payload.Code, 8);
  if (code !== '200') {
    if (!code) throw new SchemaError(PROVIDER, 'GIG Logistics returned an invalid reply');
    if (code === '400' && UNKNOWN_WAYBILL.test(text(payload, 'ShortDescription', 200))) {
      throw new NotFoundError(PROVIDER, 'GIG Logistics has no shipment under this waybill');
    }
    throw new IndeterminateError(PROVIDER, 'GIG Logistics did not complete the lookup');
  }
  const shipment = payload.Object;
  if (!isRecord(shipment)) throw new SchemaError(PROVIDER, 'GIG Logistics returned an invalid reply');
  const rows = shipment.MobileShipmentTrackings ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'GIG Logistics returned a shipment with invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GIG Logistics returned an oversized history');

  const seen = new Set<string>();
  const scans: { event: CarrierEvent; clock: Clock; index: number }[] = [];
  let others = 0;
  for (const row of rows) {
    if (!isRecord(row) || typeof row.Waybill !== 'string') throw new SchemaError(PROVIDER, 'GIG Logistics returned an invalid scan');
    if (normalizeTrackingNumber(row.Waybill) !== number) {
      others += 1;
      continue;
    }
    const status = isRecord(row.ScanStatus) ? row.ScanStatus : {};
    const scanCode = (text(row, 'Status', 16) || text(status, 'Code', 16)).toUpperCase();
    if (!CODE.test(scanCode)) throw new SchemaError(PROVIDER, 'GIG Logistics returned a scan without a code');
    const clock = scanClock(row);
    const description = text(status, 'Reason') || gigLogisticsCodeWording(scanCode) || '';
    // A scan whose code has no wording says nothing readable.
    if (!description) continue;
    const location = place(row);
    const key = JSON.stringify([clock.order, scanCode, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = gigLogisticsStage(scanCode, description);
    scans.push({ clock, index: scans.length, event: {
      // A scan without an offset keeps its wall clock.
      ...(clock.instant ? { time: clock.instant.iso } : { local_time: clock.local }),
      ...(location ? { location } : {}),
      description,
      provider_code: scanCode,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!scans.length) {
    if (others) throw new IndeterminateError(PROVIDER, 'GIG Logistics answered for another waybill');
    throw new NoHistoryError(PROVIDER);
  }
  // Newest first, by instant when every scan states one, else by wall clock; equal ones in the reply's order.
  const timed = scans.every((scan) => scan.clock.instant);
  scans.sort((left, right) => (timed
    ? right.clock.instant!.timestamp - left.clock.instant!.timestamp
    : right.clock.order.localeCompare(left.clock.order)) || left.index - right.index);

  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  // A record of the booking logged after the parcel moved is no step back.
  const scanned = events.find((event) => event.stage && event.stage !== 'registered') ?? events.find((event) => event.stage);
  const stage = scanned?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && scanned?.time ? { delivered_at: scanned.time } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
