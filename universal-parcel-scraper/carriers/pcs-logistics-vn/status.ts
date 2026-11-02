import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** PCS's scan codes (`STATUS_ID`). Only the code seen in replies is mapped. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['12', 'delivered'],
]);

/**
 * The statuses PCS's customer portal names in English and Vietnamese, the
 * languages the reply's `STATUS_VN` comes in. Another wording falls to the
 * shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['order created', 'registered'],
  ['tạo đơn hàng thành công', 'registered'],
  // A courier is on the way to collect the parcel; nothing has moved yet.
  ['picking up', 'registered'],
  ['đang lấy hàng', 'registered'],
  ['picked up', 'accepted'],
  ['đã lấy hàng', 'accepted'],
  ['with delivery courier', 'out_for_delivery'],
  ['đang đi phát hàng', 'out_for_delivery'],
  ['shipment delivered', 'delivered'],
  ['đã phát hàng cho người nhận', 'delivered'],
  ['配達完了', 'delivered'],
  ['returning', 'returned'],
  ['đang hoàn hàng', 'returned'],
  ['return successfully', 'returned'],
  ['hoàn thành công', 'returned'],
  ['order cancelled', 'exception'],
  ['hủy đơn', 'exception'],
]);

/** The stage PCS's map gives a code, else a wording in `normalizeStatusWording` form. */
export function pcsMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code) : undefined) ?? WORDINGS.get(wording.normalize('NFC'));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function pcsStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = pcsMappedStage(code || null, normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (!wording) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every code and wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => pcsMappedStage(code, wording),
  gaps: [],
};
