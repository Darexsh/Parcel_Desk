import { languageStageStatus, type ClassifiedStatus, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap, IntentionalStatusGap } from '../../core/status/statusMap.js';

/**
 * The summary's status codes, as XPO's shipment status definitions page lists
 * them. Delays, appointments, holds at a service center and a return to the
 * dock without an attempt keep the freight in transit. "Awaiting unloading at
 * consignee" comes at the recipient's site, before the delivery. A partial
 * delivery is a delivery; its shortage shows as an exception on the page.
 */
const SUMMARY: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['1', 'accepted'],
  ['2', 'in_transit'],
  ['3', 'in_transit'],
  ['4', 'in_transit'],
  ['5', 'in_transit'],
  ['6', 'in_transit'],
  ['7', 'in_transit'],
  ['8', 'out_for_delivery'],
  ['10', 'in_transit'],
  ['11', 'customs'],
  ['12', 'exception'],
  ['13', 'in_transit'],
  ['14', 'in_transit'],
  ['15', 'exception'],
  ['17', 'in_transit'],
  ['18', 'out_for_delivery'],
  ['19', 'failed_attempt'],
  ['20', 'delivered'],
  ['21', 'exception'],
  ['22', 'exception'],
  ['23', 'delivered'],
  ['25', 'accepted'],
  ['26', 'exception'],
  ['27', 'exception'],
  ['28', 'delivered'],
  ['29', 'in_transit'],
  ['32', 'registered'],
  ['33', 'in_transit'],
  ['36', 'in_transit'],
  ['37', 'in_transit'],
  ['38', 'in_transit'],
  ['39', 'in_transit'],
  ['40', 'in_transit'],
  ['41', 'in_transit'],
  ['42', 'in_transit'],
  ['43', 'in_transit'],
  ['44', 'in_transit'],
]);

/** Summary codes that say nothing about where the freight is: the scans decide. */
const SUMMARY_GAPS: readonly IntentionalStatusGap[] = [
  { code: '24', note: 'The parent of a shipment split over several trailers; its children carry the movement.' },
  { code: '30', note: 'A notice that the delivery receipt image can be viewed; the scans give the stage.' },
  { code: '31', note: 'A notice that the bill of lading image can be viewed; the scans give the stage.' },
  { code: '34', note: 'A follow-up to a possible delay notification; the scans give the stage.' },
  { code: '35', note: 'A follow-up to a possible delay notification; the scans give the stage.' },
];

// A service center's code, as the history names origins, destinations and terminals.
const SIC = '[A-Z0-9]{3}';

/**
 * History descriptions, matched whole once the delivery route is cut off.
 * A bill of lading sent online comes before the pickup. Dock, trailer and
 * linehaul scans are movement between service centers. A trap trailer holds
 * freight at the destination for a later delivery. The pickup-and-delivery
 * run and the arrival at the customer come before the final delivery.
 */
const EVENTS: readonly (readonly [RegExp, Stage])[] = [
  [/^BOL received from web$/i, 'registered'],
  [new RegExp(`^Reported picked up from ${SIC}$`, 'i'), 'accepted'],
  [/^City arrived$/i, 'in_transit'],
  [/^Unloading at dock$/i, 'in_transit'],
  [/^Unloaded from trailer$/i, 'in_transit'],
  [/^Staged to dock location$/i, 'in_transit'],
  [/^Loaded on trailer$/i, 'in_transit'],
  [new RegExp(`^Closed to ${SIC}$`, 'i'), 'in_transit'],
  [/^Closed for delivery$/i, 'in_transit'],
  [new RegExp(`^Schedule (?:departed|arrived) from ${SIC} to ${SIC}$`, 'i'), 'in_transit'],
  [/^Designated as Trap Trailer$/i, 'in_transit'],
  [new RegExp(`^Held on trap trailer - .{1,120}from ${SIC}$`, 'i'), 'in_transit'],
  [/^City loading at dock$/i, 'in_transit'],
  [new RegExp(`^Out for delivery from ${SIC}$`, 'i'), 'out_for_delivery'],
  [/^Dispatched on P&D run$/i, 'out_for_delivery'],
  [/^Arrived at Customer$/i, 'out_for_delivery'],
  [new RegExp(`^Final delivered from ${SIC}$`, 'i'), 'delivered'],
];

/** The stage of a summary status code, or undefined for a notice or a code outside XPO's list. */
export function xpoLtlSummaryStatus(code: string): ClassifiedStatus | undefined {
  const stage = SUMMARY.get(code);
  return stage ? { status: languageStageStatus(stage), stage } : undefined;
}

/** A history description's stage from the rows XPO writes; other wording is left to the shared rules. */
export function xpoLtlEventStage(description: string): Stage | undefined {
  const text = description.replace(/\s+/g, ' ').trim();
  return EVENTS.find(([pattern]) => pattern.test(text))?.[1];
}

/**
 * What the map says about one status: a summary status by its code, a
 * history row, which carries none, by its wording.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? SUMMARY.get(code) : xpoLtlEventStage(wording)),
  gaps: SUMMARY_GAPS,
};
