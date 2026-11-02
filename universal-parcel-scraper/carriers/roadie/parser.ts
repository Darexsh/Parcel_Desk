import { carrierDefinition } from '../../core/catalog/definitions.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ruleFits } from '../../core/detection/rules.js';
import { InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import type { Stage } from '../../generated/catalog.js';

const PROVIDER = 'Roadie';
type Milestone = { description: string; stage: Stage };
const MILESTONES: Readonly<Record<string, Milestone>> = {
  roadie_on_way_to_pickup: { description: 'Driver on the way to pickup', stage: 'registered' },
  driver_approaching_pickup: { description: 'Driver approaching pickup', stage: 'registered' },
  roadie_at_pickup: { description: 'Driver at pickup', stage: 'registered' },
  pickup_verified: { description: 'Pickup verified', stage: 'registered' },
  pickup_confirmed: { description: 'Pickup Confirmed', stage: 'accepted' },
  pickup_handoff_confirmed: { description: 'Pickup handoff confirmed', stage: 'accepted' },
  driver_approaching_delivery: { description: 'Driver approaching delivery', stage: 'out_for_delivery' },
  roadie_at_delivery: { description: 'Driver at delivery', stage: 'out_for_delivery' },
  delivery_confirmed: { description: 'Delivered', stage: 'delivered' },
  delivery_attempted: { description: 'Delivery Attempted', stage: 'failed_attempt' },
  carrier_transfer: { description: 'Transferred to Carrier', stage: 'in_transit' },
  gig_cancelled: { description: 'Canceled', stage: 'exception' },
};
const CANCELLATION_CODES = new Set(['item_already_delivered', 'item_not_in_stock', 'order_canceled', 'order_not_found',
  'lost_in_transit', 'lost', 'past_latest_delivery_time']);
const SENDER_APPLICATIONS = new Set(['web', 'sender_api', 'home_depot_proxy', 'delta_proxy']);

/** The public tracker distinguishes a driver-side interruption from a sender cancellation. */
function delayed(row: Record<string, unknown>): boolean {
  return row.cancellation_code === 'past_latest_delivery_time' || typeof row.cancellation_code === 'string'
    && !CANCELLATION_CODES.has(row.cancellation_code) && typeof row.cancellation_source_application === 'string'
    && !!row.cancellation_source_application && !SENDER_APPLICATIONS.has(row.cancellation_source_application);
}

/** Use the detection rules for both accepted layouts; Roadie's client lowercases the legacy one. */
export function roadieNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!carrierDefinition('roadie').detectionRules.some(rule => ruleFits(rule, number, raw))) {
    throw new InvalidInputError(PROVIDER, 'Roadie requires a complete delivery identifier');
  }
  return number.length === 16 ? number.toLowerCase() : number;
}

function timestamp(raw: unknown): string {
  const value = explicitOffsetTime(raw);
  if (!value) throw new SchemaError(PROVIDER, 'Roadie returned an invalid scan clock');
  return value.iso;
}

function status(stage: string): CarrierStatus {
  if (stage === 'delivered' || stage === 'out_for_delivery') return stage;
  if (stage === 'exception' || stage === 'failed_attempt') return 'exception';
  return stage === 'registered' ? 'pending' : 'in_transit';
}

export function parseRoadie(payload: unknown, requested: string): CarrierResult {
  const number = roadieNumber(requested);
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0])) throw new SchemaError(PROVIDER);
  const row = payload[0];
  if (typeof row.tracking_number !== 'string' || normalizeTrackingNumber(row.tracking_number) !== normalizeTrackingNumber(number)) {
    throw new SchemaError(PROVIDER, 'Roadie returned a different delivery');
  }
  if (typeof row.state !== 'string' || !/^[a-z_]{1,50}$/.test(row.state) || !Array.isArray(row.events) || row.events.length > 500) {
    throw new SchemaError(PROVIDER);
  }
  const events: CarrierEvent[] = [{ time: timestamp(row.created_at), description: 'Delivery Created',
    stage: 'registered', stage_source: 'carrier_map', provider_code: 'created' }];
  for (const item of row.events) {
    if (!isRecord(item) || typeof item.event_type !== 'string' || !/^[a-z_]{1,80}$/.test(item.event_type)) throw new SchemaError(PROVIDER);
    const time = timestamp(item.created_at);
    // Writing proof or recipient details after delivery is not a newer shipment milestone.
    if (item.event_type === 'delivery_details_added') continue;
    const mapped = item.event_type === 'gig_cancelled' && delayed(row)
      ? { description: 'Delayed', stage: 'exception' as const } : MILESTONES[item.event_type];
    events.push({ time, description: mapped?.description ?? 'Roadie tracking update', provider_code: item.event_type,
      ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' } : {}) });
  }
  // The public client dates expiration with the record's updated_at, even without event rows.
  if (row.state === 'expired') events.push({ time: timestamp(row.updated_at), description: 'Expired',
    stage: 'exception', stage_source: 'carrier_map', provider_code: 'expired' });
  events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const latest = events.find(event => event.stage)!;
  let current: Milestone = { description: latest.description!, stage: latest.stage as Stage };
  let lastUpdate = events[0]!.time!;
  if (row.state === 'expired' || row.state === 'cancelled' || row.state === 'canceled') {
    current = { description: row.state === 'expired' ? 'Expired' : delayed(row) ? 'Delayed' : 'Canceled', stage: 'exception' };
    lastUpdate = timestamp(row.updated_at);
  } else if (row.state === 'delivered' && latest.provider_code !== 'carrier_transfer') {
    current = { description: 'Delivered', stage: 'delivered' };
  }
  return { status: status(current.stage), current_stage: current.stage, current_stage_source: 'carrier_map',
    last_status_text: current.description, last_update: lastUpdate, provider_code: row.state, events };
}
