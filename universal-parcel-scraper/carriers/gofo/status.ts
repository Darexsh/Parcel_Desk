import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const CODES = new Map<string, ClassifiedStatus>([
  ['100', { status: 'pending', stage: 'registered' }],
  // The label voided after it was created: no parcel is coming under the number.
  ['101', { status: 'exception', stage: 'exception' }],
  // A pickup exception: GOFO has not received the parcel from the sender's warehouse yet.
  ['802', { status: 'pending', stage: 'registered' }],
  // GOFO's driver has set out to collect the parcel from the sender, then has it.
  ['216', { status: 'pending', stage: 'registered' }],
  ['801', { status: 'in_transit', stage: 'accepted' }],
  ...['200', '201', '202', '203', '411', '412', '414', '612', '810', '820'].map(code => [code, { status: 'in_transit', stage: 'in_transit' }] as [string, ClassifiedStatus]),
  ['208', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  // A delivery attempt that failed, whatever reason follows the comma.
  ['206', { status: 'exception', stage: 'failed_attempt' }],
  ['205', { status: 'delivered', stage: 'delivered' }],
]);

// GOFO's first physical scan after the label: 202 also names later hubs on the way.
const ORIGIN_HUB = /^arrived at gofo regional origin hub$/i;

export function gofoStatus(code: string, wording = ''): ClassifiedStatus | undefined {
  return code === '202' && ORIGIN_HUB.test(wording.trim()) ? { status: 'in_transit', stage: 'accepted' } : CODES.get(code);
}

/** By code; the parser refuses a delivery code whose wording is not a delivery. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const stage = code ? gofoStatus(code, wording)?.stage : undefined;
    return stage === 'delivered' && !/^delivered(?:,|$)/.test(wording) ? undefined : stage;
  },
  gaps: [],
};
