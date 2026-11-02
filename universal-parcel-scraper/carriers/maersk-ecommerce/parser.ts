import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { maerskStage } from './status.js';

export const PROVIDER = 'Maersk eCommerce';
export const MAERSK_MAX_BYTES = 1_000_000;

// 1M, the client's seven-character code with a letter in it, then ten digits.
const NUMBER = /^1M(?=[A-Z0-9]{0,6}[A-Z])[A-Z0-9]{7}\d{10}$/;
const MAX_EVENTS = 100;
const LOCAL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;

/** The destinations Maersk eCommerce delivers to, by the ISO alpha-3 code its reply gives. */
const COUNTRIES: Readonly<Record<string, string>> = {
  USA: 'US', CAN: 'CA', AUT: 'AT', BEL: 'BE', CHE: 'CH', CZE: 'CZ', DEU: 'DE', DNK: 'DK', ESP: 'ES', FIN: 'FI',
  FRA: 'FR', GBR: 'GB', HUN: 'HU', IRL: 'IE', ITA: 'IT', LUX: 'LU', NLD: 'NL', NOR: 'NO', POL: 'PL', PRT: 'PT', SVK: 'SK', SWE: 'SE',
};

/** The last-mile carriers Maersk names, as catalog ids, by the destination for a network with one company per country. */
const PARTNERS: Readonly<Record<string, string | Readonly<Record<string, string>>>> = {
  AMAZON: 'amazon-logistics',
  ONTRAC: 'ontrac',
  DPD: { AT: 'dpd-at' },
};

/** A Maersk eCommerce parcel number; anything else is not one its tracker is asked about. */
export function normalizeMaerskNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Maersk eCommerce parcel numbers are 1M, a seven-character client code and ten digits');
  return number;
}

function text(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key];
  if (value == null) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Maersk eCommerce returned a malformed ${key}`);
  return clean(value, max);
}

/**
 * A scan's clock. Maersk states an offset for its own scans and most
 * partners'; that clock is an instant and must agree with `utcDateTime`.
 * A partner scan without one, such as DPD's, keeps its wall clock.
 */
function scanClock(row: Record<string, unknown>): Pick<CarrierEvent, 'time' | 'local_time'> {
  const local = text(row, 'localDateTime', 32);
  const offset = text(row, 'timeZoneOffset', 8);
  if (!LOCAL_CLOCK.test(local)) throw new SchemaError(PROVIDER, 'Maersk eCommerce returned an invalid scan clock');
  if (!offset) return { local_time: local };
  if (!OFFSET.test(offset)) throw new SchemaError(PROVIDER, 'Maersk eCommerce returned an invalid scan offset');
  const time = explicitOffsetTime(`${local}${offset}`);
  const utc = explicitOffsetTime(text(row, 'utcDateTime', 32));
  if (!time || (utc && utc.timestamp !== time.timestamp)) throw new SchemaError(PROVIDER, 'Maersk eCommerce returned clocks that disagree');
  return { time: time.iso };
}

/** The partner's number, when Maersk names a partner the catalog tracks and the number is one of its own. */
function handoff(payload: Record<string, unknown>, country: string | undefined): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const named = PARTNERS[text(payload, 'lastMileCarrier', 64).toUpperCase()];
  const partner = typeof named === 'string' ? named : named && country ? named[country] : undefined;
  const number = normalizeTrackingNumber(text(payload, 'trackingNumber', 64));
  if (!partner || !/^[A-Z0-9]{4,40}$/.test(number)) return {};
  return (detectCarrierMatch(number).candidates as string[]).includes(partner)
    ? { delivery_carrier: partner, delivery_tracking_number: number } : {};
}

/**
 * The reply of `GET /ecommerce/tracking/public/packages/{number}`: one parcel,
 * its scans newest first, the destination and the last-mile carrier. Only a
 * reply whose `maerskTrackingNumber` is the whole number asked is read. The
 * client's order number and code, the destination's town and postcode and the
 * partner's tracking link are never read.
 */
export function parseMaersk(payload: unknown, raw: string): CarrierResult {
  const number = normalizeMaerskNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  if (normalizeTrackingNumber(text(payload, 'maerskTrackingNumber', 64)) !== number) {
    throw new SchemaError(PROVIDER, 'Maersk eCommerce returned a different parcel');
  }
  const rows = payload.trackingEvents;
  if (!Array.isArray(rows) || rows.length > 500 || !rows.every(isRecord)) throw new SchemaError(PROVIDER);
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const code = text(row, 'maerskStatusCode', 16);
    const description = text(row, 'maerskStatusDescription', 300);
    if (!/^\d{5}$/.test(code) || !description) throw new SchemaError(PROVIDER, 'Maersk eCommerce returned an incomplete scan');
    const clock = scanClock(row);
    const location = [text(row, 'city', 100), text(row, 'region', 80)].filter(Boolean).join(', ');
    // The tracker lists a scan a partner reports twice as two rows; it is one scan.
    const key = JSON.stringify([clock.time ?? clock.local_time, code, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const stage = maerskStage(code, text(row, 'maerskTrackingStatusGroup', 64), row.isExceptionEventType === true);
    events.push({ ...clock, description, ...(location ? { location } : {}), provider_code: code,
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const delivery = events.find((event) => event.stage === 'delivered');
  const destination = isRecord(payload.destinationAddress) ? payload.destinationAddress : {};
  const country = COUNTRIES[text(destination, 'countryIso3', 3).toUpperCase()];
  // The tracker shows this day as the expected delivery, with a clock that names no zone.
  const estimate = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}$/.exec(text(payload, 'estimatedDeliveryDate', 32))?.[1];
  const service = text(payload, 'serviceName', 80).replace(/_/g, ' ');
  return {
    status: staged ? languageStageStatus(staged.stage as Stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: delivery || !estimate ? null : estimate,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    ...(service ? { service_name: service } : {}),
    ...(country ? { destination_country: country } : {}),
    ...handoff(payload, country),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
