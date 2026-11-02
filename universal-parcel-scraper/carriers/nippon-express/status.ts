import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** Full-width digits and signs as their ASCII forms, lower case and single spaces. */
function key(wording: string): string {
  return normalizeStatusWording(wording.normalize('NFKC'));
}

/**
 * The latest status the air tracker's list gives a shipment, in Japanese,
 * without a code. On its way to the delivering branch is transit.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  ['配達店へ輸送中です。', 'in_transit'],
]);

/** The stage the map gives the list's status, if it knows the wording. */
export function nipponExpressStage(wording: string): Stage | undefined {
  return STATUSES.get(key(wording));
}

/** The statuses carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : nipponExpressStage(wording)),
  gaps: [],
};
