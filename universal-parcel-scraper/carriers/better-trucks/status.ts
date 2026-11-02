import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Better Trucks' scan `status` codes. The tracker's script lists them and
 * groups them into the steps of its progress picture; replies have shown the
 * creation, injection, hub, out-for-delivery and delivery codes.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['SHIPMENT_CREATED', 'registered'], // The shipper created the label.
  ['TRANSACTION_CREATED', 'registered'],
  ['PARCEL_CREATED', 'registered'],
  ['SHIPMENT_INTEGRATION', 'registered'],
  ['PARCEL_LABEL_CREATED', 'registered'],
  ['SHIPMENT_LABEL_CREATED', 'registered'],
  ['INJECTED', 'accepted'], // Received in Better Trucks' network from the shipper.
  ['PICKED_UP', 'accepted'], // Collected by a driver, from the shipper or a drop-off point.
  ['VGO_PARCEL_DROPPED_OFF_BY_CUSTOMER', 'accepted'], // Handed in at a Vinted Go point.
  ['VGO_PARCEL_READY_FOR_DRIVER_PICKUP', 'accepted'], // Waiting at the Vinted Go point for a driver.
  ['RECEIVED', 'in_transit'],
  ['IN_TRANSIT', 'in_transit'],
  ['SCANNED_AT_HUB', 'in_transit'],
  ['LOADED_ON_DELIVERY_VEHICLE', 'out_for_delivery'],
  ['OUT_FOR_DELIVERY', 'out_for_delivery'],
  ['DELIVERY_FAILURE', 'failed_attempt'],
  // Back at the delivery station, which follows a delivery that did not happen.
  ['RTS_RETURNED_TO_STATION', 'failed_attempt'],
  // Held until the shipper confirms the recipient's address.
  ['AWAITING_ADDRESS_CONFIRMATION', 'exception'],
  ['VGO_PARCEL_READY_FOR_RECIPIENT_PICKUP', 'ready_for_pickup'],
  ['VGO_PARCEL_PICKED_UP_BY_RECIPIENT', 'delivered'],
  ['DELIVERED', 'delivered'],
]);

// A hub scan's code names the hub after the family, as SCANNED_AT_HUB_HOS.
const HUB = /^SCANNED_AT_HUB(?:_[A-Z0-9]+)?$/;
// Codes that move nothing: a changed shipment record, a corrected address, an
// expired parcel at a Vinted Go point waiting for a driver, a dispatch failure
// the page hides.
const UNSTAGED = new Set(['PARCEL_CHANGED', 'SHIPMENT_CHANGED', 'ADDRESS_CORRECTED', 'VGO_EXPIRED_PARCEL_READY_FOR_DRIVER_PICKUP', 'ONFLEET_FAILED']);

/** Whether the code is a hub scan, whose point is the hub. */
export function isHubScan(code: string): boolean {
  return HUB.test(code.toUpperCase());
}

/** The stage Better Trucks' codes give a scan code. */
export function betterTrucksMappedStage(code: string): Stage | undefined {
  const key = code.toUpperCase();
  return CODES.get(key) ?? (HUB.test(key) ? 'in_transit' : undefined);
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function betterTrucksStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = betterTrucksMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (UNSTAGED.has(code.toUpperCase())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? betterTrucksMappedStage(code) : undefined),
  gaps: [
    { code: 'PARCEL_CHANGED', note: 'A change to the parcel\'s record; it moves nothing.' },
    { code: 'SHIPMENT_CHANGED', note: 'A change to the shipment\'s record; it moves nothing.' },
    { code: 'ADDRESS_CORRECTED', note: 'The recipient\'s address was corrected; the page shows the scan before it as the status.' },
    { code: 'VGO_EXPIRED_PARCEL_READY_FOR_DRIVER_PICKUP', note: 'A parcel left too long at a Vinted Go point, waiting for a driver; where it goes next is not said.' },
    { code: 'ONFLEET_FAILED', note: 'A failure in the dispatch system that the page leaves out of the history.' },
  ],
};
