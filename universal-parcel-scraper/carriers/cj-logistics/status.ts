import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * CJ Logistics' scan codes (`crgStDcd`), which name the scan (`crgStDnm`).
 * Only codes seen in replies are mapped; another code falls to the wording
 * rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['11', 'accepted'], // 집화처리: picked up from the sender.
  ['21', 'in_transit'], // SM입고: received at the delivery camp; its detail line already reads as an arrival at the destination.
  ['41', 'in_transit'], // 간선상차: loaded on a trunk route between terminals.
  ['42', 'in_transit'], // 간선하차: unloaded at a hub or at the delivery terminal.
  ['43', 'in_transit'], // 소분류: sorted at a hub.
  ['44', 'in_transit'], // 간선상차 on the www.cjlogistics.com tracker: loaded at the hub towards the delivery area.
  ['58', 'in_transit'], // 권내출고: sent on within the area.
  ['61', 'in_transit'], // 오도착: arrived at the wrong terminal, which sends it on.
  ['62', 'in_transit'], // 미발송: a terminal held it back for a later trunk.
  ['63', 'in_transit'], // 미출고: a terminal postponed its release towards delivery.
  ['82', 'out_for_delivery'], // 배송출발, with the delivery time slot.
  ['84', 'failed_attempt'], // 미배송: the delivery branch did not deliver it on its round.
  ['91', 'delivered'], // 배송완료.
  ['R1', 'in_transit'], // 행낭포장: packed into a bag at a terminal.
  ['RMN', 'in_transit'], // HUB 도착 on the www.cjlogistics.com tracker.
]);

/** The stage CJ Logistics' codes give a scan code. */
export function cjMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function cjStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = cjMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? cjMappedStage(code) : undefined),
  gaps: [],
};
