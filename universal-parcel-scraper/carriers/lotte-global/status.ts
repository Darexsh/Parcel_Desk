import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's step names (단계), which head every scan, and the words its
 * summary (배달결과) gives a waybill without scans. Each scan's provider code
 * is its step. The page's progress rail also names 상품접수, 터미널 입고 and
 * 배달지 도착; the last two are commented out of its markup and appear in no
 * history seen.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['인수/상품접수', 'accepted'], // The pickup branch took the parcel from the sender.
  ['상품접수', 'accepted'],
  ['터미널 입고', 'in_transit'],
  ['상품 이동중', 'in_transit'], // Arrived at a terminal, hub or delivery centre.
  ['배달지 도착', 'in_transit'],
  ['배송 출발', 'out_for_delivery'], // With the courier, with the delivery window.
  ['배달 완료', 'delivered'],
  ['배달완료', 'delivered'],
  ['미출고', 'registered'], // A waybill the sender has not handed over yet.
  ['예약취소', 'exception'], // A booking cancelled before pickup: no parcel will move.
]);

/** The stage the tracker's own steps give a step name or summary word. */
export function lotteMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its step, else the shared wording rules, else nothing. */
export function lotteStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = lotteMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? lotteMappedStage(code) : undefined),
  gaps: [],
};
