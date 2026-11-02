import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Burd's status types, keyed in lower case: the tracking reply writes them in
 * camel case (`deliveryOnTheWay`), its descriptions in Pascal case. Each has
 * the Danish text the tracking page shows for it.
 */
const TYPES: ReadonlyMap<string, { stage: Stage; wording: string }> = new Map([
  ['registered', { stage: 'registered', wording: 'Vi afventer at modtage pakken fra webshoppen.' }],
  // At Burd's terminal, from the sender.
  ['received', { stage: 'accepted', wording: 'Vi har modtaget din pakke og den er ankommet på vores terminal.' }],
  // The delivery moved to another day.
  ['receivedflex', { stage: 'in_transit', wording: 'Leveringen er planlagt til en anden dag.' }],
  ['deliveryontheway', { stage: 'out_for_delivery', wording: 'Pakken er under levering.' }],
  ['delivered', { stage: 'delivered', wording: 'Pakken er leveret.' }],
  // Burd tries again within two working days before the parcel goes back.
  ['deliveryfailed', { stage: 'failed_attempt', wording: 'Vi kunne desværre ikke levere din pakke. Vi forsøger at levere igen indenfor 2 hverdage, før den sendes retur.' }],
  ['returntosender', { stage: 'returned', wording: 'Det har desværre ikke været muligt at levere forsendelsen, som derfor returneres til afsender.' }],
  // The sender did not hand the parcel over in time; Burd expects it the next working day.
  ['notreceived', { stage: 'exception', wording: 'Vi har desværre ikke modtaget pakken og kan derfor ikke levere den i aften. Vi forventer at modtage den næste hverdag.' }],
  ['canceled', { stage: 'exception', wording: 'Leveringen blev annulleret.' }],
]);

/** The stage Burd's status type gives a scan. */
export function burdMappedStage(code: string): Stage | undefined {
  return TYPES.get(code.toLowerCase())?.stage;
}

/** The tracking page's text for a status type; the page shows an unknown type as it is. */
export function burdWording(code: string): string {
  return TYPES.get(code.toLowerCase())?.wording ?? code;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? burdMappedStage(code) : undefined),
  gaps: [],
};
