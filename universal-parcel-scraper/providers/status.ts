/**
 * The universal providers' status map. The parcel app files every scan a
 * universal provider relays under the carrier `unknown`, and no carrier map
 * stands behind those scans: the reading the providers give one is their map.
 * That is a 17TRACK sub-status where it outranks the wording
 * (`seventeentrack/status.ts`), else the wording rules every provider
 * applies (`classifyEvent`: their own vocabulary around the shared language
 * rules). A stage a provider declares and a UPU event code it maps are
 * `carrier_map`, so their scans never reach the app's review. Wording no rule
 * reads has no stage. Notices that are not scans, detail lines and headings,
 * and scans whose wording alone cannot settle a step are left out on purpose,
 * each with the reason.
 */
import { CHRONOPOST_NOTIFICATION } from '../carriers/chronopost/status.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../core/status/statusMap.js';
import { subStatusStage } from './seventeentrack/status.js';
import { classifyEvent } from './shared/result.js';

/** Relayed wording that names no step of its own, and why: the app's review closes it as left out. */
const NO_STEP: ReadonlyArray<readonly [wording: string, note: string]> = [
  // Notices the providers drop before they reach a history (`isNotice`), seen before they did.
  ['a preferred drop-off location was booked for the shipment', "ParcelsApp's note of a drop-off place the recipient booked: not a scan."],
  ['track sendcloud shipment by tapping the button', "ParcelsApp's prompt to track on Sendcloud's site: not a scan."],
  ['shipment parameters updated', "Postal Ninja's note that the shipment's details changed: not a scan."],
  ['tracking number must contain only capital letters and digits. please check that tracking number is correct.',
    "ParcelsApp's check of the number's characters: not a scan."],
  ['keine weiteren details erforderlich', "DHL's detail line saying no further details are required, as ParcelsApp relays it: not a scan."],
  // MailAmericas' tax ID checks (its SM codes, left out of its own map), as ParcelsApp relays them.
  ['tax id. form received', "MailAmericas' tax ID check as ParcelsApp relays it: the parcel moves on whatever it says."],
  ['tax id. address not found', "MailAmericas' tax ID check as ParcelsApp relays it: the parcel moves on whatever it says."],
  // Detail lines that sit beside different scans, headings, and a code relayed without its wording.
  ['filiale / agentur', 'A German detail line that sits beside different scans: no step of its own.'],
  ['packstation', 'A detail line naming a Packstation, before the parcel was collected: no step of its own.'],
  ['vereinfachte zustellung', 'A detail line naming a simplified delivery, beside loading and unloading scans: no step of its own.'],
  ['benachrichtigt', 'A German note that someone was notified, without saying of what: no step of its own.'],
  ['in progress', 'A heading that names no step.'],
  ['sms alert for the addressee - consignment delivery date.', "Česká pošta's text message to the recipient, as aggregators relay it: not a scan."],
  ['email alert for the addressee - consignment delivery date.', "Česká pošta's email to the recipient, as aggregators relay it: not a scan."],
  ['we have not received the recipient’s phone number', "Posti's notification tool noting it has no phone number to notify the recipient by: not a scan."],
  ['we sent the recipient a letter about the item', "Posti's notification tool noting it wrote to the recipient: not a scan."],
  ['delivery cannot be changed', "PostNL's note, as ParcelsApp relays it, that the delivery can no longer be changed: not a scan."],
  ['pios notice', "PostNL's notice, as ParcelsApp relays it beside its receipt of the shipment, without its content: no step of its own."],
  ['update on your parcel', 'A heading that names no step.'],
  ['carrier update', "Cainiao's placeholder wording, which ParcelsApp relays for its notices and its transit sorting centers' scans alike: it names no movement."],
  ['110', "A bare code relayed in place of a scan's wording: it names no step."],
  // Scans whose wording alone cannot settle the step: who received the parcel, which side shipped or
  // released it, whether a driver collects or delivers, or which forwarder's warehouse scanned it.
  ['item received', 'A bare receipt that names no receiver: ParcelsApp reads it by its place, the wording alone cannot.'],
  ['received.', 'A bare receipt that names no receiver: a store, a centre or a carrier.'],
  ['package received', 'A bare receipt that names no receiver: a store, a centre or a carrier.'],
  ['shipped', "A dispatch that does not say whether the seller or a carrier sent the parcel on."],
  ['released', 'A release that does not say from customs or from a hold.'],
  ['driver assigned', 'A driver assigned, to a collection or to a delivery round: the wording does not say which.'],
  ['from one of our operators', "Poste Italiane's acceptance (\"Presa in carico da un nostro operatore\") as ParcelsApp relays it, without its verb: the wording alone names no step."],
  ['on date', "Poste Italiane's \"in data\", the end of a movement's sentence under its milestone, as ParcelsApp relays it translated: the wording alone names no step."],
  ['parcel is with the driver', 'A parcel with a driver, collected or out for delivery: the wording does not say which.'],
  ['not received from retailer', 'A hand-over from the retailer that has not happened: no step was taken.'],
  ['pickup document attached', 'A document attached to a collection, before or after it: no step of its own.'],
  ['delivery branch. rescheduling', 'A delivery rescheduled at the branch, before a new round or a collection: the wording does not say which.'],
  ['parcel to be taken to a yodel store', "A Yodel store hand-over that can be the sender's drop-off or a parcel sent for collection."],
  ['the parcel has reached the parcelshop', "GLS's ParcelShop scan as Postal Ninja relays it: the sender's drop-off or a parcel waiting for collection. A provider's result reads it by the carrier scans around it."],
  ['barcode scanning', "A Shenzhen forwarder's warehouse scan that First Line reads as its intake and PFC Express as transit: the wording names neither."],
  ['packaged', "A forwarder's packing, or a seller's: the wording does not say whose."],
];

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const read = classifyEvent(wording);
    return (code ? subStatusStage(code, read.stage, wording) : undefined) ?? (read.stage_source === 'none' ? undefined : read.stage);
  },
  gaps: [{
    wording: normalizeStatusWording(CHRONOPOST_NOTIFICATION),
    note: "Chronopost's notice to the recipient, relayed as it is: not a scan, so it keeps the stage the parcel already had.",
  }, {
    wording: normalizeStatusWording(`${CHRONOPOST_NOTIFICATION}. Type du message : Retard Média utilisé : E-mail`),
    note: "Chronopost's delay notice to the recipient with the message type and medium ParcelsApp appends, which the providers leave out: not a scan, so it keeps the stage the parcel already had.",
  }, {
    wording: 'estimated delivery',
    note: 'A delivery estimate without its date: not a scan, so it keeps the stage the parcel already had.',
  }, {
    wording: 'recipient information updated',
    note: "A note that the recipient's details changed, after the local carrier's receipt: not a scan, so it keeps the stage the parcel already had.",
  }, {
    wording: 'change of delivery address',
    note: "A new delivery address recorded, as ParcelsApp relays Huahan's: an address change moves nothing, so it keeps the stage the parcel already had.",
  }, {
    wording: 'last-mile delivery forecast',
    note: "Cainiao's order data sent ahead to the last-mile carrier, between its origin sorting scans: not a scan, so it keeps the stage the parcel already had.",
  }, {
    wording: 'stocktaking delay',
    note: "A forwarder's stock count holding the parcel, as ParcelsApp relays it after the flight: it moves nothing, so it keeps the stage the parcel already had.",
  }, {
    wording: 'en demora - el envío ha sufrido un retraso provocando una posible demora en la entrega.',
    note: "SEUR's delay notice as Ship24 relays it, group before wording: not a scan, so it keeps the stage the parcel already had.",
  }, {
    wording: 'forecast of last-mile delivery by carrier',
    note: "Cainiao's order data sent ahead to the last-mile carrier, in Postal Ninja's words: not a scan, so it keeps the stage the parcel already had.",
  }, {
    code: 'LAST_MILE_ASN_NOTIFY',
    note: "Cainiao's order data sent ahead to the last-mile carrier, relayed with Cainiao's code in any words: not a scan, so it keeps the stage the parcel already had.",
  }, {
    wording: 'consignee notified: by email',
    note: "Colis Privé's note that it emailed the recipient, as ParcelsApp relays it: not a scan, so it keeps the stage the parcel already had.",
  }, {
    wording: 'email notification',
    note: "DPD Poland's email to the recipient, as ParcelsApp relays it: not a scan, so it keeps the stage the parcel already had.",
  }, {
    wording: 'sms notification',
    note: "DPD Poland's text message to the recipient, as ParcelsApp relays it: not a scan, so it keeps the stage the parcel already had.",
  }, {
    wording: 'your package will be delivered to another pickup point. you will be informed of the address and hours by email.',
    note: "Colis Privé's notice of a delivery still to come at another pickup point, as ParcelsApp relays it: not a scan, so it keeps the stage the parcel already had.",
  }, ...NO_STEP.map(([wording, note]) => ({ wording, note }))],
};
