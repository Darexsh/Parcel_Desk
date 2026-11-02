import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * SPL's scan `Status`: the step of the tracker's progress bar, numbered in the
 * order of the step labels in the tracker's script. Replies agree with that order
 * for every step seen, and the page offers to pay a customs bill on step 8.
 */
const STEPS: ReadonlyMap<string, Stage> = new Map([
  ['12', 'registered'], // Preparation: the sender announced the parcel and SPL waits for it.
  ['1', 'accepted'], // Received from the customer at an office or operation centre.
  ['2', 'in_transit'], // Under process: on the way, arrived, cleared by customs.
  ['3', 'in_transit'], // Scheduled for transportation.
  ['4', 'out_for_delivery'], // Under delivery.
  ['5', 'delivered'],
  ['6', 'ready_for_pickup'],
  ['7', 'customs'], // Clearance: examined, waiting for documents or for the duty.
  ['8', 'customs'], // A customs bill was issued and must be paid.
  ['9', 'returned'], // Return to origin: on the way back, then back.
  ['10', 'customs'], // Seized.
  ['11', 'exception'], // Waiting for the customer, such as for a complete address.
]);

// Steps 2 and 4 also carry scans whose wording says more than the step: a
// missed delivery, a parcel waiting at an office or held, and a partner's
// arrival in the destination country, which is not yet a delivery round.
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/\bdelivery has been attempted\b|\bfailed delivery\b/i, 'failed_attempt'],
  [/\bready for pickup\b/i, 'ready_for_pickup'],
  [/\bon hold\b/i, 'exception'],
  [/\barrived at final destination\b/i, 'in_transit'],
];
const WORDED_STEPS = new Set(['2', '4']);

/** The stage SPL's step and wording give a scan. */
export function saudiPostMappedStage(code: string, wording: string): Stage | undefined {
  if (WORDED_STEPS.has(code)) {
    const worded = WORDINGS.find(([pattern]) => pattern.test(wording));
    if (worded) return worded[1];
  }
  return STEPS.get(code);
}

/** A scan's stage: its step and wording, else the shared wording rules, else nothing. */
export function saudiPostStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = saudiPostMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? saudiPostMappedStage(code, wording) : undefined),
  gaps: [],
};
