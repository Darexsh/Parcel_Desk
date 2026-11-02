import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['evrak oluşturuldu', 'registered'], ['kargo araca yüklendi', 'in_transit'],
  ['kargo araçtan indirildi', 'in_transit'], ['kurye dağıtıma çıktı', 'out_for_delivery'], ['teslim edildi', 'delivered'],
]);

export function suratKargoStage(wording: string): ClassifiedWording | null {
  const stage = WORDINGS.get(normalizeStatusWording(wording));
  if (stage) return { stage, source: 'carrier_map' };
  const staged = classifyWording(wording, 'in_transit');
  return staged.source === 'none' ? null : staged;
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => WORDINGS.get(wording), gaps: [] };
