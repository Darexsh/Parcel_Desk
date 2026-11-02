import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * PHLPost's scan wordings, mapped whole. The tracker joins two systems: IPS,
 * with the UPU event names its offices and the posts abroad record, and the
 * domestic delivery system. Both number their events, and the same number can
 * name different events in each ("3" is an arrival at the outward office of
 * exchange in IPS and a customs data import too), so the wording sets the stage.
 */
export const PHLPOST_EVENTS: Readonly<Record<string, Stage>> = {
  // IPS.
  'Posting of item': 'accepted',
  // The item's customs declaration reached IPS as data; nothing handled the item.
  'Data Import for CN documents': 'registered',
  'Enroute to next office': 'in_transit',
  'Receive item at origin country gateway': 'in_transit',
  'Item sent to office of exchange': 'in_transit',
  'Dispatch item to destination country': 'in_transit',
  'Dispatch to country of destination': 'in_transit',
  'Receive at country of destination': 'in_transit',
  'Send item to customs': 'customs',
  'Item for customs examination': 'customs',
  // Customs released the item into the post's network; it is not a return to the sender.
  'Returned from customs': 'in_transit',
  'Item sent to provincial': 'in_transit',
  'Item arrived at provincial office': 'in_transit',
  'Turnover item in next office': 'in_transit',
  'Enroute to delivery office': 'in_transit',
  // Letter carriers take the item out from here; it does not wait for collection.
  'Receive item at delivery office': 'in_transit',
  'Received item at delivery office': 'in_transit',
  'Letter Carrier enroute to delivery': 'out_for_delivery',
  'Item delivered': 'delivered',
  // The domestic delivery system.
  'Item posted at acceptance Post Office': 'accepted',
  'Item sent to delivery office': 'in_transit',
  'Item arrived at delivery office': 'in_transit',
  'Item out for delivery': 'out_for_delivery',
};

const EVENTS = new Map(Object.entries(PHLPOST_EVENTS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
// Both systems give the reason after the event: "Unsuccessful delivery - REASON: Unclaimed",
// "Unsuccessful delivery (REASON: Addressee not available)".
const UNSUCCESSFUL = /^unsuccessful delivery\b/;

/** The stage the map gives a scan's wording, if it knows it. */
export function phlpostEventStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return EVENTS.get(key) ?? (UNSUCCESSFUL.test(key) ? 'failed_attempt' : undefined);
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function phlpostStage(wording: string): ClassifiedWording | null {
  const mapped = phlpostEventStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The wording sets the stage whatever its code; PHLPost's map leaves nothing out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => phlpostEventStage(wording),
  gaps: [],
};
