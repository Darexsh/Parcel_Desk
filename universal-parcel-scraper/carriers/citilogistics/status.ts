import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['delivered', 'delivered'],
  ['item received in sort facility', 'in_transit'],
  ['item cleared import charges paid', 'in_transit'],
]);

export function citiStage(wording: string): ClassifiedWording | null {
  const stage = WORDINGS.get(normalizeStatusWording(wording));
  return stage ? { stage, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : WORDINGS.get(normalizeStatusWording(wording)),
  gaps: [{ wording: 'item imported', note: 'This wording does not distinguish importing a record from a physical parcel movement.' }],
};
