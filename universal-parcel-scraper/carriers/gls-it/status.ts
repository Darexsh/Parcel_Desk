import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scan sentences in its English locale, mapped whole. The scans
 * carry no code, only a sentence, and every network depot writes the same ones.
 */
export const GLS_ITALY_SCANS: Readonly<Record<string, Stage>> = {
  // The sender booked the shipment and has not handed it over yet.
  'The shipment has been created by the sender, we are waiting for it to be entrusted to us for dispatch to its destination.': 'registered',
  'Shipped from sending Depot. In transit.': 'in_transit',
  'Shipment in transit.': 'in_transit',
  'Arrived at final Depot.': 'in_transit',
  // A delay notice from the receiving depot: the shipment is still on its way to it.
  'The shipment has not yet arrived at the receiving GLS Depot.': 'in_transit',
  'The shipment did not arrive at the receiving GLS Depot.': 'in_transit',
  // The morning scan of the delivery round, before the delivery or the failed attempt.
  'Delivery scheduled during the day.': 'out_for_delivery',
  'Available for collection at GLS POINT.': 'ready_for_pickup',
  'Delivered.': 'delivered',
  'Parcel not delivered as the consignee was absent, please book redelivery within 3 working days as per instructions provided by email or sms.': 'failed_attempt',
  // Held at the depot until the recipient answers the redelivery link.
  'Not in delivery. Awaiting instructions by link included in received email or sms': 'exception',
};

/**
 * The Italian sentences the English locale sometimes answers with instead, and
 * the English the Italian page's scan has in the English locale.
 */
const GLS_ITALY_ITALIAN: Readonly<Record<string, string>> = {
  "La spedizione e' stata creata dal mittente, attendiamo che ci venga affidata per l'invio a destinazione.":
    'The shipment has been created by the sender, we are waiting for it to be entrusted to us for dispatch to its destination.',
  'Partita dalla sede mittente. In transito.': 'Shipped from sending Depot. In transit.',
  'In transito.': 'Shipment in transit.',
  'Arrivata nella Sede GLS locale.': 'Arrived at final Depot.',
  'Consegna prevista nel corso della giornata odierna.': 'Delivery scheduled during the day.',
  'Consegnata.': 'Delivered.',
  'Destinatario assente al primo passaggio. Prego prenotare la consegna entro 3 giorni lavorativi, seguendo le istruzioni ricevute via mail o sms.':
    'Parcel not delivered as the consignee was absent, please book redelivery within 3 working days as per instructions provided by email or sms.',
  "Spedizione non in consegna. Il destinatario puo' prenotare la riconsegna tramite link presente in email / sms ricevuto":
    'Not in delivery. Awaiting instructions by link included in received email or sms',
};

/**
 * The progress rail's current step, a GLS group code. It has five steps and no
 * room for a failed attempt, a pickup point or a return, so it only stands in
 * when the newest scan's sentence gives no stage.
 */
export const GLS_ITALY_RAIL: Readonly<Record<string, Stage>> = {
  PREADVICE: 'registered',
  INTRANSIT: 'in_transit',
  INWAREHOUSE: 'in_transit',
  INDELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
};

// All by `normalizeStatusWording` form. An Italian sentence has its English's stage.
const ENGLISH = new Map(Object.entries(GLS_ITALY_ITALIAN).map(([italian, english]) => [normalizeStatusWording(italian), english]));
const SCANS = new Map(Object.entries(GLS_ITALY_SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
for (const [italian, english] of ENGLISH) SCANS.set(italian, SCANS.get(normalizeStatusWording(english))!);

/** The English locale's sentence for an Italian one. */
export function glsItalyEnglish(sentence: string): string | undefined {
  return ENGLISH.get(normalizeStatusWording(sentence));
}

/** The stage a scan's sentence gives it: the map first, then the shared wording rules. */
export function glsItalyScanStage(sentence: string): ClassifiedWording | null {
  const mapped = SCANS.get(normalizeStatusWording(sentence));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(sentence, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The stage the rail's current step gives the shipment, if the map knows it. */
export function glsItalyRailStage(code: string): Stage | undefined {
  return Object.hasOwn(GLS_ITALY_RAIL, code) ? GLS_ITALY_RAIL[code] : undefined;
}

/** The scans carry a sentence and no code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : SCANS.get(wording),
  gaps: [],
};
