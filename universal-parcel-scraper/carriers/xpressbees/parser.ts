import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { epochSecondsTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { xpressbeesStage } from './status.js';

const PROVIDER = 'Xpressbees';
export function normalizeXpressbeesNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{12,16}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Xpressbees requires an AWB number');
  return number;
}
export function parseXpressbees(payload: unknown, raw: string): CarrierResult {
  const number = normalizeXpressbeesNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  // This seller-platform feed does not index every consumer AWB. Its generic
  // invalid-AWB answer therefore cannot establish absence from Xpressbees.
  if (payload.status === false) throw new IndeterminateError(PROVIDER, 'Xpressbees seller tracking returned no history');
  if (payload.status !== true || !isRecord(payload.data)) throw new SchemaError(PROVIDER);
  const data = payload.data;
  if (!isRecord(data.shipment) || !isRecord(data.courier_info) || !Array.isArray(data.tracking) || data.tracking.length > 1000) throw new SchemaError(PROVIDER);
  if (typeof data.shipment.awb_number !== 'string' || normalizeTrackingNumber(data.shipment.awb_number) !== number) throw new SchemaError(PROVIDER, 'Xpressbees returned a different shipment');
  if (clean(data.courier_info.display_name).toLowerCase() !== 'xpressbees') throw new IndeterminateError(PROVIDER, 'The seller platform returned another carrier');
  if (!data.tracking.length) throw new IndeterminateError(PROVIDER, 'Xpressbees returned no tracking history');
  const events: CarrierEvent[] = data.tracking.map(row => {
    if (!isRecord(row) || typeof row.awb_number !== 'string' || normalizeTrackingNumber(row.awb_number) !== number) throw new SchemaError(PROVIDER, 'Xpressbees returned mixed or incomplete history');
    const description = clean(row.status, 1000) || clean(row.activity, 1000);
    if (!description) throw new SchemaError(PROVIDER, 'Xpressbees returned an empty scan');
    // Exact scan wording refines broad categories such as rto in transit.
    const categoryStage = xpressbeesStage(clean(row.ship_status, 100));
    const wordingStage = xpressbeesStage(description);
    const stage = categoryStage === 'returned' && wordingStage === 'delivered' ? 'returned' : wordingStage ?? categoryStage;
    const time = typeof row.event_time === 'number' && Number.isSafeInteger(row.event_time) && row.event_time >= 1_000_000_000 && row.event_time < 10_000_000_000
      ? epochSecondsTime(row.event_time)?.iso : undefined;
    const location = clean(row.location, 200), code = clean(row.status_code, 100);
    const returning = /^(?:rto|return)/i.test(clean(row.ship_status)) || /^(?:rto|return)/i.test(description);
    return { description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}), ...(time ? { time } : cleanScalar(row.event_time, 64) ? { provider_time_text: cleanScalar(row.event_time, 64) } : {}),
      ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}), ...(returning ? { provider_leg: 'return' } : {}) };
  });
  events.sort((a, b) => a.time && b.time ? Date.parse(b.time) - Date.parse(a.time) : 0);
  const unique = events.filter((row, index) => events.findIndex(other => JSON.stringify(other) === JSON.stringify(row)) === index);
  const latest = unique[0]!;
  // The feed's summary can remain "rto" after a terminal return scan. The
  // newest actual scan establishes the current milestone.
  const status: CarrierStatus = latest.stage === 'delivered' ? 'delivered' : latest.stage === 'out_for_delivery' ? 'out_for_delivery'
    : ['returned', 'exception', 'failed_attempt'].includes(latest.stage ?? '') ? 'exception'
      : ['registered', 'pending'].includes(latest.stage ?? '') ? 'pending' : latest.stage ? 'in_transit' : 'unknown';
  const eta = typeof data.shipment.pdd === 'number' && data.shipment.pdd >= 1_000_000_000 && data.shipment.pdd < 10_000_000_000 ? epochSecondsTime(data.shipment.pdd)?.iso : undefined;
  return { status, last_status_text: latest.description, last_update: latest.time ?? null, timezone: 'Asia/Kolkata',
    ...(latest.stage ? { current_stage: latest.stage, current_stage_source: latest.stage_source } : {}),
    ...(status === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(eta ? { expected_delivery: eta } : {}), events: unique.slice(0, 100) };
}
