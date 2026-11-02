import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * AyMakan's statuses, from its list of status codes: the label the tracker
 * shows over a shipment, the description its timeline shows for the scan, and
 * the stage. A parcel is collected from the shipper's collection point, sorted
 * at a hub and received at the delivering city's warehouse. Lockers, external
 * partners and holds have statuses of their own. The tracker shows no codes.
 */
const STATUSES: readonly (readonly [label: string, description: string, stage: Stage])[] = [
  ['AWB created at origin', 'Shipment is created at collection point', 'registered'], // AY-0001
  ['Picked from Collection Point', 'Shipment was collected from collection point', 'accepted'], // AY-0002
  ['Received at Warehouse', 'Shipment is received at hub', 'in_transit'], // AY-0003
  ['Out for Delivery', 'Shipment is out for its final destination', 'out_for_delivery'], // AY-0004
  ['Delivered', 'Shipment is delivered to customer', 'delivered'], // AY-0005
  ['Not Delivered', 'Shipment delivery attempt failed', 'failed_attempt'], // AY-0006
  ['Cancelled', 'Shipment was cancelled', 'exception'], // AY-0007
  ['Returned', 'Shipment is returned to shipper', 'returned'], // AY-0008
  ['In Transit', 'Shipment is in transit', 'in_transit'], // AY-0009
  ['Delayed', 'Shipment is delayed upon customer request', 'exception'], // AY-0010
  ['Cancelled', 'Shipment cancelled', 'exception'], // AY-0011
  ['Missing Phone / Address', 'Missing consignee information', 'exception'], // AY-0013
  // Back at the warehouse after failed attempts; it goes out again or back to the shipper.
  ['Received Back in Warehouse', 'Returned after failed delivery attempts', 'exception'], // AY-0017
  ['Out for Return to Shipper', 'Shipment is returning to shipper', 'returned'], // AY-0028
  ['Pickup Cancelled', 'Pickup cancelled', 'exception'], // AY-0029
  ['Assigned to Collection Driver', 'Driver assigned for collection', 'registered'], // AY-0039
  ['No Answer', 'Customer did not answer', 'failed_attempt'], // AY-0040
  ['Out of Network', 'Destination outside delivery network', 'exception'], // AY-0041
  ['On Hold', 'Shipment is on hold', 'exception'], // AY-0050
  ['Lost', 'Shipment lost', 'exception'], // AY-0058
  ['Processing for Return', 'Processing return to shipper', 'returned'], // AY-0059
  ['Waiting Address Validation', 'Shipment awaiting address validation', 'exception'], // AY-0064
  ['Address Validated', 'Address validated', 'in_transit'], // AY-0065
  ['Remote City', 'Awaiting remote area service day', 'in_transit'], // AY-0066
  ['Arrived at Delivery Warehouse', 'Shipment arrived at delivery warehouse', 'in_transit'], // AY-0068
  ['Created at External', 'Shipment created by external partner', 'registered'], // AY-0069
  ['Picked Up - External', 'Picked up by external partner', 'accepted'], // AY-0070
  ['Processing for Remote Area', 'Processing remote area shipment', 'in_transit'], // AY-0079
  ['Return to Aymakan Warehouse', 'Returned to Aymakan warehouse', 'exception'], // AY-0084
  ['Received in Clearing Department', 'Customs clearing', 'customs'], // AY-0088
  ['Hold for Dispatch', 'Shipment on dispatch hold', 'exception'], // AY-0090
  ['Cancelled by Consignee', 'Shipment cancelled by consignee', 'exception'], // AY-0091
  ['Mailroom On Hold', 'Mailroom shipment on hold', 'exception'], // AY-0093
  ['Mailroom Processing for Return', 'Mailroom return processing', 'returned'], // AY-0094
  ['Scheduled Delivery', 'Delivery scheduled upon customer request', 'in_transit'], // AY-0095
  ['Dispatch External', 'Dispatched to external carrier', 'in_transit'], // AY-0097
  ['Arrived at Destination Warehouse', 'Shipment arrived at destination warehouse', 'in_transit'], // AY-0099
  ['Cancelled by Shipper', 'Shipment cancelled by shipper', 'exception'], // AY-0105
  ['Deposited to Locker', 'Shipment deposited into locker', 'ready_for_pickup'], // AY-0108
  ['Locker Expired', 'Locker holding period expired', 'exception'], // AY-0109
  ['Locker AWB Generated', 'Locker shipment created', 'registered'], // AY-0110
  ['Out for Deposit', 'Driver is depositing shipment', 'out_for_delivery'], // AY-0111
  ['Retrieved', 'Shipment retrieved from locker', 'delivered'], // AY-0112
  ['Locker Cancelled', 'Locker delivery cancelled', 'exception'], // AY-0113
  // The driver goes to collect the parcel from the shipper.
  ['Out for Pickup', 'Driver out to collect shipment', 'registered'], // AY-0114
  ['External Assigned', 'Assigned to external logistics provider', 'in_transit'], // AY-0116
];

/** A wording in `normalizeStatusWording` form, without the full stop some descriptions end with. */
function key(wording: string): string {
  return normalizeStatusWording(wording).replace(/\s*\.$/, '');
}

const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ...STATUSES.flatMap(([label, description, stage]) => [[key(label), stage], [key(description), stage]] as const),
  // The timeline's wording for the creation of older shipments.
  [key('Shipping Created'), 'registered'],
]);

// A receipt at a city's hub, warehouse or station, such as AY-0026's "Received at Riyadh
// Warehouse", or older shipments' "Shipment is received at Riyadh hub".
const RECEIVED = /^(?:shipment (?:is )?)?received (?:at|in) /;

/**
 * The stage AyMakan's list gives a status label or a timeline description.
 * The reverse pickups of returns and "Pending" are left to the shared rules.
 */
export function aymakanMappedStage(wording: string): Stage | undefined {
  const normalized = key(wording);
  return WORDINGS.get(normalized) ?? (RECEIVED.test(normalized) ? 'in_transit' : undefined);
}

/** A status's or scan's stage: the list's, else the shared wording rules', else nothing. */
export function aymakanStage(wording: string): ClassifiedWording | null {
  const mapped = aymakanMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one status or scan, by its wording: the tracker shows no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : aymakanMappedStage(wording)),
  gaps: [],
};
