import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const key = (wording: string) => normalizeStatusWording(wording.normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i'));
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Gönderi Talebi Alındı', 'registered'],
  ['Teslim aldık', 'accepted'],
  ['Yolda', 'in_transit'],
  ['gönderi yolda', 'in_transit'],
  ['transferde', 'in_transit'],
  ['Teslimata çıkardık', 'out_for_delivery'],
  ['dağıtıma çıktı', 'out_for_delivery'],
  ['dağıtımda, gün içinde teslim edilecek', 'out_for_delivery'],
  ['Teslim ettik', 'delivered'],
  ['teslim edildi', 'delivered'],
  ['teslim edilemedi', 'failed_attempt'],
  ['adreste bulunamadı', 'failed_attempt'],
  ['kayıp', 'exception'],
] as const).map(([wording, stage]) => [key(wording), stage]));

export function kolayGelsinMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

export function kolayGelsinStage(wording: string): ClassifiedWording | null {
  const stage = kolayGelsinMappedStage(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const answer = classifyWording(wording, 'in_transit');
  return answer.source === 'none' ? null : answer;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => kolayGelsinMappedStage(wording),
  gaps: [],
};
