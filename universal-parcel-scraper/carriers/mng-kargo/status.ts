import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scan labels, mapped whole. The page gives no status code; each
 * scan has a short label and a sentence. A failed delivery's label is followed
 * by its reason after a colon, and the map reads the label; other sentences
 * repeat the label or name the branch, which the adapter reads as the place.
 */
export const MNG_KARGO_LABELS: Readonly<Record<string, Stage>> = {
  // "Shipment information created, the sender is preparing the parcel."
  'Gönderi Müşteride Hazırlanıyor': 'registered',
  // At the sender's branch, being prepared for the transfer centre.
  'Gönderi Hazırlanıyor': 'accepted',
  // Between the origin branch, the transfer centres and the delivering branch.
  'Transfer Aşamasında': 'in_transit',
  'Gönderi Teslimat Şubesinde': 'in_transit',
  // Rerouted to another delivering branch, and arrived there.
  'Yeni Teslimat Şubesine Doğru Yolda': 'in_transit',
  'Gönderiniz Yeni Teslimat Şubesinde': 'in_transit',
  'Gönderi Dağıtımda': 'out_for_delivery',
  'Teslim Edildi': 'delivered',
  // "Your shipment is being returned to its sender", under a return number of its own.
  'Gönderi İade Edildi': 'returned',
};

/** Labels that are a failed delivery whatever reason follows them. */
export const MNG_KARGO_FAILED_LABELS: readonly string[] = ['Teslim Edilemedi', 'Teslimat Denemesi Başarısız'];

/**
 * A delivery attempt "planned" with the reason "Devir": the carrier's word for a parcel carried
 * over to the next day because nobody was in, the address was wrong or the recipient refused it.
 */
export const MNG_KARGO_CARRIED_OVER = 'Teslimat Denemesi Planlandı: Devir';

const LABELS = new Map(Object.entries(MNG_KARGO_LABELS).map(([label, stage]) => [normalizeStatusWording(label), stage]));
const FAILED = MNG_KARGO_FAILED_LABELS.map(label => normalizeStatusWording(label));
const CARRIED_OVER = normalizeStatusWording(MNG_KARGO_CARRIED_OVER);

function stageOf(wording: string): Stage | undefined {
  if (wording === CARRIED_OVER) return 'failed_attempt';
  if (FAILED.some(label => wording === label || wording.startsWith(`${label}: `))) return 'failed_attempt';
  return LABELS.get(wording);
}

/** The stage a scan's description gives it, if any. */
export function mngKargoStage(description: string): Stage | undefined {
  return stageOf(normalizeStatusWording(description));
}

/** The tracker's scans carry a label and no code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : stageOf(wording)),
  gaps: [{
    wording: normalizeStatusWording('Teslimat Denemesi Planlandı'),
    note: 'A delivery attempt planned without a reason announces a delivery still to come; only the carried-over one is a failed attempt.',
  }],
};
