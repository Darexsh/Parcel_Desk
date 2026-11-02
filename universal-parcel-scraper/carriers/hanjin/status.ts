import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * A wording without spaces or a closing full stop, in lower case: the tracker
 * spaces the same sentence differently from row to row ("배송출발 하였습니다",
 * "배송출발하였습니다") and wraps terminal names in bold.
 */
export function hanjinKey(wording: string): string {
  return wording.normalize('NFC').toLocaleLowerCase('ko-KR').replace(/\s+/g, '').replace(/\.+$/, '');
}

/**
 * The scans Hanjin's tracker writes, in Korean, with no code. Most name a
 * terminal or a flight inside the sentence, so they are matched as patterns.
 * Registration comes from the sender's data. A parcel taken in at a foreign
 * logistics centre or a Korean terminal is moving; so is one waiting for its
 * flight or ship, through customs, on its way between terminals, at the
 * delivery terminal and with the courier preparing the round. Unloading, the
 * customs list and arrival at the customs warehouse are customs; a completed
 * list check or import clearance puts the parcel back in transit. A
 * warehouse arrival can end in "(통관불가)"; the histories that show it go on
 * to a completed clearance minutes later, so it stays customs, not an
 * exception.
 */
const SCANS: readonly (readonly [RegExp, Stage])[] = [
  [/^운송장정보가등록되었습니다$/, 'registered'],
  [/^고객님상품을접수하였습니다$/, 'accepted'],
  [/^고객님상품을집하하여.+에입고되었습니다$/, 'in_transit'],
  [/^상품이물류센터에입고되었습니다$/, 'in_transit'],
  [/^.*(?:항공편|선편)으로출발대기중입니다$/, 'in_transit'],
  [/^수입통관장에반입되었습니다(?:\.?\(통관불가\))?$/, 'customs'],
  [/^하선신고가수리되었습니다$/, 'customs'],
  [/^통관목록이접수되었습니다$/, 'customs'],
  [/^목록통관심사가완료되었습니다$/, 'in_transit'],
  [/^수입통관이완료되어국내배송예정입니다$/, 'in_transit'],
  [/^.+에서.+로이동중입니다$/, 'in_transit'],
  [/^.+에도착하였습니다$/, 'in_transit'],
  [/^배송지점에도착하여배송을준비중입니다$/, 'in_transit'],
  [/^배송원이배송준비중입니다$/, 'in_transit'],
  [/^배송출발하였습니다$/, 'out_for_delivery'],
  [/^배송완료(?:되었|하였)습니다$/, 'delivered'],
];

/** The stage the map gives a scan's wording, if it knows it. */
export function hanjinScanStage(wording: string): Stage | undefined {
  const key = hanjinKey(wording);
  return SCANS.find(([pattern]) => pattern.test(key))?.[1];
}

/** A scan's stage from the map, else from the shared wording rules; wording neither knows stays without one. */
export function hanjinStage(wording: string): ClassifiedWording | null {
  const mapped = hanjinScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. The progress rail's labels never come as scans. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : hanjinScanStage(wording)),
  gaps: [],
};
