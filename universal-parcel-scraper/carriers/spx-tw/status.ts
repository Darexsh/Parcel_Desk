import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status names of SPX's legacy tracking feed, which the Taiwanese tracker
 * reads. Its parcels go to the store the buyer chose and wait there. Only names
 * seen in its replies are mapped, with the delivery the feed names the same
 * way on SPX's other hosts; another name falls to the wording rules.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  ['Created', 'registered'], // The seller ships once the order is confirmed.
  ['DOP_Received', 'accepted'], // The seller dropped the parcel off.
  ['SP_LHTransporting', 'in_transit'], // On the way to the sorting centre.
  ['SOC_Received', 'in_transit'], // At the sorting centre.
  ['SP_Ready_Collection', 'ready_for_pickup'], // At the buyer's pickup store.
  ['Delivered', 'delivered'],
]);

/** The stage the feed's status name gives a scan. */
export function spxTwMappedStage(code: string): Stage | undefined {
  return STATUSES.get(code);
}

/** A scan's stage: its status name, else the shared wording rules, else nothing. */
export function spxTwStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = spxTwMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? spxTwMappedStage(code) : undefined),
  gaps: [],
};
