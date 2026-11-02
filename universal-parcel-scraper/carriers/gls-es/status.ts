import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracking service's state codes, the same for the shipment's current
 * state and each scan. `stored` is left out: the app gives it no milestone of
 * its own, so its sentence decides.
 */
export const GLS_SPAIN_STATES: Readonly<Record<string, Stage>> = {
  dataReceived: 'registered',
  // Collected from the sender.
  picked: 'accepted',
  onTransit: 'in_transit',
  onDelivery: 'out_for_delivery',
  delivered: 'delivered',
  // Part of a shipment of several parcels is still on its way.
  partiallyDelivered: 'in_transit',
  returned: 'returned',
  // On its way back to the sender.
  onReturn: 'returned',
  destroyed: 'exception',
  retained: 'exception',
  broken: 'exception',
  // Sent on to another address or depot.
  rechannelized: 'in_transit',
  // Left at a GLS point, then booked in by it with the collection code and deadline the app shows.
  deliveredOnParcel: 'ready_for_pickup',
  receivedOnParcel: 'ready_for_pickup',
  canceled: 'exception',
  incidence: 'exception',
  // A collection from the recipient, such as a return, waiting for the driver.
  pickupPending: 'registered',
  pickupIncidence: 'exception',
};

/**
 * Incidence sentences in the service's English, mapped whole. An incidence
 * covers a missed delivery as much as a refusal; others stay exceptions.
 */
export const GLS_SPAIN_INCIDENCES: Readonly<Record<string, Stage>> = {
  Absent: 'failed_attempt',
  'Refused by the consignee': 'exception',
};

// The incidence that sends the parcel on to a GLS point, followed by the point's name.
const REDIRECTED = /^shipment redirected to gls point /;
const INCIDENCES = new Map(Object.entries(GLS_SPAIN_INCIDENCES).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage a state code gives, with the sentence an incidence needs. */
function mappedStage(code: string | null, wording: string): Stage | undefined {
  if (!code || !Object.hasOwn(GLS_SPAIN_STATES, code)) return undefined;
  if (code !== 'incidence') return GLS_SPAIN_STATES[code];
  return INCIDENCES.get(wording) ?? (REDIRECTED.test(wording) ? 'in_transit' : GLS_SPAIN_STATES[code]);
}

/** The stage of a state code and its sentence: the map first, then the shared wording rules. */
export function glsSpainStage(code: string, sentence: string): ClassifiedWording | null {
  const mapped = mappedStage(code, normalizeStatusWording(sentence));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(sentence, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: mappedStage,
  gaps: [{
    code: 'stored',
    note: 'Held at a GLS depot. The app gives the state no milestone of its own, so the scan\'s sentence decides.',
  }],
};
