/**
 * Pos Malaysia status vocabulary.
 *
 * `process_summary` is the short English label on each tracking row; the longer
 * `process` sentence next to it is display prose and is never mapped. Only the
 * parcel-level `process_status` value "DELIVERED" is a closed overall state —
 * everything else is derived from the latest event.
 *
 * Unknown summaries remain visible without inventing a movement or terminal
 * stage. The fixed labels come from the official tracking SPA's sample data
 * and identity-bound tracking responses.
 */
import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const SUMMARY_STATUS: Record<string, ClassifiedStatus> = {
  'Delivery completed': { status: 'delivered', stage: 'delivered' },
  'Out for delivery': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'Preparing for delivery': { status: 'in_transit', stage: 'in_transit' },
  'Sorting completed': { status: 'in_transit', stage: 'in_transit' },
  'On the way': { status: 'in_transit', stage: 'in_transit' },
  'Collected': { status: 'in_transit', stage: 'accepted' },
  'Item arrived at delivery office': { status: 'in_transit', stage: 'in_transit' },
  'Your parcel is being transported to the next facility': { status: 'in_transit', stage: 'in_transit' },
  'Your parcel has arrived at destination facility for Processing': { status: 'in_transit', stage: 'in_transit' },
  'Your parcel is being transported to destination country': { status: 'in_transit', stage: 'in_transit' },
  'Your parcel has arrived at our facility for sorting': { status: 'in_transit', stage: 'in_transit' },
  // Live summaries of international items; a cleared item resumes transit.
  'Arrived at International Hub': { status: 'in_transit', stage: 'in_transit' },
  'Your parcel has been presented to the Customs Authority for inspection': { status: 'in_transit', stage: 'customs' },
  'Your parcel has been cleared by the Customs Authority': { status: 'in_transit', stage: 'in_transit' },
  'Your item is being sorted in destination facility': { status: 'in_transit', stage: 'in_transit' },
  'Your parcel is out for delivery': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'Destination station has delivered your parcel. Thank you!': { status: 'delivered', stage: 'delivered' },
};

/** Only explicit summaries establish a stage. */
export function classifyPosMalaysiaStatus(summary: string): ClassifiedStatus | null {
  return Object.hasOwn(SUMMARY_STATUS, summary) ? SUMMARY_STATUS[summary]! : null;
}

/** Whether the map knows this summary, for tests and documentation. */
export function isMappedPosMalaysiaSummary(summary: string): boolean {
  return Object.hasOwn(SUMMARY_STATUS, summary);
}

const SUMMARY_STAGE = new Map<string, Stage>(Object.entries(SUMMARY_STATUS).map(([summary, { stage }]) => [normalizeStatusWording(summary), stage]));

/**
 * What the map says about one scan. Its summary stages it, and the stored scan keeps the summary
 * only when the row has no longer process text, so only a summary's own wording stages a scan;
 * the delivery the parcel's status adds reads "Delivered".
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === 'DELIVERED' && wording === 'delivered' ? 'delivered' : SUMMARY_STAGE.get(wording)),
  gaps: [],
};
