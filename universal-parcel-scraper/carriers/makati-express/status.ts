import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's rows carry no code, only an activity in capitals, picked from
 * a list each branch's system keeps. Those seen in replies are mapped; other
 * wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['AWB CREATED', 'registered'], // The air waybill entered; the next row moves the box to the hub.
  ['AIRWAY BILL CREATED, SHIPMENT MOVED TO MAKATI HUB', 'accepted'],
  ['SHIPMENT MOVED TO MAKATI HUB', 'accepted'], // The box reached the sending branch's hub.
  ['SHIPMENT LOADED IN THE CONTAINER', 'in_transit'],
  // After the container is loaded, so the container's move, not the box's collection.
  ['BOX PICKUP/MOVED TO WAREHOUSE', 'in_transit'],
  ['AWB DOCUMENTATION', 'in_transit'], // Export paperwork for the container.
  ['DOCUMENTATION DONE/AWAITING SHIPMENT LOADING', 'in_transit'],
  // The shared rules read a hand-over as the sender's; this is the loaded container's.
  ['CONTAINER HANDED OVER TO JEBEL ALI PORT', 'in_transit'],
  ['ACTUAL DEPARTURE', 'in_transit'],
  ['SHIPMENT HANDED OVER TO THE AIRLINES', 'in_transit'],
  ['DEPARTURE DATE', 'in_transit'], // The air cargo's flight, on the day it left.
  ['RECEIVED BY MEC CAVITE BRANCH', 'in_transit'], // At the Philippine branch that delivers it.
  ['RECEIVED BY MAKATI EXPRESS CARGO (CAVITE OFFICE)', 'in_transit'],
  ['OUT FOR DELIVERY', 'out_for_delivery'],
  ['BOX DELIVERED', 'delivered'],
  ['DELIVERED', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/**
 * A departure or arrival still to come, such as `ESTIMATED DEPARTURE` or
 * `EXPECTED ARRIVAL AT MANILA PORT`, which the branch enters with the day it
 * expects: a forecast, not a scan.
 */
export const MAKATI_EXPRESS_FORECAST = /^(?:ESTIMATED|EXPECTED)\b/i;

/** The stage the map gives an activity. */
export function makatiExpressMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** An activity's stage: the map, else the shared wording rules, else nothing. */
export function makatiExpressStage(wording: string): ClassifiedWording | null {
  const mapped = makatiExpressMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => makatiExpressMappedStage(wording),
  gaps: [],
};
