import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event numbers SkyNet's tracker tags each scan with. Only numbers seen
 * in replies are mapped; another number falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'delivered'],
  ['2', 'accepted'], // Collection: picked up from the sender.
  ['3', 'in_transit'], // In Transit to Destination.
  ['4', 'in_transit'], // Arrived Hub.
  ['10', 'customs'], // On Hold - Customs - Awaiting Customs Clearance.
  ['14', 'in_transit'], // Delayed Linehaul Departure: it waits for the next departure.
  ['15', 'out_for_delivery'],
  ['18', 'failed_attempt'], // Attempted Delivery - No One Available/Home.
  ['23', 'in_transit'], // Sorted to Destination.
  ['37', 'in_transit'], // Released from Customs.
  ['53', 'failed_attempt'], // Attempted Delivery - Unable to Deliver - Please Contact Customer Services.
  ['85', 'exception'], // On Hold - Delivery Needs To Be (Re)Scheduled For/With Consignee.
  ['262', 'in_transit'], // Scheduled for Delivery, at the delivering station.
]);

/** The stage SkyNet's event numbers give a scan. */
export function skynetMappedStage(code: string): Stage | undefined {
  return CODES.get(code.trim());
}

const HOLD = 'A hold at a branch. The histories seen show it at the origin before the parcel moved on, and it names no problem, so it moves nothing.';
const NOTICE = 'A message sent to the recipient; it moves nothing.';
const GAPS: CarrierStatusMap['gaps'] = [
  { code: '19', note: HOLD },
  { code: '124', note: HOLD },
  { code: '45', note: 'Shipment Returned to Sending Station, seen at the destination after a failed attempt and before the delivery: the parcel went back to the depot. The wording also fits a return to the origin, so it moves nothing.' },
  { code: '148', note: NOTICE },
  { code: '149', note: NOTICE },
];
const UNSTAGED = new Set(GAPS.map((gap) => gap.code));

/** A scan's stage: its event number, else the shared wording rules, else nothing. */
export function skynetStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = skynetMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNSTAGED.has(code.trim())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? skynetMappedStage(code) : undefined),
  gaps: GAPS,
};
