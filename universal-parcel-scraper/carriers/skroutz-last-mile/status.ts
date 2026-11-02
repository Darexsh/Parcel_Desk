import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording Skroutz Last Mile's page shows for a scan, in English and in
 * Greek. Only wording seen in replies is mapped. A hub scan names the hub,
 * which varies; the English text keeps the Greek name.
 */
const WORDING: readonly (readonly [RegExp, Stage])[] = [
  [/^(?:we have picked up the shipment from the sender|παραλάβαμε το δέμα από το κατάστημα)$/, 'accepted'],
  // At one of its own hubs ("SLM HUB" and the town) or at the hub of the courier that brought it.
  [/^(?:the shipment is at|η αποστολή βρίσκεται στο) (?:slm )?hub \S.*$/, 'in_transit'],
  // A delivery day was planned; it can repeat before the round.
  [/^(?:the delivery of the shipment has been scheduled|η παράδοση του δέματος έχει προγραμματιστεί)$/, 'in_transit'],
  [/^(?:the shipment is en route for delivery|η αποστολή βρίσκεται σε δρομολόγιο παράδοσης)$/, 'out_for_delivery'],
  [/^(?:the shipment is approaching the delivery location|η αποστολή πλησιάζει στο χώρο παράδοσης)$/, 'out_for_delivery'],
  // Placed in a Skroutz Point locker for the recipient, who collects it later.
  [/^παράδοση σε skroutz point$/, 'ready_for_pickup'],
  [/^(?:delivered|παραδόθηκε)$/, 'delivered'],
];

/**
 * The tracking state the reply files a scan under. It is coarser than the
 * wording: `PICKED_UP` covers both the pickup from the shop and the courier
 * leaving the hub on a delivery round, so it is left to the wording.
 */
const STATES: ReadonlyMap<string, Stage> = new Map([
  ['SCANNED', 'in_transit'], // Scanned at a hub.
  ['AWAITING_PICKUP', 'in_transit'], // A delivery day was planned; the courier has not taken the parcel yet.
  ['ASSIGNED_TO_COURIER_FOR_DELIVERY', 'out_for_delivery'], // The next stop of the courier's round.
  ['DELIVERED', 'delivered'],
]);

/** The stage a wording gives, read in the form the app keys it on. */
export function skroutzWordingStage(wording: string): Stage | undefined {
  const key = wording.toLocaleLowerCase('en-US').trim().split(/\s+/).join(' ');
  return WORDING.find(([pattern]) => pattern.test(key))?.[1];
}

/** The stage a tracking state gives. */
export function skroutzStateStage(code: string): Stage | undefined {
  return STATES.get(code.toUpperCase());
}

/**
 * A scan's stage: its English or Greek wording, else its tracking state, else
 * the shared wording rules on the English text, else nothing.
 */
export function skroutzStage(code: string, english: string, greek = ''): ClassifiedWording | null {
  const mapped = skroutzWordingStage(english) ?? skroutzWordingStage(greek) ?? (code ? skroutzStateStage(code) : undefined);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(english || greek, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => skroutzWordingStage(wording) ?? (code ? skroutzStateStage(code) : undefined),
  gaps: [],
};
