import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * GAASH's status codes, as its tracker's scans carry them. Only codes seen in
 * replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1001', 'in_transit'], // On the way to Israel.
  ['595', 'in_transit'], // Landed in Israel.
  ['3', 'customs'], // The import declaration was sent to customs.
  ['813', 'customs'], // Waiting for the Ministry of Transport's import approval.
  ['912', 'customs'], // Held until the transport check is paid for.
  ['849', 'customs'], // Held until the storage fee is paid.
  ['7', 'in_transit'], // Cleared by customs, so back in transit.
  ['25', 'in_transit'], // At the warehouse and given a pickup point.
  ['28', 'in_transit'], // On the way to the pickup point.
  ['15', 'ready_for_pickup'], // At the pickup point, which the page calls ready for collection.
  ['16', 'delivered'],
]);

/** The stage GAASH's codes give a scan code. */
export function gaashMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function gaashStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = gaashMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? gaashMappedStage(code) : undefined),
  gaps: [],
};
