import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// Passport's own scans, from the order to its origin processing centre. Their
// clock is Passport's, in UTC.
const OWN: ReadonlyMap<string, Stage> = new Map([
  ['thank you, order information received!', 'registered'],
  ['shipment details sent to passport', 'registered'],
  ['the shipping label has been created', 'registered'],
  ['passport does not have the package yet. your estimated delivery date will be updated once we receive it.', 'registered'],
  ['received at origin processing center', 'accepted'],
  ['scanned at origin processing center', 'accepted'],
  ['processed and preparing for export', 'in_transit'],
  ['shipped from origin processing center', 'in_transit'],
]);

// Partner scans in the partner's words that the shared rules leave without a
// stage or read differently.
const RELAYED: ReadonlyMap<string, Stage> = new Map([
  ['your parcel is in the air and is heading your way.', 'in_transit'],
  ['touchdown! your parcel has landed.', 'in_transit'],
  ['your parcel’s left the transfer country and is back on the move.', 'in_transit'],
  ['your parcel’s on its way to you, almost there!', 'out_for_delivery'],
  ['parcel received by uniuni', 'in_transit'],
  ['your parcel has been assigned to a delivery driver', 'in_transit'],
  ['received from prior carrier', 'in_transit'],
]);

// The page writes its apostrophes curly; a straight one reads the same.
const wordingOf = (description: string) => normalizeStatusWording(description.replaceAll("'", '’'));

/** Whether a scan is in Passport's own wording, which keeps Passport's UTC clock. */
export function passportOwnWording(description: string): boolean {
  return OWN.has(wordingOf(description));
}

/** The stage the map gives a wording, if it knows it. */
export function passportScanStage(description: string): Stage | undefined {
  const wording = wordingOf(description);
  return OWN.get(wording) ?? RELAYED.get(wording);
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function passportStage(description: string): ClassifiedWording | null {
  const mapped = passportScanStage(description);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : passportScanStage(wording)),
  gaps: [],
};
