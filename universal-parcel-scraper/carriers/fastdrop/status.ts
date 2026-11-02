import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The package statuses of MotionTools, the platform Fastdrop runs on, with
 * the labels its tracking page heads a package with. A hub can hand a
 * package to the recipient: `ready_for_collection` waits there for them and
 * `collected` is their collection.
 */
const STATUSES: ReadonlyMap<string, { label: string; stage?: Stage }> = new Map([
  ['created', { label: 'Created', stage: 'registered' }],
  // Created without an address the platform can route to, until the sender gives one.
  ['destination_needed', { label: 'Destination needed', stage: 'registered' }],
  // On a driver's tour, waiting to be picked up.
  ['awaiting_pickup', { label: 'Awaiting pickup', stage: 'registered' }],
  ['in_transit', { label: 'In transit', stage: 'in_transit' }],
  ['at_hub', { label: 'At hub', stage: 'in_transit' }],
  ['at_customs', { label: 'At customs', stage: 'customs' }],
  ['scheduled_for_delivery', { label: 'Scheduled for delivery', stage: 'in_transit' }],
  ['out_for_delivery', { label: 'Out for delivery', stage: 'out_for_delivery' }],
  ['ready_for_collection', { label: 'Ready for collection', stage: 'ready_for_pickup' }],
  ['collected', { label: 'Collected', stage: 'delivered' }],
  ['delivered', { label: 'Delivered', stage: 'delivered' }],
  // A missed pickup or delivery; the failed stop in the journey says which.
  ['failed', { label: 'Failed' }],
  ['cancelled', { label: 'Cancelled', stage: 'exception' }],
]);

/**
 * The tracking page's wording for a resolved stop of the journey, which it
 * builds from the stop's type, outcome and whether it is at a hub.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['picked up from the sender', 'accepted'],
  ['pickup from the sender failed', 'exception'], // The parcel stays with the sender.
  ['arrived at the hub', 'in_transit'],
  ['drop-off at the hub failed', 'exception'],
  ['left the hub', 'in_transit'],
  ['pickup at the hub failed', 'exception'],
  ['delivered', 'delivered'],
  ['delivery failed', 'failed_attempt'],
  // The page's words for the leg under way, a stop not yet resolved.
  ['in transit to the hub', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
]);

// The page shows a failed stop's reason after its wording.
const REASON = /^(pickup from the sender failed|drop-off at the hub failed|pickup at the hub failed|delivery failed): /;

/** The label the tracking page gives a package status, or nothing for one it does not name. */
export function fastdropStatusLabel(code: string): string | undefined {
  return STATUSES.get(code)?.label;
}

/** The stage a package status gives on its own; `failed` takes its failed stop's. */
export function fastdropStatusStage(code: string): Stage | undefined {
  return STATUSES.get(code)?.stage;
}

/** The stage of a stop's wording in `normalizeStatusWording` form, its failure reason aside. */
export function fastdropWordingStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? WORDINGS.get(REASON.exec(wording)?.[1] ?? '');
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? fastdropStatusStage(code) : fastdropWordingStage(wording)),
  gaps: [
    { code: 'failed', note: 'A missed pickup or delivery: the failed stop in the journey decides between a failed delivery attempt and an exception.' },
  ],
};
