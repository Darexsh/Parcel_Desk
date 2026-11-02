import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings of Horoz Lojistik's delivery note, which carry no code: the
 * movements of its table, its headline, and the states complaints quote from
 * its tracking screen. Another wording falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // A departure from, or an arrival at, a centre: the sender's depot or one of Horoz's.
  ['Çıkış', 'in_transit'],
  ['Giriş', 'in_transit'],
  ['dağıtım şubesinde', 'in_transit'],
  ['dağıtımda', 'out_for_delivery'],
  ['dağıtıma çıktı', 'out_for_delivery'],
  // Not delivered: the recipient was not found, or the address was not enough.
  ['adreste bulunamadı', 'failed_attempt'],
  ['siparişiniz teslim edilememiştir', 'failed_attempt'],
  ['adres yetersiz', 'failed_attempt'],
  ['Teslim', 'delivered'],
  ['teslim edildi', 'delivered'],
  ['GÖNDERİNİZ TESLİM EDİLMİŞTİR', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage Horoz Lojistik's map gives a wording in `normalizeStatusWording` form. */
export function horozMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A wording's stage: the map, else the shared wording rules, else nothing. */
export function horozStage(wording: string): ClassifiedWording | null {
  const mapped = horozMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => horozMappedStage(wording),
  gaps: [],
};
