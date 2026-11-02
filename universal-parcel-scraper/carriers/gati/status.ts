import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Gati's milestone codes, which come with each scan. The reply pairs most with
 * a milestone, M1 at booking to M8 at delivery, and the hub scans between with
 * none. Only codes seen in replies are mapped; another code falls to the
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // Booked at the pickup branch, which the page calls the pickup: Gati books a docket when it takes the goods.
  ['DCRE', 'accepted'],
  ['TCSOU', 'in_transit'], // Departed from the booking branch.
  ['TCAER', 'in_transit'], // Received at a branch or transhipment centre.
  ['TCSEO', 'in_transit'], // Sent on to the next location, which the wording names.
  ['DKTAD', 'in_transit'], // Arrived at the delivery branch.
  ['DPDCC', 'out_for_delivery'],
  ['DUNDL', 'failed_attempt'], // Undelivered, with the reason; the docket goes out again.
  // Some of the docket's packages were delivered; the rest are still on their way.
  ['DDPVD', 'in_transit'],
  ['DDLVD', 'delivered'],
  ['DDETN', 'exception'], // The docket is held, as after a missed connection.
]);

/** The stage Gati's milestone codes give a scan code. */
export function gatiMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function gatiStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = gatiMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? gatiMappedStage(code) : undefined),
  gaps: [],
};
