import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const ENTRIES: readonly (readonly [string, Stage])[] = [
  ['Thank you. We have received your returned parcel', 'accepted'],
  ['Your returned parcel has been despatched to your local depot', 'in_transit'],
  ['Your returned parcel has arrived at your local depot', 'in_transit'],
  ['Your returned parcel has been despatched to our national depot', 'in_transit'],
  ['Your returned parcel has arrived at our national depot', 'in_transit'],
  // A return journey has not completed merely because it is leaving the depot.
  ['Your returned parcel has been despatched to your retailer', 'in_transit'],
];
const WORDINGS = new Map(ENTRIES.map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

export function toyouStage(wording: string): ClassifiedWording | null {
  const stage = WORDINGS.get(normalizeStatusWording(wording));
  return stage ? { stage, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : WORDINGS.get(normalizeStatusWording(wording)),
  gaps: [],
};
