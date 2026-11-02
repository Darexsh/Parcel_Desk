import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// EDIFACT groups used by the official consumer tracking client. Pickup requests
// are pre-advice; they do not establish that NZ Post has collected the parcel.
const CODES: Record<string, ClassifiedStatus> = {
  '997': { status: 'pending', stage: 'registered' },
  '205': { status: 'pending', stage: 'registered' },
  '206': { status: 'pending', stage: 'registered' },
  '13': { status: 'in_transit', stage: 'accepted' },
  '8': { status: 'in_transit', stage: 'in_transit' },
  '58': { status: 'in_transit', stage: 'in_transit' },
  '40': { status: 'exception', stage: 'exception' },
};
const DELIVERED = new Set(['22', '5022', '6033', '5207', '4014']);
const DELIVERY = new Set(['5322', '32', '35', '5045', '5323', '6032', '6035']);
const ATTEMPTED = new Set(['42', '50', '51', '52', '53', '62', '63', '5021', '5312', '5313',
  '5314', '5315', '5316', '5317', '5318', '5319', '5320', '4003', '6019', '6048']);
const COLLECTION = new Set(['141', '6003', '5351', '99', '1099', '2099']);
// International mail codes. A release from the border agency resumes transit;
// 144 hands a carded parcel over before it is ready for collection.
const REGISTERED = new Set(['5303', '6908']);
const MOVEMENT = new Set(['144', '591', '595', '5002', '5007', '5015', '5017', '5020', '5023', '5041', '5042',
  '5064', '5199', '5213', '5280', '5282', '5283', '5284', '5285', '5292', '5360', '6025', '6028', '6049',
  '6054', '6063', '6068', '6069', '6071']);
const BORDER = new Set(['5016', '5019', '5057']);

export function classifyNzPostStatus(code: string): ClassifiedStatus | undefined {
  if (Object.hasOwn(CODES, code)) return CODES[code];
  if (DELIVERED.has(code)) return { status: 'delivered', stage: 'delivered' };
  if (DELIVERY.has(code)) return { status: 'out_for_delivery', stage: 'out_for_delivery' };
  if (ATTEMPTED.has(code)) return { status: 'exception', stage: 'exception' };
  if (COLLECTION.has(code)) return { status: 'in_transit', stage: 'ready_for_pickup' };
  if (REGISTERED.has(code)) return { status: 'pending', stage: 'registered' };
  if (code === '5000') return { status: 'in_transit', stage: 'accepted' };
  if (MOVEMENT.has(code)) return { status: 'in_transit', stage: 'in_transit' };
  if (BORDER.has(code)) return { status: 'in_transit', stage: 'customs' };
  return undefined;
}

/** What the map says about one scan: its EDIFACT code, which alone stages it. */
export const statusMap: CarrierStatusMap = { stage: (code) => (code ? classifyNzPostStatus(code)?.stage : undefined), gaps: [] };
