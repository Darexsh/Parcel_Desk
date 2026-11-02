import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings of Atlantic's tracker, which carries no code: its own scans in
 * India, and the scans of the partner abroad it relays. Export paperwork and the
 * label Atlantic creates for the partner are in transit, where the shared rules
 * would read the label as a registration. A hold for the sender, a payment or
 * paperwork is an exception. "Delivered" is the summary's delivery, as the
 * page's progress rail labels it.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['delivered', 'delivered'],
  ['proof of delivery', 'delivered'],
  ['atlantic label created', 'in_transit'],
  ['prepared export documents', 'in_transit'],
  ['documentation prepared', 'in_transit'],
  ['shipment finalised', 'in_transit'],
  ['sent to destination', 'in_transit'],
  ['awaiting connection', 'in_transit'],
  ['expected connection today', 'in_transit'],
  ['under custom process', 'customs'],
  ['shipment hold as per shipper', 'exception'],
  ['hold for payment', 'exception'],
]);
// Wordings that name a place or give a reason: "SHIPMENT SENT TO MUMBAI BY AIR",
// "SHIPMENT OFFLOADED BY DELHI CUSTOMS", also written "OFFLOA D", and
// "This shipment has been hold up due to …".
const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  [/^shipment sent to \S/, 'in_transit'],
  [/^shipment offloa ?d(?:ed)? by .*\bcustoms?$/, 'customs'],
  [/^this shipment has been hold up\b/, 'exception'],
];
// Atlantic's receipt of the shipment, at the branch that books it and again at each hub.
const RECEIPT = 'shipment received';

/** The stage Atlantic's own wording gives a scan, if the map knows it. */
export function atlanticCourierMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? PATTERNS.find(([pattern]) => pattern.test(key))?.[1];
}

/** Whether a scan is Atlantic's receipt, whose stage depends on the receipts before it. */
export function isAtlanticCourierReceipt(wording: string): boolean {
  return normalizeStatusWording(wording) === RECEIPT;
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function atlanticCourierStage(wording: string): ClassifiedWording | null {
  const mapped = atlanticCourierMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The page carries wording only. "SHIPMENT RECEIVED" is the acceptance at the
 * first branch and in transit at every later hub, so the wording alone gives
 * it no stage.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : atlanticCourierMappedStage(wording)),
  gaps: [],
};
