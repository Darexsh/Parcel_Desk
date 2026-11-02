import type { ClassifiedWording } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export function rexStage(wording: string): ClassifiedWording | null {
  return normalizeStatusWording(wording) === 'diterima' ? { stage: 'delivered', source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : rexStage(wording)?.stage,
  gaps: [{ wording: 'asal', note: 'The origin record alone does not establish parcel acceptance or movement.' },
    { wording: 'tujuan', note: 'A destination milestone alone does not establish arrival or delivery.' },
    { wording: 'dikirim ke pelanggan', note: 'The milestone does not distinguish dispatch from an out-for-delivery scan.' }],
};
