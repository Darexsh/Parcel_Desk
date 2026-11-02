import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of the movements Yurtiçi's tracker lists for a parcel on its
 * way, in English and in Turkish. Movements carry no code. The transport
 * document is the waybill the departure branch issues when it takes the
 * parcel; "Distribution exited" is the parcel out on a courier's round. A
 * parcel turned back to its sender is sent to its departure branch for the
 * return, which is not yet a return.
 */
const SCANS: readonly (readonly [string, Stage])[] = [
  ['The transport document was issued.', 'accepted'],
  ['Taşıma belgesi düzenlendi.', 'accepted'],
  ['In the transfer process.', 'in_transit'],
  ['Transfer Sürecinde', 'in_transit'],
  ['Reached the delivery unit.', 'in_transit'],
  ['Teslim birimine ulaştı.', 'in_transit'],
  ['Redirected to New Delivery Unit.', 'in_transit'],
  ['Yeni Teslim Birimine Yönlendirildi', 'in_transit'],
  ['Distribution exited.', 'out_for_delivery'],
  ['Dağıtıma çıkarıldı.', 'out_for_delivery'],
  ['NOT DELIVERED / WAITING AT BRANCH', 'failed_attempt'],
  ['Teslim edilemedi.', 'failed_attempt'],
  ['Redirected to Exit Unit for Return Process.', 'exception'],
  ['İade Süreci için Çıkış Birimine Yönlendirildi', 'exception'],
];

/**
 * The shipment's summary status. The English tracker translates some and
 * keeps others in Turkish. A return that has not reached its sender is a
 * problem, not yet a return.
 */
const SUMMARIES: readonly (readonly [string, Stage])[] = [
  ['DELIVERED', 'delivered'],
  ['TESLİM EDİLDİ', 'delivered'],
  ['İADE EDİLDİ', 'returned'],
  ['NOT RETURNED', 'exception'],
  ['İADE EDİLEMEDİ', 'exception'],
];

const keyed = (entries: readonly (readonly [string, Stage])[]) =>
  new Map(entries.map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const SCAN_KEYS = keyed(SCANS);
const SUMMARY_KEYS = keyed(SUMMARIES);

/** A movement's reason, which the adapter appends in brackets. */
const REASON = /\s*\([^()]*\)$/;

/** The stage a movement's wording gives it, its appended reason aside. */
export function yurticiScanStage(wording: string): Stage | undefined {
  return SCAN_KEYS.get(normalizeStatusWording(wording.replace(REASON, '')));
}

/** The stage a summary status gives the shipment, when it settles one. */
export function yurticiSummaryStage(wording: string): Stage | undefined {
  return SUMMARY_KEYS.get(normalizeStatusWording(wording));
}

/**
 * Movements and summary statuses carry wording only. A summary status words
 * the newest event of a parcel whose movements the tracker no longer lists.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code === null ? yurticiScanStage(wording) ?? yurticiSummaryStage(wording) : undefined,
  gaps: [],
};
