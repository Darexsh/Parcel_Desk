import type { CarrierStatus } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type ClassifiedStatus, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Hongkong Post's English event wordings, seen in its own tracking history.
// The chatbot repeats the latest one with a full stop. "Held by customs" is
// routine clearance that release and delivery follow.
const WORDINGS = new Map<string, ClassifiedStatus>([
  ['sender is preparing item for posting', { status: 'pending', stage: 'registered' }],
  ['posted', { status: 'in_transit', stage: 'accepted' }],
  ['handed over to carrier / left for destination', { status: 'in_transit', stage: 'in_transit' }],
  ['arrived at processing centre (inward office of exchange)', { status: 'in_transit', stage: 'in_transit' }],
  ['held by customs', { status: 'in_transit', stage: 'customs' }],
  ['released from customs / despatched from processing centre (inward office of exchange)', { status: 'in_transit', stage: 'in_transit' }],
  ['delivery incomplete', { status: 'exception', stage: 'failed_attempt' }],
  ['delivered', { status: 'delivered', stage: 'delivered' }],
]);

export function hongkongPostStatus(wording: string): ClassifiedStatus | undefined {
  return WORDINGS.get(wording.replace(/\s+/g, ' ').trim().replace(/\.$/, '').toLowerCase());
}

/**
 * The carrier's own map first, then the shared wording rules. A wording
 * neither knows keeps no stage, and its status stays unknown.
 */
export function classifyHongkongPostStatus(wording: string): { status: CarrierStatus; stage?: Stage; source?: string } {
  const mapped = hongkongPostStatus(wording);
  if (mapped) return { ...mapped, source: 'carrier_map' };
  const classified = classifyWording(wording);
  return classified.source === 'none' ? { status: 'unknown' }
    : { status: languageStageStatus(classified.stage), stage: classified.stage, source: classified.source };
}

/** What the map says about one scan: its wording, when the carrier's own map knows it. */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => hongkongPostStatus(wording)?.stage, gaps: [] };
