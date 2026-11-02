import { SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { inpostClock } from './clock.js';

// The public vocabulary describes completed statuses; expected_flow is a forecast.
// https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/pages/18153478/Statuses
const CURRENT = new Map<string, ClassifiedStatus & { text: string }>([
  ['created', { status: 'pending', stage: 'registered', text: 'Shipment created' }],
  ['collected_from_sender', { status: 'in_transit', stage: 'accepted', text: 'Collected from the sender' }],
  ['adopted_at_source_branch', { status: 'in_transit', stage: 'in_transit', text: 'Received at the logistics centre' }],
  ['adopted_at_sorting_center', { status: 'in_transit', stage: 'in_transit', text: 'Received at the sorting centre' }],
  ['out_for_delivery', { status: 'out_for_delivery', stage: 'out_for_delivery', text: 'Handed over for delivery' }],
  ['out_for_delivery_to_address', { status: 'out_for_delivery', stage: 'out_for_delivery', text: 'Handed to the delivery courier' }],
  ['ready_to_pickup', { status: 'out_for_delivery', stage: 'ready_for_pickup', text: 'Ready for collection' }],
  ['delivered', { status: 'delivered', stage: 'delivered', text: 'Delivered' }],
  ['returned_to_sender', { status: 'exception', stage: 'returned', text: 'Returning to the sender' }],
  ['pickup_reminder_sent_address', { status: 'exception', stage: 'failed_attempt', text: 'Delivery attempted; recipient unavailable' }],
  ['rejected_by_receiver', { status: 'exception', stage: 'failed_attempt', text: 'Recipient refused the parcel' }],
]);

/** ShipX clocks and wording differ from hub scans: confirm current state without replacing history. */
export function parseInpostShipxSummary(payload: unknown, number: string): CarrierResult | null {
  if (!isRecord(payload) || payload.tracking_number !== number) {
    throw new SchemaError('InPost ShipX', 'InPost ShipX did not identify the requested shipment');
  }
  if (typeof payload.service !== 'string' || !/^inpost_(?:courier|locker)_[a-z_]+$/.test(payload.service)) return null;
  const code = typeof payload.status === 'string' ? payload.status : '';
  const current = CURRENT.get(code);
  if (!current) return null;
  const scans = payload.tracking_details;
  if (!Array.isArray(scans) || !scans.length || scans.length > 500) return null;
  const newest: unknown = scans[0];
  if (!isRecord(newest) || newest.status !== code) return null;
  const time = inpostClock(newest.datetime);
  if (!time || scans.some(scan => isRecord(scan) && (inpostClock(scan.datetime)?.timestamp ?? -Infinity) > time.timestamp)) return null;
  // updated_at dates ingestion, not a scan. Recipient fields, locations and
  // the other feed's history are deliberately not read into the result.
  return {
    status: current.status,
    current_stage: current.stage,
    current_stage_source: 'carrier_map',
    provider_code: code,
    last_status_text: current.text,
    last_update: time.iso,
    expected_delivery: null,
    ...(current.stage === 'delivered' ? { delivered_at: time.iso } : {}),
    summary_only: true,
    events: [],
  };
}
