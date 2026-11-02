import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Pósturinn's scan wordings, mapped whole. The adapter asks for English, but
 * the tracker leaves some wordings in Icelandic, so both are here. Null is a
 * notice or a record that moves nothing. The English is the tracker's own,
 * misspellings included.
 */
export const POSTURINN_SCANS: Readonly<Record<string, Stage | null>> = {
  'Expected from sender': 'registered',
  'Væntanleg frá sendanda': 'registered',
  'Póstlagt': 'accepted',
  'Reveived from sender and will be forwarded': 'accepted',
  'Móttekið frá sendanda og verður sent áfram': 'accepted',
  'Received by Pósturinn': 'accepted',
  'Móttekið af Póstinum': 'accepted',
  // The sending post's scans, abroad.
  'Registered/mailed abroad': 'accepted',
  'Póstlagt/skráð erlendis': 'accepted',
  'Arrived at sorting center abroad': 'in_transit',
  'Komið til erlendrar póstmiðstöðvar': 'in_transit',
  'Departed from sorting center abroad': 'in_transit',
  'Fór frá erlendri póstmiðstöð': 'in_transit',
  // At the office of exchange, then the mail centre.
  'Arrived in destination country': 'in_transit',
  'Kom til landsins í vinnslu': 'in_transit',
  'Arrived': 'in_transit',
  'Kom til landsins': 'in_transit',
  // The import department holds the parcel until the recipient sends the
  // invoice, works out the fees and is paid.
  'Waiting for Invoice': 'customs',
  'Á lager - Beðið eftir gögnum': 'customs',
  'Invoice delivered': 'customs',
  'Innsendur reikningur': 'customs',
  'Import fees calculated': 'customs',
  'Aðflutningsgjöld reiknuð': 'customs',
  'Payment received': 'customs',
  'Greiðsla móttekin': 'customs',
  'Shipment sorting': 'in_transit',
  'Flokkun í Póstmiðstöð': 'in_transit',
  'Scanned - Into container': 'in_transit',
  'Skannað í búr/poka/hillu': 'in_transit',
  // Held at the mail centre until a Póstbox locker is free; the older wording, then the current one.
  'Póstbox biðstaða í PM(tilkynnt)': 'in_transit',
  'Bið eftir Póstboxi': 'in_transit',
  // The recipient is then told to collect it.
  'Arrived at post office': 'ready_for_pickup',
  'Kom á pósthús': 'ready_for_pickup',
  'At final pick-up point': 'ready_for_pickup',
  'Notice sent from post office': null,
  // The handover, recorded at the post office or locker it was collected from, often twice.
  'Delivery booked': 'delivered',
  'Afhending bókuð': 'delivered',
  'Notifcation (Text msg./email)': null,
  'Rafræn tilkynning (SMS eða tölvupóstur)': null,
  'Notice sent (Import departm.)': null,
  'Tilkynning send (Tollalager)': null,
  'Barcode on consignment note changed': null,
  'Strikamerki fyrir fylgibréf breytt': null,
};

const ABROAD = new Set([
  'Registered/mailed abroad', 'Póstlagt/skráð erlendis', 'Arrived at sorting center abroad', 'Komið til erlendrar póstmiðstöðvar',
  'Departed from sorting center abroad', 'Fór frá erlendri póstmiðstöð',
].map(normalizeStatusWording));

const SCANS = new Map(Object.entries(POSTURINN_SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's wording; null for one it leaves without a stage, undefined for one it does not know. */
export function posturinnScanStage(wording: string): Stage | null | undefined {
  return SCANS.get(normalizeStatusWording(wording));
}

/** Whether the wording is one of Pósturinn's own scans in Iceland, as opposed to the sending post's abroad or an unknown one. */
export function isPosturinnHomeScan(wording: string): boolean {
  const key = normalizeStatusWording(wording);
  return SCANS.has(key) && !ABROAD.has(key);
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function posturinnStage(wording: string): ClassifiedWording | null {
  const mapped = posturinnScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (mapped === null) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The shipment's `status`, from the enumeration in the tracking page's
 * script, where it settles the stage: a delivery, a return, or a parcel
 * waiting for collection, out for delivery or after a missed home delivery.
 * Its other values trail the scans, so they decide nothing.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  ['Delivered', 'delivered'],
  ['ReturnedToSender', 'returned'],
  ['AvailableForPickup', 'ready_for_pickup'],
  ['AvailableForPickupAtParcelPoint', 'ready_for_pickup'],
  ['AvailableForPickupAtPostBox', 'ready_for_pickup'],
  ['AvailableForPickupAtPostOffice', 'ready_for_pickup'],
  ['OutForHomeDelivery', 'out_for_delivery'],
  ['UnsuccessfulHomeDeliveryAttempt', 'failed_attempt'],
]);

/** The stage the shipment's status settles, if it settles one. */
export function posturinnStatusStage(status: string): Stage | undefined {
  return STATUSES.get(status);
}

/** The scans carry no code; the wording sets the stage. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : posturinnScanStage(wording) ?? undefined),
  gaps: [
    { wording: 'notifcation (text msg./email)', note: 'The text or email telling the recipient where the parcel is; it moves nothing.' },
    { wording: 'rafræn tilkynning (sms eða tölvupóstur)', note: 'The text or email telling the recipient where the parcel is; it moves nothing.' },
    { wording: 'notice sent from post office', note: 'The post office\'s notice to collect the parcel; it moves nothing.' },
    { wording: 'notice sent (import departm.)', note: 'The import department\'s notice asking the recipient for the invoice; it moves nothing.' },
    { wording: 'tilkynning send (tollalager)', note: 'The import department\'s notice asking the recipient for the invoice; it moves nothing.' },
    { wording: 'barcode on consignment note changed', note: 'A correction of the label\'s barcode; it moves nothing.' },
    { wording: 'strikamerki fyrir fylgibréf breytt', note: 'A correction of the label\'s barcode; it moves nothing.' },
  ],
};
