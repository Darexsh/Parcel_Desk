import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The `action` codes of EWE's delivery system, which its trace tracker
 * returns with each scan, on EWE's host and HOMEXPRESS's alike. Only codes
 * seen in replies are mapped.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['create_order', 'registered'], // The order is in; a depot is to collect the parcel.
  ['collect_order', 'accepted'], // First scan in an EWE warehouse.
  ['out_warehorse_2', 'out_for_delivery'], // Left the warehouse with the driver who delivers it.
  ['sign_in', 'delivered'],
  ['sign_image', 'delivered'], // The delivery's proof photo, a moment after `sign_in`.
]);

/** The stage the delivery system's map gives an `action` code, in any case. */
export function traceCodeStage(code: string | null): Stage | undefined {
  return code ? CODES.get(code.toLowerCase()) : undefined;
}

/**
 * The wordings of the main tracking page's lookup, which carry no code: those
 * of eMetro, EWE's delivery arm whose consignments it answers too, and those
 * it relays from EWE's delivery system, which name the depot or warehouse and
 * so are read by their opening words.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^package processed at warehouse\b/, 'accepted'],
  // eMetro collects the parcel from the warehouse, assigns it to a run and loads it.
  [/^pick-up by emetro\b/, 'in_transit'],
  [/^assigned$/, 'in_transit'],
  [/^pending on delivery$/, 'in_transit'],
  [/^on delivery$/, 'out_for_delivery'],
  [/^delivered$/, 'delivered'],
  [/^order created by\b/, 'registered'],
  [/^parcel arrived at warehouse\b/, 'accepted'],
  [/^parcel has left warehouse\b.*\bdriver\b/, 'out_for_delivery'],
  [/^(?:the|your) parcel has been delivered\b/, 'delivered'],
];

// eMetro closes the consignment after its delivery: it moves nothing.
const CLOSED = normalizeStatusWording('Fully Complete');

/**
 * The stage EWE's map gives an `action` code of its delivery system, else a
 * wording in `normalizeStatusWording` form. Another code falls to the
 * wordings, then to the shared wording rules.
 */
export function eweMappedStage(code: string | null, wording: string): Stage | undefined {
  return traceCodeStage(code) ?? WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function eweStage(code: string, wording: string): ClassifiedWording | null {
  const normalized = normalizeStatusWording(wording);
  const mapped = eweMappedStage(code || null, normalized);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (!code && normalized === CLOSED) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => eweMappedStage(code, wording),
  gaps: [
    { wording: CLOSED, note: 'eMetro closes the consignment after its delivery scan; it moves nothing.' },
  ],
};
