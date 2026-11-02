import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Public tracking events. The website omits its internal routing and shipment
// bookkeeping rows from the visible timeline.
export const HIDDEN_NINJA_EVENTS = new Set(['ADDED_TO_SHIPMENT', 'PARCEL_ROUTING_SCAN', 'FROM_DP_TO_DRIVER']);

const STATES: Record<string, ClassifiedStatus> = {
  RTS: { status: 'exception', stage: 'exception' },
  DRIVER_PICKUP_SCAN: { status: 'in_transit', stage: 'in_transit' },
  HUB_INBOUND_SCAN: { status: 'in_transit', stage: 'in_transit' },
  DRIVER_INBOUND_SCAN: { status: 'in_transit', stage: 'in_transit' },
  ARRIVED_AT_ORIGIN_HUB: { status: 'in_transit', stage: 'in_transit' },
  ARRIVED_AT_TRANSIT_HUB: { status: 'in_transit', stage: 'in_transit' },
  ARRIVED_AT_DESTINATION_HUB: { status: 'in_transit', stage: 'in_transit' },
  ROUTE_INBOUND_SCAN: { status: 'in_transit', stage: 'in_transit' },
  FROM_SHIPPER_TO_DP: { status: 'in_transit', stage: 'in_transit' },
  FROM_DRIVER_TO_DP: { status: 'in_transit', stage: 'in_transit' },
  FROM_DP_TO_CUSTOMER: { status: 'in_transit', stage: 'in_transit' },
  DELIVERY_SUCCESS: { status: 'delivered', stage: 'delivered' },
  DELIVERY_FAILURE: { status: 'exception', stage: 'failed_attempt' },
  INACCURATE_ADDRESS: { status: 'exception', stage: 'exception' },
  DAMAGE: { status: 'exception', stage: 'exception' },
  LOST: { status: 'exception', stage: 'exception' },
  CANCEL: { status: 'exception', stage: 'exception' },
};

export function ninjaVanStatus(type: string): ClassifiedStatus | undefined {
  return Object.hasOwn(STATES, type) ? STATES[type] : undefined;
}

/**
 * What the map says about one scan: its event type. A delivery on the way back reads as the
 * return, or as a problem when the row's return marker is missing; the stored scan keeps
 * neither the marker nor the leg, so a delivery stays open.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code && code !== 'DELIVERY_SUCCESS' ? ninjaVanStatus(code)?.stage : undefined),
  gaps: [{ code: 'DELIVERY_SUCCESS', note: 'Delivered, the return delivered to the sender, or a problem on the way back, by the row\'s return marker and leg: the stored scan keeps neither.' }],
};
