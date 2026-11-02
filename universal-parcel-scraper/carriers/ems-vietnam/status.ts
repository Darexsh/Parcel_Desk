import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The UPU EMS event codes the tracker puts before some scans' wording. Only
 * codes seen in replies are mapped; another code falls to the wording.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['EMA', 'accepted'], // Posting / Collection.
  ['EDG', 'out_for_delivery'], // Item out for physical delivery.
  ['EMH', 'failed_attempt'], // Attempted / Unsuccessful delivery.
  ['EMI', 'delivered'],
]);

/** The scans without a code, by their whole wording in `normalizeStatusWording` form. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['đã phân hướng lấy hàng (data out for pickup)', 'registered'], // A courier is assigned to collect the parcel.
  ['đang đi thu gom', 'registered'], // The courier is on the way to collect it.
  ['nhận hàng thành công (picked up)', 'accepted'],
  ['chấp nhận gửi', 'accepted'],
  ['đi khỏi bưu cục (departure from po)', 'in_transit'],
  ['đã vận chuyển đi khỏi bưu cục (transport departure from po)', 'in_transit'],
  ['đã đến bưu cục (arrival at po)', 'in_transit'],
  ['đã vận chuyển đến bưu cục (transport arrival at po)', 'in_transit'],
  ['xác nhận đến bưu gửi theo túi, arrival at po by postbag', 'in_transit'],
  ['đã đóng chuyến thư đi', 'in_transit'], // Closed into an outgoing mail bag.
  ['[bđ8]đã xác nhận đi', 'in_transit'],
  ['[bđ8]đã tới bưu cục nhận', 'in_transit'],
  ['đã xác nhận đến', 'in_transit'],
  ['đã giao cho bưu tá', 'out_for_delivery'],
  ['phát thành công', 'delivered'],
  ['đã phát thành công', 'delivered'],
]);

const NOTES: ReadonlyMap<string, string> = new Map([
  ['phát hành phiếu nhờ thu', 'The slip for a cash-on-delivery amount is issued at acceptance; it moves nothing.'],
  ['routed', 'The item joins a delivery round, with its out-for-delivery scan at the same minute; it moves nothing on its own.'],
  ['đã thu tiền khách hàng', 'The cash-on-delivery amount taken from the recipient, beside the delivery scan; it moves nothing.'],
  ['đã thu tiền bưu tá', 'The office takes the cash the postman collected, after the delivery; it moves nothing.'],
]);

/** The stage EMS Vietnam's own vocabulary gives a scan's code or wording. */
export function emsVietnamMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code.toUpperCase()) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording.normalize('NFC')));
}

/** A scan's stage: its code or wording, else the shared wording rules, else nothing. */
export function emsVietnamStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = emsVietnamMappedStage(code || null, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (!code && NOTES.has(normalizeStatusWording(wording.normalize('NFC')))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => emsVietnamMappedStage(code, wording),
  gaps: [...NOTES].map(([wording, note]) => ({ wording, note })),
};
