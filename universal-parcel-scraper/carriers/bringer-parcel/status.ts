import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * BPX event codes whose stage the code settles. `BPS-0001` is the label; the
 * others are the outcomes BPX's web app closes a parcel with, which a scan's
 * parcel status alone does not tell apart.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['BPS-0001', 'registered'], // Label Created.
  ['BPS-1601', 'delivered'], // Delivered, set by BPX on the evidence it has.
  ['BPS-6601', 'returned'], // Returned to sender.
  ['BPS-1830', 'exception'], // Lost; the sender can claim.
  ['BPS-1808', 'exception'], // Stolen.
  ['BPS-1837', 'exception'], // Abandoned.
  ['BPS-5005', 'exception'], // Refused by the recipient.
  ['BPS-1826', 'exception'], // Disposed of.
  ['BPS-1809', 'exception'], // Refused by a regulatory agency.
]);

/**
 * The parcel status every scan carries, which the page shows as its label when
 * the scan has no BPX wording of its own.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  ['pending', 'registered'],
  ['label_generated', 'registered'],
  ['received_for_shipping', 'accepted'],
  // Measured and weighed at BPX's Miami warehouse after it took the parcel.
  ['inspection_of_package_dimensions_and_weight', 'in_transit'],
  // Put in a dispatch, the dispatch closed and handed over.
  ['assigned', 'in_transit'],
  ['dispatch_closed', 'in_transit'],
  ['collected', 'in_transit'],
  ['in_transit', 'in_transit'],
  ['customs', 'customs'],
  ['delivered', 'delivered'],
  ['returned', 'returned'],
  ['undeliverable', 'exception'],
]);

/** The English label the tracking page shows for a parcel status. */
export const STATUS_LABELS: ReadonlyMap<string, string> = new Map([
  ['pending', 'Pending'],
  ['label_generated', 'Label Generated'],
  ['processing_error', 'Processing Error'],
  ['received_for_shipping', 'Received for Shipping'],
  ['inspection_of_package_dimensions_and_weight', 'Dimension & Weight Inspection'],
  ['assigned', 'Assigned'],
  ['dispatch_closed', 'Dispatch Closed'],
  ['collected', 'Collected'],
  ['in_transit', 'In Transit'],
  ['customs', 'Customs'],
  ['delivered', 'Delivered'],
  ['returned', 'Returned'],
  ['undeliverable', 'Undeliverable'],
]);

// An error creating the label moves nothing.
const NOTICE = /^processing_error$/i;

/** The stage BPX's own code or parcel status gives a scan's provider code. */
export function bringerParcelMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase()) ?? STATUSES.get(code.toLowerCase());
}

/**
 * A scan's stage: its BPX code when the code settles it, else the parcel
 * status it carries, else the shared wording rules, else nothing.
 */
export function bringerParcelStage(code: string, status: string, wording: string): ClassifiedWording | null {
  const mapped = CODES.get(code.toUpperCase()) ?? STATUSES.get(status.toLowerCase());
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICE.test(status)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * A scan's provider code is its BPX code, else its parcel status. A BPX code
 * outside the map takes its stage from the parcel status beside it, which the
 * code alone does not carry.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? bringerParcelMappedStage(code) : undefined),
  gaps: [
    { code: 'processing_error', note: 'An error creating the parcel\'s label in BPX\'s system; the parcel has not moved.' },
  ],
};
