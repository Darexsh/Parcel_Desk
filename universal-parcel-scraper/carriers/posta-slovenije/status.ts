import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Pošta Slovenije names each scan with a short code of its own, such as VL,
 * and words it in Slovenian and English, with a detail line and, after a
 * failed delivery, what happens next. The Slovenian wording is the more exact
 * one, and the notes below follow it.
 */
const CODES: Readonly<Record<string, Stage>> = {
  // The sender's data arrived; the item is not handed over yet.
  NAJ: 'registered',
  // The item arrived at Pošta Slovenije and was sent on.
  S: 'accepted',
  // UPU's events in the origin country: the item posted, at the outward office of exchange,
  // then leaving it for abroad.
  EMA: 'accepted',
  EMB: 'in_transit',
  EMC: 'in_transit',
  // UPU's events at the destination's inward office of exchange: the item arrived from abroad,
  // then left it on its way to delivery, and its arrival at the delivery office.
  EMD: 'in_transit',
  EMJ: 'in_transit',
  EMK: 'in_transit',
  EMF: 'in_transit',
  EMG: 'in_transit',
  // UPU's final delivery to the recipient, after the inward events above.
  EMI: 'delivered',
  // "Pošiljka bo predvidoma dostavljena danes": with the postman, on its way to the address.
  N: 'out_for_delivery',
  // On its way to the parcel locker the recipient chose.
  VLPAKP: 'out_for_delivery',
  // Put in the recipient's letterbox or post office box, or handed over at the address.
  VL: 'delivered',
  // Nobody collected it from the parcel locker in time; it goes to a post office.
  POTPKTM: 'failed_attempt',
  // "Pošiljka ni bila prevzeta": not collected. What follows is in the scan's next step.
  V: 'failed_attempt',
  // It could not be delivered and goes to the post office, where it can be collected.
  VDO: 'failed_attempt',
  // Waiting at the post office for the recipient.
  IZR: 'ready_for_pickup',
  PVI: 'ready_for_pickup',
};

/** The next step a failed delivery names when the item goes back to its sender. */
const RETURNING = /\breturned to the sender\b/i;

/** Whether a scan sends the item back to its sender: a delivery after it reaches the sender. */
export function startsReturn(code: string, wording: string): boolean {
  return code === 'V' && RETURNING.test(wording);
}

/** The stage the carrier's code gives a scan, if the map knows it. */
export function postaSlovenijeCodeStage(code: string, wording: string): Stage | undefined {
  if (startsReturn(code, wording)) return 'exception';
  return Object.hasOwn(CODES, code) ? CODES[code] : undefined;
}

/**
 * A scan's stage from its code, else from the shared rules for its English
 * wording. Wording neither knows stays without a stage, so it remains visible.
 */
export function postaSlovenijeStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = postaSlovenijeCodeStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every scan carries a code; V reads its next step from the wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? postaSlovenijeCodeStage(code, wording) : undefined),
  gaps: [],
};
