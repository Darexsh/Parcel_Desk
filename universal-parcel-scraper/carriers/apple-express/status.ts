import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Apple Express's status wordings, from its tracking API and its older SprintStar and
 * goapple pages. The reply gives a scan no code; another wording falls to the shared
 * wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The shipper sent the order; the parcel has not reached Apple Express.
  ['Waiting for Parcel', 'registered'],
  ['Electronic Order Request Received from Shipper', 'registered'],
  ['Order Created', 'registered'],
  // The first scan at the origin depot, before the line haul to another province.
  ['Package Processed', 'accepted'],
  ['In Transit', 'in_transit'],
  ['En Route to Destination Sort Facility', 'in_transit'],
  ['Package Arrived', 'in_transit'],
  ['Package Scanned', 'in_transit'],
  // At the delivering depot, before the round; the words "out for delivery" are a promise.
  ['Parcel Received, Out for Delivery Soon', 'in_transit'],
  ['In Transit to Local Sort Facility', 'in_transit'],
  ['Arrived at Local Sort Facility', 'in_transit'],
  ['Processed for Delivery', 'in_transit'],
  ['In Transit to Canada Sort Facility', 'in_transit'],
  ['Arrived at Canada Sort Facility', 'in_transit'],
  ['Out for Delivery', 'out_for_delivery'],
  ['Out for Delivery, second attempt', 'out_for_delivery'],
  ['Delivered', 'delivered'],
  ['Delivered - Left at door', 'delivered'],
  // The driver could not get into the building; the parcel goes out again.
  ['Exception - No Buzz Code', 'failed_attempt'],
  ['Return to Shipper', 'returned'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/**
 * Records of a message or a request, logged beside the scan they follow. They move
 * nothing, so they keep that scan's stage without being evidence of it.
 */
const NOTICES = [
  'Pending Delivery Notification Sent',
  'Delivery Notification Sent',
  'Delivery Exception Notification Sent',
  'Pickup notification email sent',
  'Delivery notification email sent',
  'Delivery Instructions Added',
] as const;
const NOTICE_KEYS: ReadonlySet<string> = new Set(NOTICES.map(normalizeStatusWording));

/**
 * The order's own state, by the names the page's script gives them, where the state
 * alone says more than the wording beside it: the page shows a cancelled order's
 * cancellation instead of its history.
 */
const SUMMARY_STATES: ReadonlyMap<number, Stage> = new Map([
  [7, 'exception'], // Cancelled
  [14, 'returned'], // ReturntoOrigin
  [29, 'exception'], // PackageLost
]);

/** The stage the map gives a status wording. */
export function appleExpressMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** Whether a row records a message or a request rather than a scan. */
export function isAppleExpressNotice(wording: string): boolean {
  return NOTICE_KEYS.has(normalizeStatusWording(wording));
}

/** The stage the order's state number gives on its own. */
export function appleExpressStateStage(state: number): Stage | undefined {
  return SUMMARY_STATES.get(state);
}

/** A status wording's stage: the map's, else the shared wording rules', else nothing. Notices have none. */
export function appleExpressStage(wording: string): ClassifiedWording | null {
  const mapped = appleExpressMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (isAppleExpressNotice(wording)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => appleExpressMappedStage(wording),
  gaps: NOTICES.map((wording) => ({
    wording: normalizeStatusWording(wording),
    note: 'A record of a message or a request, logged beside the scan it follows; it moves nothing.',
  })),
};
