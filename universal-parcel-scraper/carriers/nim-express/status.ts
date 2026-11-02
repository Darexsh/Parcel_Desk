import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings of the tracking page's timeline, which carry no code, by their
 * form without the bill number, the pickup day and window or the delivery
 * round. The wordings seen on the tracker are mapped, with those the status
 * mapping of an earlier version of the page lists. Another wording falls to
 * the shared rules.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map([
  ['ผู้ส่งสร้างบิลเข้าระบบ tracking no. [number]', 'registered'], // The sender created the bill.
  ['สร้างบิลเข้าระบบ tracking no. [number]', 'registered'], // The bill was created, at a drop point for instance.
  ['ยืนยันเข้ารับ วันที่ [date] [time] - [time]', 'registered'], // A pickup was booked for that day and window.
  ['nim express กำลังเข้ารับพัสดุ', 'registered'], // A courier is on the way to pick the parcel up.
  ['nim express เข้ารับพัสดุเรียบร้อยแล้ว', 'accepted'], // The courier picked the parcel up.
  ['รับพัสดุเข้า', 'accepted'], // The origin branch took the parcel in.
  ['พัสดุออกจากต้นทาง', 'in_transit'], // Left the origin branch.
  ['พัสดุถึงศูนย์คัดแยก', 'in_transit'], // Arrived at a sorting centre.
  ['พัสดุออกจากศูนย์คัดแยก', 'in_transit'], // Left a sorting centre.
  ['พัสดุถึงสาขาปลายทาง', 'in_transit'], // Arrived at the destination branch.
  ['อยู่ระหว่างจัดส่ง ครั้งที่ [attempt]', 'out_for_delivery'], // Out for delivery, the given round.
  ['จัดส่งสำเร็จ', 'delivered'],
  // An earlier version of the page.
  ['สร้างบิลขนส่งสินค้าเข้าระบบ', 'registered'],
  ['สินค้าออกจาก dc ต้นทาง', 'in_transit'],
  ['สินค้าถึง dc ปลายทาง', 'in_transit'],
  ['นำสินค้าขึ้นรถเพื่อกระจายสินค้า', 'out_for_delivery'],
  ['สินค้าอยู่ในระหว่างการจัดส่ง', 'out_for_delivery'],
  ['ลูกค้ามารับที่ dc', 'delivered'],
  ['สินค้าจัดส่งถึงมือผู้รับปลายทางเรียบร้อยแล้ว', 'delivered'],
  ['บันทึกผลการจัดส่งจาก smart phone จัดส่งถึงมือผู้รับปลายทางเรียบร้อยแล้ว', 'delivered'],
  ['สินค้าจัดส่งไม่ได้', 'failed_attempt'],
  ['บันทึกผลการจัดส่งจาก smart phone ส่งไม่ได้', 'failed_attempt'],
]);

/** A wording in the form the map keys it on: lower case, single spaces, and placeholders for its variable parts. */
function labelKey(wording: string): string {
  return wording.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim()
    .replace(/(tracking no\.) ?[a-z0-9]{1,40}$/, '$1 [number]')
    .replace(/\d{2}\/\d{2}\/\d{4}/g, '[date]')
    .replace(/\d{2}:\d{2}/g, '[time]')
    .replace(/(ครั้งที่) ?\d{1,3}$/, '$1 [attempt]');
}

/** The stage Nim Express's wordings give a scan, if the map knows it. */
export function nimExpressMappedStage(wording: string): Stage | undefined {
  return LABELS.get(labelKey(wording));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function nimExpressStage(wording: string): ClassifiedWording | null {
  const mapped = nimExpressMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : nimExpressMappedStage(wording)),
  gaps: [],
};
