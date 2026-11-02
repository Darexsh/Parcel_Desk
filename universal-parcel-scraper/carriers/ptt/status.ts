import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * PTT words each scan as its own status in capitals, such as "TESLİM EDİLEMEDİ",
 * with a reason or a relayed foreign event around it in mixed case. The scans
 * carry no code. These rules read the wording with Turkish letters folded to
 * Latin ones, in order: a return comes first, since a return handed back to
 * its sender would also read as a delivery, a failed delivery also reads
 * "teslim", a hold at the office also reads "PTT İŞYERİNDE", and customs
 * released comes before customs.
 */
const RULES: readonly (readonly [RegExp, Stage])[] = [
  // "İADE" and its reason, as "Tanınmıyor": on its way back to the sender.
  [/\biade\b/, 'returned'],
  // "TESLİM EDİLEMEDİ" and the reason, as "Adreste Yok"; abroad, the attempt the foreign post relays.
  [/\bteslim edilemedi\b/, 'failed_attempt'],
  [/\bteslim edildi\b/, 'delivered'],
  // Out with the postman.
  [/\bdagitimda\b/, 'out_for_delivery'],
  // "(MEVKUF) Elde Kalmış Gönderi": the office holds an item nobody collected.
  [/\bmevkuf\b/, 'exception'],
  // Waiting at the PTT office the scan names, not "PTT İşyerine Girdi" or "İşyerinden Çıktı",
  // or in a Kargomat locker.
  [/\b(?:ptt isyerinde|kargomata birakildi)\b/, 'ready_for_pickup'],
  // Abroad, the foreign post's customs events.
  [/\bgumrukten cikti\b/, 'in_transit'],
  [/\bgumru[gk]/, 'customs'],
  // Also "Yurtdışı Kabul Edildi", accepted from abroad.
  [/\bkabul edildi\b/, 'accepted'],
  // Sent on, within a city, between cities or abroad, or loaded onto a vehicle.
  [/\b(?:transfer surecinde|il ici aktarmada|araca yuklendi)\b/, 'in_transit'],
];

/** Lower case with Turkish letters folded to Latin ones: "İL İÇİ" and "il ici" read alike. */
export function foldPttWording(wording: string): string {
  return wording.toLocaleLowerCase('en-US').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i')
    .split(/\s+/).join(' ').trim();
}

/** The stage PTT's own wording gives a scan, if the rules know it. */
export function pttScanStage(wording: string): Stage | undefined {
  const key = foldPttWording(wording);
  return RULES.find(([pattern]) => pattern.test(key))?.[1];
}

/**
 * A scan's stage from the rules, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function pttStage(wording: string): ClassifiedWording | null {
  const mapped = pttScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : pttScanStage(wording)),
  gaps: [],
};
