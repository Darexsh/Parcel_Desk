import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The opening sentences of the tracker's scans, in the form the app keys
 * wording on. ShipEntegra words its own three scans; the line's partners'
 * scans come as one of its fixed sentences, often followed by the partner's
 * own words ("Package is out for delivery.En Route"), which the sentence
 * outranks: the shared rules read that one as in transit.
 */
const SENTENCES: readonly (readonly [string, Stage])[] = ([
  ['ShipEntegra Currently Awaiting Shipment and Tracking Will Be Updated When Received', 'registered'],
  ['Package Received at ShipEntegra Distribution Center', 'accepted'],
  // The partner's label, made once the parcel is at the distribution centre; the tracker's status then reads in transit.
  ['PROCESSING', 'in_transit'],
  // The line's partner takes the parcel over before Turkish export clearance.
  ['Shipment is accepted.', 'in_transit'],
  ['Shipment customs clearance is started.', 'customs'],
  ['Shipment manifested', 'in_transit'],
  ['Shipment customs clearance is completed.', 'in_transit'],
  ['Flight departed', 'in_transit'],
  ['Shipment arrived to destination facility.', 'in_transit'],
  ['Handover to Customs Broker', 'customs'],
  ['Import custom is started.', 'customs'],
  ['Waiting for customs clearence.', 'customs'],
  ['Import custom is completed.', 'in_transit'],
  ['Package is sorted, waiting for delivery.', 'in_transit'],
  ['Package is arrived post office/facility.', 'in_transit'],
  ['Package is in transit.', 'in_transit'],
  ['Package is out for delivery.', 'out_for_delivery'],
  ['Delivery was attempted, but was unsuccessful.', 'failed_attempt'],
  ['Package has been delivered.', 'delivered'],
] as const).map(([sentence, stage]) => [normalizeStatusWording(sentence), stage] as const);

/** The stage of a scan that opens with one of the tracker's sentences. */
export function shipentegraMappedStage(wording: string): Stage | undefined {
  const value = normalizeStatusWording(wording);
  // The label scan is one word, which longer wording does not extend.
  return SENTENCES.find(([sentence]) => sentence === 'processing' ? value === sentence : value.startsWith(sentence))?.[1];
}

/** A scan's stage: its opening sentence, else the shared wording rules, else nothing. */
export function shipentegraStage(wording: string): ClassifiedWording | null {
  const mapped = shipentegraMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The tracker's own status for the shipment (`status_description`), which its
 * page shows over the scans. `NOTFOUND` is a number it does not know.
 */
const SUMMARIES: ReadonlyMap<string, Stage> = new Map([
  ['PENDING', 'registered'],
  ['PICKED UP', 'accepted'],
  ['IN TRANSIT', 'in_transit'],
  ['DELIVERED', 'delivered'],
  ['SHIPMENT EXCEPTION', 'exception'],
  ['UNDELIVERED', 'failed_attempt'],
  ['RETURNED', 'returned'],
]);

/** The stage of the tracker's status for the shipment. */
export function shipentegraSummaryStage(status: string): Stage | undefined {
  return SUMMARIES.get(status.toUpperCase());
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => shipentegraMappedStage(wording),
  gaps: [],
};
