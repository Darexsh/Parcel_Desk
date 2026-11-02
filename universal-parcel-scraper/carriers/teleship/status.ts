import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Teleship's status vocabulary, which names the shipment's status over the
 * scans and each scan's `type`. The tracking page shows the same words.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  ['label_created', 'registered'],
  ['created', 'registered'],
  ['picked_up', 'accepted'],
  ['in_transit', 'in_transit'],
  ['delayed', 'in_transit'], // "Slight delay in delivery": still moving.
  ['out_for_delivery', 'out_for_delivery'],
  // "A delivery attempt has been made", although the page's rail puts it on the
  // delivered step; a delivery comes as `delivered`.
  ['delivery_event', 'failed_attempt'],
  ['delivered', 'delivered'],
  ['return_to_sender', 'returned'],
  ['alert', 'exception'], // "There is an issue with your parcel."
  ['cancelled', 'exception'],
  ['failed', 'exception'],
  ['terminated', 'exception'],
  ['discarded', 'exception'],
]);

/**
 * Teleship's event codes seen in replies, with the stage their scans' type
 * gave. Another code is staged by its scan's type alone.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['S_102', 'registered'], // Shipment info received by carrier: the label.
  ['S_902', 'exception'], // Shipment cancelled by shipper: the label was voided.
]);

/** The stage a status word gives, as the summary or a scan's type writes it. */
export function teleshipStatusStage(status: string): Stage | undefined {
  return STATUSES.get(status.trim().toLowerCase());
}

/**
 * A scan's stage: its type, else the shared wording rules, else nothing. The
 * `in_transit` type also covers the FAQ's export and import clearance, which
 * the wording rules read as customs.
 */
export function teleshipStage(type: string, wording: string): ClassifiedWording | null {
  const mapped = teleshipStatusStage(type);
  if (mapped === 'in_transit') {
    const worded = classifyWording(wording, 'in_transit');
    if (worded.stage === 'customs') return worded;
  }
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODES.get(code.toUpperCase()) : undefined),
  gaps: [],
};
