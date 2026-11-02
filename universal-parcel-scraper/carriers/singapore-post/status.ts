import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const CODES = new Map<string, ClassifiedStatus>([
  ['HC', { status: 'in_transit', stage: 'customs' }],
  ['DGS', { status: 'in_transit', stage: 'customs' }],
  ['CS', { status: 'in_transit', stage: 'customs' }],
  ['HE', { status: 'in_transit', stage: 'in_transit' }],
  ['LL', { status: 'in_transit', stage: 'in_transit' }],
  ['AD', { status: 'in_transit', stage: 'in_transit' }],
  ['DA', { status: 'in_transit', stage: 'in_transit' }],
  ['DO', { status: 'in_transit', stage: 'in_transit' }],
  ['PO', { status: 'in_transit', stage: 'accepted' }],
  ['PL', { status: 'in_transit', stage: 'in_transit' }],
  ['DP', { status: 'in_transit', stage: 'accepted' }],
  ['HQ', { status: 'in_transit', stage: 'in_transit' }],
  ['IR', { status: 'pending', stage: 'registered' }],
  ['AL', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['UA', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['FD', { status: 'delivered', stage: 'delivered' }],
]);

export function singaporePostStatus(code: string): ClassifiedStatus | undefined {
  return CODES.get(code);
}

/** What the map says about one scan: its event code, as the adapter stores it. */
export const statusMap: CarrierStatusMap = { stage: (code) => (code ? singaporePostStatus(code)?.stage : undefined), gaps: [] };
