import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * HepsiJET's delivery statuses (`deliveryStatus`), which every scan carries
 * beside its wording. Return pickups use the collection statuses before the
 * parcel is in HepsiJET's hands. Only statuses seen in replies are mapped;
 * another falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['WAITING_FOR_DISPATCH', 'registered'], // A return booked, or its pickup appointment set.
  ['COLLECTING', 'registered'], // The courier is on the way to collect a return.
  ['UNABLE_TO_COLLECT', 'exception'], // The courier could not collect the return.
  ['COLLECTED', 'accepted'], // Taken from the sender, or arrived at the first branch after that.
  ['TRANSFERRING_COLLECT', 'in_transit'], // Arrived at a transfer centre from the collecting branch.
  ['TRANSFERRING_TRANSFER', 'in_transit'], // Arrived at a transfer centre from another one.
  ['READY', 'in_transit'], // Loaded or waiting at a centre for the next leg.
  ['DISPATCHING', 'in_transit'], // At the delivery branch.
  ['DELIVERING', 'out_for_delivery'],
  ['UNDELIVERED', 'failed_attempt'], // A delivery attempt that did not deliver, with its reason.
  ['TRANSFERRING_RETURN', 'returned'], // On the way back to the sender.
  ['DELIVERED', 'delivered'], // Handed over: to the recipient, or back to the sender as its wording says.
]);

/** Lower case without the dot `İ` keeps when lowered outside Turkish. */
function fold(wording: string): string {
  return wording.toLocaleLowerCase('en-US').replace(/̇/g, '');
}

// A delivered status whose wording says the parcel went back: "İade Edildi", "Satıcıya iade edildi".
const RETURNED = /\biade edildi\b/;

/** The stage HepsiJET's delivery status gives a scan with this wording. */
export function hepsijetMappedStage(code: string, wording: string): Stage | undefined {
  const upper = code.trim().toUpperCase();
  if (upper === 'DELIVERED' && RETURNED.test(fold(wording))) return 'returned';
  return CODES.get(upper);
}

/** A scan's stage: its delivery status, else the shared wording rules, else nothing. */
export function hepsijetStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = code ? hepsijetMappedStage(code, wording) : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? hepsijetMappedStage(code, wording) : undefined),
  gaps: [],
};
