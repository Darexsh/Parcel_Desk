import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Bookurier files every scan, its own and its partners', under one of its
 * own codes, the group the tracker shows it in. Only codes seen in replies
 * are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['order_placed', 'registered'], // "Comandă plasată": a new order, or a partner registering the parcel.
  ['in_transit', 'in_transit'],
  ['out_for_delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/**
 * Wordings that settle a scan before its code. "Repartizata", the order
 * assigned to a courier, comes under `out_for_delivery`, but the partner's
 * registration scan follows it hours later and the earlier tracker worded
 * it "Coletul a fost repartizat curier": nothing has moved yet. The others
 * are the earlier tracker's, for a waybill or a pickup still to come.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['repartizata', 'registered'],
  ['coletul a fost repartizat curier', 'registered'],
  ['awb emis', 'registered'],
  ['anunta pentru ridicare', 'registered'],
  ['s-a solicitat ridicarea coletului', 'registered'],
]);

/** The stage a scan's wording or Bookurier's code gives it. */
export function bookurierMappedStage(code: string, wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording)) ?? CODES.get(code.toLowerCase());
}

/** A scan's stage: its wording or code, else the shared wording rules, else nothing. */
export function bookurierStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = bookurierMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => bookurierMappedStage(code ?? '', wording),
  gaps: [],
};
