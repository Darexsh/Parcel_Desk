import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * T-CAT's scan labels, as its tracker shows them and its status explanation
 * page defines them. The scans carry no code, so the wording is the key.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['取件中', 'registered'], // A driver is on the way to collect the parcel.
  ['已集貨', 'accepted'], // Collected from the sender.
  ['取消取件', 'exception'], // The sender cancelled the pickup.
  ['未順利取件，請洽客服中心', 'exception'], // The driver could not collect the parcel.
  ['轉運中', 'in_transit'], // Between a branch and a transfer centre.
  ['暫置營業所', 'in_transit'], // Kept at a branch.
  ['配送中', 'out_for_delivery'],
  ['順利送達', 'delivered'],
  ['不在家', 'failed_attempt'],
  ['不在家.公司行號休息', 'failed_attempt'], // The recipient was out or the business closed.
  ['另約時間', 'failed_attempt'], // Another delivery time was arranged.
  ['到所自取', 'ready_for_pickup'], // The recipient collects the parcel at the branch.
  ['暫置營業所保管中（請聯絡黑貓宅急便）', 'exception'], // Held at the branch after failed attempts.
  ['調查處理中', 'exception'], // Under investigation: unknown address, move, refusal, flight delay.
  ['客樂得貨物退回中', 'returned'], // A cash-on-delivery parcel on its way back to the sender.
]);

// A note in brackets after a label, as in 配送中(當配下車) for same-day delivery.
const NOTE = /\s*[（(][^（）()]*[）)]$/;

const key = (text: string) => text.trim().split(/\s+/).join(' ');

/** The stage T-CAT's wording gives a scan, or a bracketed variant of it. */
export function tcatMappedStage(wording: string): Stage | undefined {
  const label = key(wording);
  return WORDINGS.get(label) ?? WORDINGS.get(label.replace(NOTE, ''));
}

/** A scan's stage: its wording, else the shared wording rules, else nothing. */
export function tcatStage(wording: string): ClassifiedWording | null {
  const mapped = tcatMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => tcatMappedStage(wording),
  gaps: [],
};
