import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings of Evdemo Lojistik's tracker, which carry no code: its scans,
 * the older scans its archived pages show and the labels of the progress rail
 * those pages had. Another wording falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The shipper announced the parcel, then the shipment was entered.
  ['Gönderi Bildirimi', 'registered'],
  ['Gönderi Talebiniz Oluşturuldu', 'registered'],
  // Collected from the sender, or registered at the departure branch.
  ['Kargonuzu Göndericiden Teslim Aldık', 'accepted'],
  ['Yeni Gönderi', 'accepted'],
  ['Kargonuz Alındı.', 'accepted'],
  ['Çıkış Dağıtım Merkezinde', 'in_transit'],
  ['Taşıma Durumunda', 'in_transit'],
  ['Transfer Sürecinde', 'in_transit'],
  ['Kargonuz Teslimatı Yapacak Şubemize Doğru Yolda', 'in_transit'],
  // At the branch that delivers it, before it goes out.
  ['Kargonuz Teslimatı Yapacak Olan Şubemizdedir', 'in_transit'],
  ['Kargonuz Teslim Edilmek Üzere Dağıtımda', 'out_for_delivery'],
  ['Dağıtıma Çıkarıldı', 'out_for_delivery'],
  // Not delivered; back at the branch to go out again.
  ['Kargonuzu Teslim Edemedik. Tekrar Dağıtıma Çıkarmak Üzere Şubemizde Bekliyor', 'failed_attempt'],
  ['Kargonuzu Teslim Ettik', 'delivered'],
  ['Teslim Edildi.', 'delivered'],
  // On its way back to the sender, then handed back.
  ['İade edilmek üzere yolda', 'returned'],
  ['Göndericiye iade edildi', 'returned'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage Evdemo Lojistik's map gives a wording in `normalizeStatusWording` form. */
export function evdemoMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function evdemoStage(wording: string): ClassifiedWording | null {
  const mapped = evdemoMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => evdemoMappedStage(wording),
  gaps: [],
};
