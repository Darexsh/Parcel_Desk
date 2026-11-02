import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The labels of the tracker's 배송상태 (delivery status) column. Only labels
 * seen on Logen's own tracker are mapped; another label falls to the wording
 * rules.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map([
  // Left a business shipper's premises, before the pickup branch's own scans; the line is empty.
  ['거래처출고', 'accepted'],
  ['집하입고', 'accepted'], // Booked in at the pickup branch: 물품을 접수하였습니다.
  ['집하완료', 'accepted'], // Collection completed, with the same line.
  // Left the pickup branch for a hub. Recent histories start with it, without
  // an acceptance scan before it.
  ['집하출고', 'in_transit'],
  ['터미널입고', 'in_transit'], // Arrived at a hub terminal.
  ['행낭적입', 'in_transit'], // Bagged at a hub terminal; the line is empty.
  ['터미널출고', 'in_transit'], // Left a hub terminal for the next one or the delivery branch.
  ['행낭해체', 'in_transit'], // Unbagged at the delivery branch; the line is empty.
  ['배송입고', 'in_transit'], // Arrived at the delivery branch.
  ['배송출고', 'out_for_delivery'], // 고객님께 물품을 배달 준비 중입니다, with a delivery window.
  ['배송완료', 'delivered'], // 고객님께 물품을 전달하였습니다.
]);

/** The stage Logen's labels give a scan's label. */
export function logenMappedStage(label: string): Stage | undefined {
  return LABELS.get(label);
}

/** A scan's stage: its label, else the shared wording rules, else nothing. */
export function logenStage(label: string, wording: string): ClassifiedWording | null {
  const mapped = logenMappedStage(label);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? logenMappedStage(code) : undefined),
  gaps: [],
};
