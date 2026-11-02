import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// The official portal's statusCodes.json describes both regional code sets.
// Its presentation TYPE can label pickup as Created and damage or handoff as Delivered.
// Classification follows the milestone description instead. NFRP is the handoff:
// the table and the page call it Delivered, but its description says the order
// went to another carrier, which the reply does not name. Like other carriers'
// handoffs, it is in transit.
const stages: Record<string, ClassifiedStatus> = {};
function add(codes: string[], status: ClassifiedStatus['status'], stage: ClassifiedStatus['stage']) {
  for (const code of codes) stages[code] = { status, stage };
}
add(['XX', 'OVRC', 'AUTO', 'EXRL', 'INRL'], 'pending', 'registered');
add(['PKUP', 'PU', 'RL', 'ALPK'], 'in_transit', 'accepted');
add(['ARRD', 'ORIG', 'RCVD', 'OS', 'FCTF', 'SFCT', 'LOAD', 'NFRP'], 'in_transit', 'in_transit');
add(['OFDL', 'OD'], 'out_for_delivery', 'out_for_delivery');
add(['BCLD', 'UTLV', 'NH', 'ACSS', 'NDMI', 'RFDM'], 'exception', 'failed_attempt');
add(['DN', 'DLVD', 'CL', 'DM', 'DW', 'OK', 'DD'], 'delivered', 'delivered');
add(['RETD', 'RETN', 'RS'], 'exception', 'returned');
add(['LOST', 'MSPK', 'UD', 'ONHD'], 'exception', 'exception');

export function classifyOntracStatus(code: string): ClassifiedStatus | undefined {
  return stages[code];
}

/** What the map says about one scan: its event code, which alone stages it. */
export const statusMap: CarrierStatusMap = { stage: (code) => (code ? classifyOntracStatus(code)?.stage : undefined), gaps: [] };
