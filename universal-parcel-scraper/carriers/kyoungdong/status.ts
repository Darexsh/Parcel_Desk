import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scan types the tracker page's script draws, by their Korean label. The
 * page gives `도착` the icon of a finished parcel, but a delivery scan follows
 * it, so it is the delivering branch's arrival.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map([
  ['예약접수', 'registered'], // Booked, not handed over yet.
  ['접수', 'accepted'], // Accepted by the sending branch.
  ['발송', 'in_transit'], // Sent off by the sending branch; recent histories start with it.
  ['노선상차', 'in_transit'], // Loaded on a line-haul truck.
  ['터미널', 'in_transit'], // Scanned at a hub terminal.
  ['지연도착', 'in_transit'], // A late arrival.
  ['도착', 'in_transit'], // Arrived at the delivering branch.
  ['배송중', 'out_for_delivery'],
  ['인수확인', 'delivered'], // Receipt confirmed.
  ['배송완료', 'delivered'], // Recorded by the delivering branch.
]);

/** The scan type codes seen with their labels. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['0002', 'in_transit'], // 발송
  ['0004', 'in_transit'], // 노선상차
  ['0006', 'in_transit'], // 도착
  ['0007', 'delivered'], // 배송완료
  ['0008', 'out_for_delivery'], // 배송중
]);

/** The stage Kyungdong's scan types give a label, else a code. */
export function kyoungdongMappedStage(code: string | null, label: string): Stage | undefined {
  return LABELS.get(label.trim()) ?? (code ? CODES.get(code) : undefined);
}

/** A scan's stage: its label or code, else the shared wording rules, else nothing. */
export function kyoungdongStage(code: string | null, label: string): ClassifiedWording | null {
  const mapped = kyoungdongMappedStage(code, label);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(label, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => kyoungdongMappedStage(code, wording),
  gaps: [],
};
