import { classifyWording, type ClassifiedWording } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export function nepalPostStage(wording: string): ClassifiedWording | null {
  if (normalizeStatusWording(wording) === 'counter entry') return { stage: 'accepted', source: 'carrier_map' };
  const staged = classifyWording(wording, 'in_transit');
  return staged.source === 'none' ? null : staged;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => !code && normalizeStatusWording(wording) === 'counter entry' ? 'accepted' : undefined,
  gaps: [],
};
