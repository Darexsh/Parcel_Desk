import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// A return to origin, as Indian couriers word it. The shared rules would read its delivery back to the sender as a delivery.
const RETURN = /^\s*RTO\b/i;
const DELIVERED = /\bDELIVERED\b/i;
/**
 * Franch Express's scans come without a code, so their wordings stage them. A
 * hub scan is in transit: the shared rules read "Received at Hub" as an
 * acceptance. "Forwarded to" names the partner carrier the parcel is handed to.
 * A hold at the hub comes with a reason, such as rerouting. "Booked",
 * "In-Transit", "Misroute" and "Vehicle Delay" are from archived captures of
 * the older tracker.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^\s*BOOKED\b/i, 'accepted'],
  [/^\s*RECEIVED AT HUB\b/i, 'in_transit'],
  [/^\s*FORWARDED TO\b/i, 'in_transit'],
  [/^\s*IN[\s-]?TRANSIT\b/i, 'in_transit'],
  [/^\s*HOLDING AT HUB\b/i, 'exception'],
  [/^\s*MISROUTE\b/i, 'exception'],
  [/^\s*VEHICLE DELAY\b/i, 'exception'],
  [/^\s*DELIVERED\b/i, 'delivered'],
];

/** The stage Franch Express's own wordings give a scan. */
export function franchExpressMappedStage(wording: string): Stage | undefined {
  // A return on its way is an exception; one delivered back has been returned.
  if (RETURN.test(wording)) return DELIVERED.test(wording) ? 'returned' : 'exception';
  return WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** A wording's stage: Franch Express's own, else the shared wording rules, else nothing. */
export function franchExpressStage(wording: string): ClassifiedWording | null {
  const mapped = franchExpressMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => franchExpressMappedStage(wording),
  gaps: [],
};
