import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// The public tracking client's operation types. Its progress-bar default is
// DEPARTURE for unknown types, which is not enough evidence to stage a scan.
const CODES = new Map<string, Stage>([
  ['ORDER', 'registered'], ['HAS_BILLING', 'registered'], ['GOT', 'accepted'], ['PU_PICKUP_SUCCESS', 'accepted'],
  ['LH_DEPART', 'in_transit'], ['LH_ARRIVE', 'in_transit'], ['ZH_ARRIVAL', 'in_transit'], ['ZH_DEPARTURE', 'in_transit'],
  ['DEPARTURE', 'in_transit'], ['ARRIVAL', 'in_transit'], ['COMPLETEEXPORTCLEAR', 'in_transit'], ['CC_IM_SUCCESS', 'in_transit'],
  ['IMPORT_CLEARANCE', 'customs'], ['EXPORT_CLEARANCE', 'customs'], ['CUSTOMS_INSPECTION', 'customs'], ['ARRIVAL_CLEARANCE', 'customs'],
  ['SENT_SCAN', 'out_for_delivery'], ['DRAWOUT', 'out_for_delivery'], ['DELIVER_STORE', 'out_for_delivery'],
  ['SIGN', 'delivered'], ['SIGNED', 'delivered'], ['STA_SIGN', 'delivered'], ['ALREADY_SIGN', 'delivered'], ['CONFIRM_SIGNED', 'delivered'],
  ['ALREADY_CANCELLED', 'exception'],
]);

export function depponStage(code: string, wording: string): ClassifiedWording | null {
  const stage = CODES.get(code);
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(wording, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

export const statusMap: CarrierStatusMap = { stage: code => code ? CODES.get(code) : undefined, gaps: [] };
