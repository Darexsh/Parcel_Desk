import { DateTime } from 'luxon';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { withTieOrder } from '../../core/result/order.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { ozonStage, ozonWording } from './status.js';
import { ozonPosting } from './number.js';

export const PROVIDER = 'Ozon';
export const ORIGIN = 'https://tracking.ozon.ru';
export const MAX_BYTES = 1_000_000;
const PLACEHOLDERS = new Set(['FantomDelivery', 'OnTheWayToImportCustomsClearancePhantomStatus', 'InCustomsClearancePhantomStatus']);

/** The facade removes separators; rebuild only Ozon's two complete posting layouts. */
export function normalizeOzonNumber(raw: string): string {
  const number = ozonPosting(raw);
  if (!number) throw new InvalidInputError(PROVIDER, 'Ozon requires a complete posting number');
  return number;
}

export const ozonApi = (number: string): string => `${ORIGIN}/p-api/ozon-track-bff/tracking/${number}`;

function clock(value: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  if (typeof value !== 'string' || value.length > 64) throw new SchemaError(PROVIDER, 'Ozon returned an invalid scan clock');
  const explicit = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value);
  const instant = explicit ? explicitOffsetTime(value) : null;
  if (instant) return { time: instant.iso };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
    const local = DateTime.fromISO(value, { zone: 'utc' });
    if (local.isValid) return { local_time: local.toFormat("yyyy-MM-dd'T'HH:mm:ss") };
  }
  throw new SchemaError(PROVIDER, 'Ozon returned an invalid scan clock');
}

/** The API has no identifier field: callers must bind its GET to the complete posting. */
export function parseOzon(payload: unknown): CarrierResult {
  if (!isRecord(payload) || !Array.isArray(payload.items) || payload.items.length > 500
    || typeof payload.deliveryType !== 'string') throw new SchemaError(PROVIDER, 'Ozon returned an invalid tracking reply');
  const rows = payload.items.map(row => {
    if (!isRecord(row) || typeof row.event !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,99}$/.test(row.event)) {
      throw new SchemaError(PROVIDER, 'Ozon returned an invalid scan');
    }
    return row;
  });
  const pickup = ['PVZ', 'Post'].includes(payload.deliveryType) || rows.some(row => row.event === 'AvailableForPickup');
  const events: CarrierEvent[] = rows.filter(row => !PLACEHOLDERS.has(row.event as string)).map(row => {
    const code = row.event as string, stage = ozonStage(code);
    const wording = code === 'Received' ? pickup ? 'PickedUpByTheCustomer' : 'DeliveredByCourier' : code;
    return { ...clock(row.moment), description: ozonWording(wording), provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  }).reverse();
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Ozon returned no dated tracking events');
  withTieOrder(events);
  const latest = events[0]!;
  const stage = latest.stage;
  const status: CarrierStatus = stage === 'delivered' ? 'delivered' : stage === 'exception' ? 'exception'
    : stage === 'ready_for_pickup' ? 'out_for_delivery' : stage === 'registered' ? 'pending' : stage ? 'in_transit' : 'unknown';
  // These are calendar-day estimates in the tracker, not scheduled scan instants.
  const day = (value: unknown): string | undefined => typeof value === 'string' && explicitOffsetTime(value) ? value.slice(0, 10) : undefined;
  return { status, ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description, ...(latest.time ? { last_update: latest.time } : {}),
    ...(stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    expected_delivery_from: day(payload.deliveryDateBegin), expected_delivery: day(payload.deliveryDateEnd), events };
}
