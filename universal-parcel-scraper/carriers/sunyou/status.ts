/**
 * SunYou status vocabulary.
 *
 * The tracking endpoint returns one numeric `displayStatus` per shipment and
 * an `eventCode` on each scan. `0` is not in the display map: it is SunYou's
 * explicit "no such shipment" and the adapter turns it into a not-found before
 * classification.
 *
 * A scan's own `eventCode` gives its stage. `displayStatus` says nothing about
 * where the parcel was three days ago, so only the newest scan falls back to
 * it, and only when its code is not listed here.
 */
import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const DISPLAY_STATUS = new Map<string, ClassifiedStatus>([
  ['1', { status: 'in_transit', stage: 'in_transit' }],
  ['2', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['3', { status: 'exception', stage: 'failed_attempt' }],
  ['4', { status: 'delivered', stage: 'delivered' }],
  ['5', { status: 'exception', stage: 'failed_attempt' }],
  ['6', { status: 'exception', stage: 'failed_attempt' }],
]);

const MOVING: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };
const IN_CUSTOMS: ClassifiedStatus = { status: 'in_transit', stage: 'customs' };
const DELIVERED: ClassifiedStatus = { status: 'delivered', stage: 'delivered' };

const EVENT_CODE = new Map<string, ClassifiedStatus>([
  ['PreAlert', { status: 'pending', stage: 'registered' }],
  ['InboundScan', { status: 'in_transit', stage: 'accepted' }],
  ['Dispatch', MOVING],
  // Export clearance done at origin; the parcel moves on to the port.
  ['ClearanceSuccessed_Export', MOVING],
  ['PortArrival', MOVING],
  ['PortDeparture', MOVING],
  ['TransitCountryArrival', MOVING],
  ['TransitCountryDeparted', MOVING],
  ['DestinationAirPortArrival', MOVING],
  ['ClearanceProcess', IN_CUSTOMS],
  ['ClearanceInspect', IN_CUSTOMS],
  ['ClearanceSuccessed', MOVING],
  ['HandoverLastMile', MOVING],
  ['LastmileCenterArrival', MOVING],
  ['DeliveryStationArrival', MOVING],
  ['DeliveryStationDepart', MOVING],
  ['OutForDelivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Delivered', DELIVERED],
  ['Delivered_Mailbox', DELIVERED],
  ['Delivered_Doorstep', DELIVERED],
]);

export { DISPLAY_STATUS as SUNYOU_STATUS, EVENT_CODE as SUNYOU_EVENT_CODES };

/** The status and stage for one `displayStatus`, or undefined when unmapped. */
export function sunYouStatus(displayStatus: string): ClassifiedStatus | undefined {
  return DISPLAY_STATUS.get(displayStatus);
}

/** The status and stage for one scan's `eventCode`, or undefined when unmapped. */
export function sunYouEventStatus(eventCode: string): ClassifiedStatus | undefined {
  return EVENT_CODE.get(eventCode);
}

/**
 * What the map says about one scan: its event code. A newest scan whose code is not listed took
 * the shipment's display status, which the stored scan does not keep, so it stays open.
 */
export const statusMap: CarrierStatusMap = { stage: (code) => (code ? sunYouEventStatus(code)?.stage : undefined), gaps: [] };
