import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status ids Next Level's tracker gives each movement. The tracker labels
 * them in Bulgarian and the merchant API in English; id 17 shares the label of
 * id 2, so the map reads the id.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'], // In sender: the waybill exists, the parcel is still with the sender.
  ['2', 'accepted'], // Received by a courier.
  ['6', 'in_transit'], // In an office, including the subcontractor's, or loaded on a line haul.
  ['5', 'out_for_delivery'], // With the delivering courier.
  ['11', 'delivered'],
  ['17', 'returned'], // Picked up by a courier for the return to the sender.
  ['14', 'returned'], // Delivered back to the sender.
]);

/** Movements without an id, read by their whole description. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['приета от подизпълнител', 'in_transit'], // Accepted by the subcontractor that delivers abroad.
]);

/** A status id as the map keys it. */
export function nextLevelCodeKey(code: string): string {
  return code.trim();
}

/** The stage of a status id, or of the description of a movement without one; nothing for one the map does not name. */
export function nextLevelStage(code: string | null, wording: string): Stage | undefined {
  return code ? CODES.get(nextLevelCodeKey(code)) : WORDINGS.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = {
  codeKey: nextLevelCodeKey,
  stage: nextLevelStage,
  gaps: [
    { code: '20', note: 'Client return requested: the merchant API\'s status for a return the recipient asked for. It moves nothing.' },
  ],
};
