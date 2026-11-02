import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event numbers Airpak's tracker tags each scan with. Only numbers seen
 * in replies are mapped; another number falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'delivered'],
  ['2', 'accepted'], // Collection: picked up from the sender.
  ['3', 'in_transit'], // Uplift: sent on to the next station.
  ['4', 'in_transit'], // Arrived Hub.
  ['15', 'out_for_delivery'],
  ['18', 'failed_attempt'], // Not Delivered - Noone available/home.
  ['38', 'failed_attempt'], // Not Delivered - Courier Out of Time: the round ended first, and the parcel went out again.
  ['43', 'failed_attempt'], // Not Delivered - Unable to Locate consignee.
  ['50', 'ready_for_pickup'], // Awaiting Pickup by Consignee.
  ['90', 'registered'], // Documentation Prepared, before the collection.
  ['91', 'registered'], // Shipment Finalised, before the collection.
  ['162', 'in_transit'], // In Transit - Loaded to Transit Vehicle/Aircraft.
]);

/** The stage Airpak's event numbers give a scan. */
export function airpakMappedStage(code: string): Stage | undefined {
  return CODES.get(code.trim());
}

const GAPS: CarrierStatusMap['gaps'] = [
  { code: '19', note: 'Held in Depot, seen at the delivering depot between failed attempts and before a collection by the recipient. It names no problem, so it moves nothing.' },
];
const UNSTAGED = new Set(GAPS.map((gap) => gap.code));

/** A scan's stage: its event number, else the shared wording rules, else nothing. */
export function airpakStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = airpakMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNSTAGED.has(code.trim())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? airpakMappedStage(code) : undefined),
  gaps: GAPS,
};
