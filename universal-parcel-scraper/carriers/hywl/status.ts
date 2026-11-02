import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The `status_code` Huiyi Logistics gives every row, in `normalizeStatusWording`
 * form. The page script shows `current_status` from the same vocabulary.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['picked up', 'accepted'],
  ['in transit', 'in_transit'],
  ['customs', 'customs'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

// The export clearance its `Customs` rows report as done: the parcel carries on.
const CLEARED = /\bcustoms clearance completed\b|清关完成/;

/** The stage of a row's code, read with its wording for the cleared customs rows. */
export function hywlMappedStage(code: string, wording: string): Stage | undefined {
  const stage = CODES.get(normalizeStatusWording(code));
  return stage === 'customs' && CLEARED.test(normalizeStatusWording(wording)) ? 'in_transit' : stage;
}

/** A row's stage: its code, else the shared wording rules, else nothing. */
export function hywlStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = hywlMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? hywlMappedStage(code, wording) : undefined,
  gaps: [],
};
