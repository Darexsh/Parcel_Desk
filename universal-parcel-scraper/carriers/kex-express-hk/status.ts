import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * A scan's wording as the map keys it: parcels from before the rename keep
 * their Kerry Express wording, and some lines end with a full stop.
 */
function key(wording: string): string {
  return normalizeStatusWording(wording).replace(/kerry express/g, 'kex express').replace(/[.。]$/, '');
}

/**
 * The tracker's scan wordings, in English and Chinese. The page gives no code;
 * other wordings fall to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The sender booked the parcel and has not handed it over.
  ['KEX Express has received the order information. The package is not yet received by KEX Express.', 'registered'],
  ['KEX Express已收到運單資訊，正等待寄件人轉交快件給KEX Express', 'registered'],
  ['Shipment arrived at KEX Express sortation hub', 'in_transit'],
  ['快件已到達KEX Express分揀中心', 'in_transit'],
  ['Sortation is completed, preparing for delivery', 'in_transit'],
  ['Shipment is on the way of delivery', 'out_for_delivery'],
  ['快件已被快遞員提取，正在派送中', 'out_for_delivery'],
  ['Shipment is delivered. Thank you for using KEX Express', 'delivered'],
  ['派送完成，多謝使用KEX Express', 'delivered'],
] as const).map(([wording, stage]) => [key(wording), stage]));

/** The stage the map gives a scan's wording. */
export function kexHkMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

/** A scan's stage: the map's, else the shared wording rules', else nothing. */
export function kexHkStage(wording: string): ClassifiedWording | null {
  const mapped = kexHkMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => kexHkMappedStage(wording),
  gaps: [],
};
