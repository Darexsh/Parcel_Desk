import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * HR Parcel's scan codes, which its tracker's lookup gives beside each scan's
 * Italian label. Only codes seen in replies are mapped; another code falls to
 * the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // "Spedizione non ancora ricevuta presso i nostri magazzini": the sender's data came before the parcel.
  ['1000', 'registered'],
  ['1001', 'accepted'], // Taken in at the hub.
  ['1010', 'in_transit'], // Arrived at the delivering branch.
  ['1002', 'out_for_delivery'], // Also the label of a parcel sent out again.
  ['1003', 'delivered'],
  // Held at the branch (giacenza) for the recipient's instructions, which the
  // tracker lets them give; a held parcel the branch offers for collection says so.
  ['1007', 'exception'],
  ['1009', 'exception'], // Lost or stolen.
  ['1014', 'failed_attempt'], // Wrong address.
  ['1015', 'failed_attempt'], // The recipient was out at the first attempt.
  ['1016', 'failed_attempt'], // The recipient was out at a later attempt.
  ['1020', 'ready_for_pickup'],
  ['1021', 'delivered'], // Collected by the recipient.
]);

// "In Giacenza, disponibile per Ritiro": held, and waiting for the recipient to collect it.
const COLLECTABLE = /\bdisponibile per (?:il )?ritiro\b/i;

/** The stage HR Parcel's codes give a scan; a held parcel's label can make it collectable. */
export function hrParcelMappedStage(code: string, wording: string): Stage | undefined {
  const stage = CODES.get(code);
  return code === '1007' && COLLECTABLE.test(wording) ? 'ready_for_pickup' : stage;
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function hrParcelStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = hrParcelMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every code seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? hrParcelMappedStage(code, wording) : undefined),
  gaps: [],
};
