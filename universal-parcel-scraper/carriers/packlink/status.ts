import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Packlink's own status codes, which it gives every scan it reads from the
 * collecting carrier, with the stage each one means and the English wording
 * its tracking page shows for it (`tracking-details.status-description.*` in
 * the page's translations). A null stage is a code left without one on purpose.
 */
const CODES: ReadonlyMap<string, readonly [Stage | null, string]> = new Map([
  ['READY_FOR_COLLECTION', ['registered', 'Waiting for carrier to collect the order']],
  ['READY_FOR_COLLECTION_01', ['registered', 'The carrier is about to collect the shipment']],
  ['READY_FOR_COLLECTION_INCIDENT', ['exception', 'Not collected']],
  ['READY_FOR_COLLECTION_INCIDENT_01', ['exception', 'Not collected, package not ready']],
  ['READY_FOR_COLLECTION_INCIDENT_02', ['exception', 'Not collected, incorrect address']],
  ['READY_FOR_COLLECTION_INCIDENT_03', ['exception', 'Not collected']],
  ['IN_TRANSIT', ['in_transit', 'It is in the carrier’s network, on its way from its origin to its destination.']],
  ['IN_TRANSIT_01', ['accepted', 'Shipment accepted by carrier (scanned)']],
  ['IN_TRANSIT_02', ['in_transit', 'Shipment has arrived at a centre']],
  ['IN_TRANSIT_03', ['in_transit', 'The shipment has left the facilities']],
  ['IN_TRANSIT_04', ['in_transit', 'The international shipment has arrived in the destination country']],
  ['IN_TRANSIT_05', ['customs', 'Packet delivered to customs for clearance']],
  ['IN_TRANSIT_06', ['in_transit', 'Customs clearance complete']],
  ['IN_TRANSIT_INCIDENT', ['exception', 'An incident has affected the package’s delivery, but it is still on its way.']],
  ['IN_TRANSIT_INCIDENT_01', ['customs', 'Package delayed due to problems during customs clearance']],
  ['IN_TRANSIT_INCIDENT_02', ['exception', 'Package delayed due to unforeseen incident']],
  ['IN_TRANSIT_INCIDENT_03', ['in_transit', 'Delay due to poor weather, to be delivered as soon as possible']],
  ['IN_TRANSIT_INCIDENT_04', ['in_transit', 'Delay due to accident, to be delivered as soon as possible']],
  ['IN_TRANSIT_INCIDENT_05', ['in_transit', 'Delay due to major event, to be delivered as soon as possible']],
  ['IN_TRANSIT_INCIDENT_06', ['exception', 'Package delayed – Incorrectly classified']],
  ['IN_TRANSIT_INCIDENT_07', ['in_transit', 'Shipment redelivered to a different delivery address']],
  ['IN_TRANSIT_INCIDENT_08', ['in_transit', 'Problem resolved and delivery in progress']],
  ['IN_TRANSIT_INCIDENT_10', ['exception', 'Package rejected by the carrier for non-compliance with guidelines']],
  ['IN_TRANSIT_INCIDENT_11', ['exception', 'Customs document missing']],
  ['IN_TRANSIT_INCIDENT_12', ['exception', 'HM10 UPS dangerous-goods report issued']],
  ['IN_TRANSIT_INCIDENT_13', ['exception', 'Unknown incident']],
  ['IN_TRANSIT_INCIDENT_14', ['exception', 'Unknown incident']],
  ['IN_TRANSIT_INCIDENT_15', ['exception', 'Unknown incident']],
  ['OUT_FOR_DELIVERY', ['out_for_delivery', 'The package is ready to be delivered to the final destination']],
  ['OUT_FOR_DELIVERY_01', [null, 'Customer contacted before final delivery']],
  ['OUT_FOR_DELIVERY_02', [null, 'Delivery date scheduled']],
  ['OUT_FOR_DELIVERY_03', ['ready_for_pickup', 'Parcel at collection point and available for pickup']],
  ['OUT_FOR_DELIVERY_INCIDENT', ['exception', 'An incident has affected the package’s delivery to its final destination']],
  ['OUT_FOR_DELIVERY_INCIDENT_01', ['failed_attempt', 'Unsuccessful delivery. The carrier has left a note and will reschedule delivery']],
  ['OUT_FOR_DELIVERY_INCIDENT_02', ['failed_attempt', 'Unsuccessful delivery']],
  ['OUT_FOR_DELIVERY_INCIDENT_03', ['exception', 'Unsuccessful delivery because the customer has moved house']],
  ['OUT_FOR_DELIVERY_INCIDENT_04', ['exception', 'Unsuccessful delivery because recipient refused to accept the package']],
  ['OUT_FOR_DELIVERY_INCIDENT_05', ['exception', 'Package not delivered due to incorrect recipient address']],
  ['OUT_FOR_DELIVERY_INCIDENT_06', ['exception', 'Package available for collection but not collected by customer']],
  ['OUT_FOR_DELIVERY_INCIDENT_07', ['failed_attempt', 'Recipient not present at indicated address']],
  ['OUT_FOR_DELIVERY_INCIDENT_08', ['failed_attempt', 'Establishment closed at time of delivery']],
  ['OUT_FOR_DELIVERY_INCIDENT_09', ['failed_attempt', 'Unsuccessful delivery and final attempt']],
  ['OUT_FOR_DELIVERY_INCIDENT_10', ['exception', 'Package retained as customer payment is pending']],
  ['OUT_FOR_DELIVERY_INCIDENT_11', ['failed_attempt', 'Delivery failed due to some reason. Carrier delivers to the nearby collection point for customer pick up']],
  ['DELIVERED', ['delivered', 'Package arrived at destination and delivered to recipient.']],
  ['DELIVERED_01', ['delivered', 'Shipment successfully delivered']],
  // Filed under delivered, but the parcel still waits at the point.
  ['DELIVERED_02', ['ready_for_pickup', 'Package at pick-up point and ready for collection']],
  ['DELIVERED_03', ['delivered', 'Package collected by customer']],
  ['DELIVERED_04', ['delivered', 'Package delivered and signed for by customer']],
  ['DELIVERED_05', ['delivered', 'Package delivered to customer and cash on delivery received']],
  ['DELIVERED_06', ['delivered', 'Delivered to a safe place']],
  ['DELIVERED_07', ['delivered', 'Delivered to a neighbour']],
  ['RETURNED_TO_SENDER', ['returned', 'Package returned to sender']],
  ['EXCEPTION', ['exception', 'Shipment damaged/destroyed']],
  ['EXCEPTION_01', ['exception', 'Unsuccessful delivery as package lost/stolen']],
  ['EXCEPTION_02', [null, 'Expired, there is no tracking information for the last 30 days']],
  ['EXCEPTION_03', [null, 'Pending, there is no information available on the carrier’s page or the tracking number has not yet been activated']],
  ['EXCEPTION_04', ['exception', 'Problems with multiple packages when only one or more packages are delivered']],
  ['EXCEPTION_08', ['exception', 'Unsuccessful delivery as package lost/stolen']],
  ['EXCEPTION_09', [null, 'Expired, there is no tracking information for the last 30 days']],
  ['EXCEPTION_10', [null, 'Pending, there is no information available on the carrier’s page or the tracking number has not yet been activated']],
  ['EXCEPTION_11', ['exception', 'Problems with multiple packages when only one or more packages are delivered']],
  ['UNKNOWN', [null, 'Current status could not be found']],
]);

// Packlink's catch-all codes for a family, which it also gives scans it reads
// loosely: a depot's receipt of the parcel as still waiting for collection,
// a notice that the parcel has yet to reach the destination depot as a
// delivery incident. The page shows the carrier's own wording for the last two.
const LOOSE = new Set(['READY_FOR_COLLECTION', 'READY_FOR_COLLECTION_INCIDENT', 'IN_TRANSIT_INCIDENT',
  'OUT_FOR_DELIVERY_INCIDENT', 'IN_TRANSIT_07', 'IN_TRANSIT_100']);
// The family a code the table does not name belongs to, as the page reads it.
const FAMILIES = ['READY_FOR_COLLECTION_INCIDENT', 'READY_FOR_COLLECTION', 'IN_TRANSIT_INCIDENT', 'IN_TRANSIT',
  'OUT_FOR_DELIVERY_INCIDENT', 'OUT_FOR_DELIVERY', 'RETURNED_TO_SENDER', 'DELIVERED', 'EXCEPTION'];

/**
 * Collecting carriers' wordings, seen live under a catch-all code, that say
 * more than the code: in normalized form.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['recibido en origen', 'accepted'], // SEUR's origin depot received the parcel.
  ['tu envío está pendiente de llegar a destino', 'in_transit'], // SEUR: not yet at the destination depot.
]);

function family(code: string): string | undefined {
  return FAMILIES.find((name) => code === name || code.startsWith(`${name}_`));
}

/** Packlink's English wording for a code, else for its family. */
export function packlinkWording(code: string): string | undefined {
  return (CODES.get(code) ?? CODES.get(family(code) ?? ''))?.[1];
}

/** A code the table names with a stage of its own, and not one of the catch-all codes. */
function specific(code: string): Stage | null | undefined {
  return LOOSE.has(code) ? undefined : CODES.get(code)?.[0];
}

/** The stage of a catch-all or unnamed code when the wording says nothing more. */
function fallback(code: string): Stage | undefined {
  if (code === 'IN_TRANSIT_07' || code === 'IN_TRANSIT_100') return 'in_transit';
  const name = family(code);
  return name ? CODES.get(name)?.[0] ?? undefined : undefined;
}

/**
 * A scan's stage: a code of Packlink's that names one milestone, else the
 * carrier's wording under a catch-all code, else the code's family. A code
 * left without a stage on purpose gives none.
 */
export function packlinkStage(code: string, wording: string): ClassifiedWording | null {
  const own = specific(code);
  if (own) return { stage: own, source: 'carrier_map' };
  if (own === null) return null;
  const known = WORDINGS.get(normalizeStatusWording(wording));
  if (known) return { stage: known, source: 'carrier_map' };
  const worded = wording ? classifyWording(wording, 'in_transit') : null;
  if (worded && worded.source !== 'none') return worded;
  const stage = fallback(code);
  return stage ? { stage, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (!code) return undefined;
    const own = specific(code);
    if (own !== undefined) return own ?? undefined;
    const known = WORDINGS.get(wording);
    if (known) return known;
    // The shared wording rules stage this one, not the map.
    if (wording && classifyWording(wording, 'in_transit').source !== 'none') return undefined;
    return fallback(code);
  },
  gaps: [
    { code: 'OUT_FOR_DELIVERY_01', note: 'A call or message to the recipient before the delivery; it moves nothing.' },
    { code: 'OUT_FOR_DELIVERY_02', note: 'A delivery date the carrier set; a delivery still to come is no scan.' },
    { code: 'EXCEPTION_02', note: 'Packlink stopped following the carrier after a month without news; it says nothing about the parcel.' },
    { code: 'EXCEPTION_09', note: 'Packlink stopped following the carrier after a month without news; it says nothing about the parcel.' },
    { code: 'EXCEPTION_03', note: 'Packlink found nothing on the carrier’s page yet; it says nothing about the parcel.' },
    { code: 'EXCEPTION_10', note: 'Packlink found nothing on the carrier’s page yet; it says nothing about the parcel.' },
    { code: 'UNKNOWN', note: 'Packlink could not read the carrier’s status.' },
  ],
};
