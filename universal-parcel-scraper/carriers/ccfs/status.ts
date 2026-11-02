import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of a row of CCFS's shipment history, its `Status`. Rows carry
 * no code. The map covers the status descriptions CCFS publishes at
 * `www.ccfs.com/api/public/Service/StatusDescription` and the wording seen in
 * replies; other wording falls to the shared rules.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['order created', 'registered'],
  ['shipment info received', 'registered'],
  ['label printed', 'registered'],
  // The shipper's paperwork, scanned at the terminal before the freight's first dock scan.
  ['bill of lading scanned', 'registered'],
  ['driver arrived at shipper', 'registered'],
  ['pickup appointment made', 'registered'],
  // A pickup that did not happen: the freight is still at the shipper.
  ['pickup appointment attempted', 'registered'],
  ['pickup attempted', 'registered'],
  ['pickup missed without attempt', 'registered'],
  ['no freight to pick up', 'registered'],
  ['pickup on hold', 'exception'],
  ['pickup complete', 'accepted'],
  ['pickup completed', 'accepted'],
  ['picked up, but paperwork not available', 'accepted'],
  ['scanned on dock', 'in_transit'],
  ['freight on dock', 'in_transit'],
  ['linehaul departure', 'in_transit'],
  ['linehaul arrival', 'in_transit'],
  // Freight handed to an interline partner, or due from one.
  ['transferred to third-party carrier', 'in_transit'],
  ['awaiting transfer from third party carrier', 'in_transit'],
  ['driver arrived at consignee', 'out_for_delivery'],
  ['delivery completed', 'delivered'],
  ['delivered, but paperwork not available', 'delivered'],
  ['delivery was attempted', 'failed_attempt'],
  ['delivery appointment attempted', 'failed_attempt'],
  ['information required before next attempt', 'failed_attempt'],
  ['more information required before next attempt', 'failed_attempt'],
  ['refused by consignee', 'exception'],
  ['partially refused by consignee', 'exception'],
  ['refused freight being returned', 'returned'],
  ['damage recorded', 'exception'],
  ['osd research in progress', 'exception'],
  ['unknown freight, research in progress', 'exception'],
  ['customer service research required', 'exception'],
  ['cancelled', 'exception'],
]);

const GAP_GROUPS: readonly { readonly note: string; readonly wordings: readonly string[] }[] = [
  { note: 'A pickup or a delivery: the wording does not say which, so it moves nothing.',
    wordings: ['out for pickup or delivery', 'pickup or delivery planned', 'pickup or delivery scan', 'stop completed'] },
  { note: 'The driver left the shipper or the consignee, after a pickup or a delivery or after an attempt; it moves nothing.',
    wordings: ['driver departed from shipper', 'driver departed from consignee', 'departed from consignee'] },
  { note: 'A notice that the pickup, the shipment or the delivery is late, or that a delivery was not attempted; the freight stays where it was.',
    wordings: ['pickup running late', 'shipment running late', 'delivery running late', 'delivery not attempted'] },
  { note: 'A notification sent to a customer; the row of the event it reports carries the stage.',
    wordings: ['pickup request notification sent', 'pickup notification sent', 'order entry notification sent',
      'delivery notification sent', 'delivery attempt notification sent', 'route status notification sent',
      'refusal notification sent', 'cancelation notification sent', 'proof of delivery notification sent'] },
  { note: 'Paperwork, measurement, billing or a record of the office; it moves nothing.',
    wordings: ['quote recorded', 'edi data transferred', 'freight bill printed', 'delivery receipt printed',
      'created delivery record', 'temporary record cancelled', 'freight dimensions measured', 'reweighed',
      'dimensional weight applied', 'proof of delivery scanned', 'approved for billing', 'billing on hold',
      'billing complete'] },
  { note: 'Freight available for pickup, by CCFS from the shipper or by the consignee at a terminal: the wording does not say which.',
    wordings: ['available for pickup'] },
  { note: 'A delivery appointment, being arranged or made; it can come at any point and moves nothing.',
    wordings: ['delivery appointment made',
      'residential appointment: apointment has been set up and confirmed',
      'residential appointment: appointment has been set up and will be confirmed shortly',
      'residential appointment: approval is required before an invitation can be sent',
      'residential appointment: invitation approved and will be sent shortly',
      'residential appointment: invitation has been sent to the consignee\'s cell phone',
      'residential appointment: nsr has been set up and will be confirmed shortly',
      'residential appointment: phone call required',
      'residential appointment: phone number is missing or invalid'] },
];
const GAPS: ReadonlySet<string> = new Set(GAP_GROUPS.flatMap((group) => group.wordings));

/** The stage the map gives CCFS's wording, if it knows it. */
export function ccfsMappedStage(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording));
}

/** A row's stage: the map, else nothing for a gap, else the shared wording rules, else nothing. */
export function ccfsStage(wording: string): ClassifiedWording | null {
  const mapped = ccfsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAPS.has(normalizeStatusWording(wording))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : ccfsMappedStage(wording)),
  gaps: GAP_GROUPS.flatMap(({ note, wordings }) => wordings.map((wording) => ({ wording, note }))),
};
