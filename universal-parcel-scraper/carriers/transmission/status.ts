import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The search codes ("Zoek code") of the tracker's scan history. Its wording
 * for one code has changed over time, and an early scan at the sorting centre
 * can read "Bezorgtijd nog onbekend", the delivery estimate, so the code
 * decides. Code 0 has only come with a delivery, logged again beside 39; it is
 * left to its wording.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['20', 'in_transit'], // Processed at the collecting depot's sorting centre.
  ['30', 'in_transit'], // At the delivering depot.
  ['188', 'out_for_delivery'],
  ['39', 'delivered'],
]);

/**
 * The page's own wordings: the scan statuses, the headline above the progress
 * rail and the sentence under it, in Dutch and English. Older scans came
 * without a search code.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Zending aangemeld', 'registered'],
  ['Order announced', 'registered'],
  ['Zending bij sorteercentrum', 'in_transit'],
  ['Order at hub', 'in_transit'],
  ['Verwerkt in sorteercentrum', 'in_transit'],
  ['Processed in sorting center', 'in_transit'],
  ['Uw zending is ontvangen door ons sorteercentrum.', 'in_transit'],
  ['Vertrek Scan', 'in_transit'],
  ['Zending is op het juiste depot', 'in_transit'],
  ['Aangekomen in uw regio', 'in_transit'],
  ['Arrived in your region', 'in_transit'],
  ['Chauffeur is onderweg', 'out_for_delivery'],
  ['Driver is on his way', 'out_for_delivery'],
  ['Onderweg met de bezorger', 'out_for_delivery'],
  ['Onze chauffeur is onderweg met uw bestelling.', 'out_for_delivery'],
  // A delay the delivering depot reports; the parcel waits there.
  ['Vertraagd', 'exception'],
  ['Afgeleverd', 'delivered'],
  ['Bezorgd', 'delivered'],
  ['Delivered', 'delivered'],
  ['Uw zending is geleverd.', 'delivered'],
  ['De zending is bezorgd.', 'delivered'],
  ['Your shipment has been delivered.', 'delivered'],
  ['The shipment is delivered.', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage TransMission gives a search code, else one of its page's wordings. */
export function transmissionMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording));
}

const ESTIMATE = 'The delivery estimate, also logged as a scan status; without a search code it says nothing of where the parcel is.';

export const statusMap: CarrierStatusMap = {
  stage: transmissionMappedStage,
  gaps: [
    { wording: normalizeStatusWording('Bezorgtijd nog onbekend'), note: ESTIMATE },
    { wording: normalizeStatusWording('Delivery time unknown'), note: ESTIMATE },
    { wording: normalizeStatusWording('No expected delivery time available'), note: ESTIMATE },
    { wording: normalizeStatusWording('Onbekend'), note: 'The progress rail\'s label for a shipment whose status the page does not know.' },
  ],
};
