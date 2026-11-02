import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The checkpoint labels the tracking page shows, as `chkPointDesc2`. A
 * not-delivered scan names its reason in brackets: `인계` is a hand-over to
 * another carrier that delivers the parcel, so it moves on.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map([
  ['발송사무소 인수', 'accepted'], // Taken in by the sending office.
  ['배송경유지 도착', 'in_transit'], // Arrived at a branch or terminal on the way.
  ['배송경유지 출고', 'in_transit'], // Left a branch or terminal on the way.
  ['직원 배송중', 'out_for_delivery'],
  ['배달완료', 'delivered'],
  ['미배달(인계)', 'in_transit'], // Handed over to another carrier, which delivers it.
  ['미배달(기타)', 'failed_attempt'], // Not delivered on the round, for another reason.
]);

/** The checkpoint codes seen with those labels. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['10', 'accepted'], // 발송사무소 인수
  ['20', 'in_transit'], // 배송경유지 도착
  ['40', 'in_transit'], // 배송경유지 출고
  ['50', 'out_for_delivery'], // 직원 배송중
  ['70', 'delivered'], // 배달완료
  ['88', 'failed_attempt'], // 미배달, with its reason in brackets; a hand-over is staged by its label.
]);

/**
 * The stage a scan's label gives, else its code. A not-delivered scan's
 * description adds its remark after a colon, which the label ends before.
 */
export function ilyangMappedStage(code: string | null, wording: string): Stage | undefined {
  const label = wording.split(':')[0]!.replace(/\s+/g, ' ').trim();
  return LABELS.get(label) ?? (code ? CODES.get(code) : undefined);
}

/**
 * A scan's stage from Ilyang Logis' own labels and codes, else nothing: the
 * shared wording rules read no Korean.
 */
export function ilyangStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = ilyangMappedStage(code, wording);
  return mapped ? { stage: mapped, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => ilyangMappedStage(code, wording),
  gaps: [],
};
