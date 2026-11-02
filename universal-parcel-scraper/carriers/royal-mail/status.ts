/**
 * Royal Mail status vocabulary.
 *
 * Summary categories come from the public application's statusCategoryIcon
 * vocabulary. Scan wording is matched separately: a collected scan may mean
 * carrier acceptance, while the summary category Collected means delivery.
 * `statuses.json` records the scan wording retained from prior art.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import { trackingLanguageStage, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const RETURNED_TERMS = ['return to sender', 'returned to sender', 'returning to sender'];
const FAILED_ATTEMPT_TERMS = [
  'delivery attempted', 'delivery attempt', 'delivery was attempted', 'no answer',
  'not delivered', 'unable to deliver', 'business closed', 'refused',
];
const EXCEPTION_TERMS = ['exception', 'delayed', 'delay', 'damaged', 'lost', 'customs charges', 'held'];

const OUT_FOR_DELIVERY_TERMS = ['out for delivery', 'out-for-delivery', 'on delivery'];
const READY_FOR_PICKUP_TERMS = ['ready for collection', 'ready to collect', 'available for collection'];
const REGISTERED_TERMS = ['manifest', 'label created', 'information received', 'order received', 'sender preparing'];
const ACCEPTED_TERMS = ['accepted', 'received', 'item received', 'collected', 'posted', 'handed over'];
const CUSTOMS_TERMS = ['customs', 'clearance'];
const IN_TRANSIT_TERMS = ['despatched', 'dispatched', 'redirected', 'in transit', 'on its way', 'in-transit', 'arrived', 'departed', 'processing', 'distribution centre', 'distribution center', 'mail centre', 'delivery office'];

// Codes present in the public tracking application's full-history response.
// Several movement scans share "Item Received", which alone cannot place them.
// The sender's despatch notice and a booked collection precede acceptance.
const EVENT_STAGES = new Map<string, Stage>([
  ['EVKOP', 'delivered'],
  ['EVKDN', 'delivered'],
  ['EVGPD', 'out_for_delivery'],
  ['EVKPD', 'out_for_delivery'],
  ['EVIMC', 'in_transit'],
  ['EVIAV', 'in_transit'],
  ['EVDAC', 'in_transit'],
  ['EVDAV', 'in_transit'],
  ['EVIPP', 'in_transit'],
  ['EVGID', 'in_transit'],
  ['EVHAC', 'in_transit'],
  ['EVHOE', 'in_transit'],
  ['EVIIS', 'in_transit'],
  ['EVBAH', 'in_transit'],
  ['EVJOE', 'in_transit'],
  ['EVJDU', 'in_transit'],
  // The item presented to the destination country's customs, which the destination post's own
  // tracker words "Item sent to Customs" in the same minute; EVJBA comes in that minute too.
  ['EVJIC', 'customs'],
  ['EVJBA', 'customs'],
  // The release ends the customs stage, as the summary category "Released from customs" does.
  ['EVJIA', 'in_transit'],
  // After a missed delivery: the redelivery round comes as its own scan, and the item kept at a
  // Customer Service Point waits for its recipient, who can also book a redelivery.
  ['EVNAR', 'failed_attempt'],
  ['EVNDA', 'ready_for_pickup'],
  // A delivery office's own delivery, to a business or a box that collects there: the summary
  // turns delivered with this scan as the last event.
  ['EVNFS', 'delivered'],
  // The recipient's own collection from the Customer Service Point, worded as EVNCE is: the
  // summary turns delivered with this scan as the last event.
  ['EVNOC', 'delivered'],
  ['EVCAD', 'accepted'],
  ['EVPPA', 'accepted'],
  ['LOPPA', 'accepted'],
  // Posted in a postbox, then the proof of posting checked: both before Royal Mail's first receipt.
  ['PBIDO', 'accepted'],
  ['EVTPC', 'accepted'],
  ['EVAIP', 'registered'],
  ['EVAIE', 'registered'],
  ['ECCSB', 'registered'],
]);

export function royalMailEventStage(code: string): Stage | null {
  return EVENT_STAGES.get(code) ?? null;
}

// Codes the map leaves without a stage on purpose, so their "collected" is not read as an acceptance.
const UNSTAGED_EVENTS: ReadonlyMap<string, string> = new Map([
  ['EVNSC', 'Collected and signed at a Customer Service Point: seen just before a booked redelivery, and it could as well be the recipient collecting the item.'],
  ['EVNCE', 'Collected from a Customer Service Point: seen just before a booked redelivery, and it could as well be the recipient collecting the item.'],
]);

/** A scan's stage by its code, else by its wording, unless the code leaves it without one on purpose. */
export function royalMailScanStage(code: string, description: string): Stage | undefined {
  return royalMailEventStage(code) ?? (UNSTAGED_EVENTS.has(code) ? undefined : royalMailStage(description) ?? undefined);
}

const SUMMARY_STAGES = new Map<string, Stage>([
  ["we're expecting it", 'registered'],
  ["we've got it", 'accepted'],
  ['left origin country', 'in_transit'],
  ['in customs', 'customs'],
  ['released from customs', 'in_transit'],
  ['left the uk', 'in_transit'],
  ['in transit', 'in_transit'],
  ['ready for delivery', 'in_transit'],
  ['delivery attempted', 'failed_attempt'],
  ['pending', 'pending'],
  ['returned to sender', 'returned'],
  ['delivered', 'delivered'],
  ['collected', 'delivered'],
  ['duplicate identified', 'exception'],
  ['restricted or prohibited contents', 'exception'],
]);

export function royalMailSummaryStage(category: string, description: string): Stage | null {
  return SUMMARY_STAGES.get(category.trim().toLocaleLowerCase('en-US')) ?? royalMailStage(description);
}

/**
 * Classify Royal Mail status prose. Returns null when nothing matches, so
 * callers leave an event unstaged rather than invent a stage.
 */
export function royalMailStage(text: string): Stage | null {
  const value = text.toLocaleLowerCase('en-US');
  if (!value) return null;
  if (RETURNED_TERMS.some((term) => value.includes(term))) return 'returned';
  if (FAILED_ATTEMPT_TERMS.some((term) => value.includes(term))) return 'failed_attempt';
  if (/^(?:delivered\b|(?:your )?item (?:was |has been )?delivered\b)/.test(value)) return 'delivered';
  if (OUT_FOR_DELIVERY_TERMS.some((term) => value.includes(term))) return 'out_for_delivery';
  if (READY_FOR_PICKUP_TERMS.some((term) => value.includes(term))) return 'ready_for_pickup';
  // A customs line the shared rules read as cleared ("Cleared customs") is a step in transit.
  if (CUSTOMS_TERMS.some((term) => value.includes(term))) return trackingLanguageStage(text) === 'in_transit' ? 'in_transit' : 'customs';
  if (EXCEPTION_TERMS.some((term) => value.includes(term))) return 'exception';
  if (REGISTERED_TERMS.some((term) => value.includes(term))) return 'registered';
  if (ACCEPTED_TERMS.some((term) => value.includes(term))) return 'accepted';
  if (IN_TRANSIT_TERMS.some((term) => value.includes(term))) return 'in_transit';
  return null;
}

export function statusForStage(stage: Stage): CarrierStatus {
  if (stage === 'delivered') return 'delivered';
  if (stage === 'out_for_delivery' || stage === 'ready_for_pickup') return 'out_for_delivery';
  if (stage === 'exception' || stage === 'failed_attempt' || stage === 'returned') return 'exception';
  if (stage === 'registered' || stage === 'pending') return 'pending';
  return 'in_transit';
}

/** The result-level status for summary and scan wording. */
export function royalMailStatus(text: string): CarrierStatus {
  const stage = royalMailStage(text);
  if (stage) return statusForStage(stage);
  return 'unknown';
}

/** What the map says about one scan: its event code, else its wording, as the parser reads them. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => royalMailScanStage(code ?? '', wording),
  gaps: [...UNSTAGED_EVENTS].map(([code, note]) => ({ code, note })),
};
