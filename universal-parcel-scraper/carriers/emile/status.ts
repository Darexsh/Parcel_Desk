import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// One vocabulary serves direct tracking and scans a provider files under
// Emile's name. Neutral fees and notices keep a parcel's preceding milestone.
const STAGES = new Map<string, Stage>(statuses.entries.map(entry =>
  [normalizeStatusWording(entry.wording), (entry.stage ?? 'pending') as Stage]));

export function emileStage(label: string): Stage | undefined {
  const wording = normalizeStatusWording(label);
  if (/^waybill generated for [a-z0-9]+$/.test(wording)) return 'registered';
  return STAGES.get(wording);
}

/** The stage of one Emile status text a provider relays, with its wording unchanged. */
export function emileScan(label: string): { stage: Stage; wording: string } | undefined {
  const stage = emileStage(label);
  return stage && { stage, wording: label };
}

// track_point_code identifies an operation; status_number is only its position
// in this shipment's history. Wording distinguishes delivery from a return.
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => emileStage(wording),
  gaps: [],
};
