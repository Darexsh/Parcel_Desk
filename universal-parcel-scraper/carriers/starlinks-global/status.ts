import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Starlinks Global's event titles, a short list, and the texts beside them,
 * which carry no code. A text can end with the place and its country; the map
 * reads it without them. Another wording falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Accepted at Processing Hub', 'accepted'],
  ['Processed at Carrier Origin Hub', 'in_transit'],
  ['Prepared for Export', 'in_transit'],
  ['Despatched to Destination', 'in_transit'],
  ['Linehaul Export to Destination', 'in_transit'],
  ['Linehaul Export to Destination Country', 'in_transit'],
  ['Arrived at Destination Hub', 'in_transit'],
  ['Received in Destination Country', 'in_transit'],
  ['Customs cleared', 'customs'],
  ['Customs Clearance - Complete', 'customs'],
  // The last-mile courier has the parcel.
  ['Received by carrier', 'in_transit'],
  ['Received by Final Mile Carrier', 'in_transit'],
  ['Processed in carrier facility', 'in_transit'],
  ['In transit', 'in_transit'],
  ['In Transit, with carrier', 'in_transit'],
  ['In Transit, with delivery carrier', 'in_transit'],
  ['In Transit, with delivery partner', 'in_transit'],
  // The postal service has the label, not yet the parcel.
  ['In Transit, USPS awaiting item', 'in_transit'],
  ['Arrived at Post Office', 'in_transit'],
  ['Delivery Scheduled', 'in_transit'],
  ['Item to be Redirected DHL ServicePoint', 'in_transit'],
  ['Out for Delivery', 'out_for_delivery'],
  ['Delivery Attempted', 'failed_attempt'],
  ['Delivery awaiting collection', 'ready_for_pickup'],
  ['Item Available at Pick-up Point', 'ready_for_pickup'],
  ['Delivered', 'delivered'],
  ['Returned to Origin', 'returned'],
  ['Shipment Returned to Origin', 'returned'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

// "Processed in carrier facility at Sampleville, US", "Delivered at US": the
// wording, then the place, if any, and its country, after the last "at".
const PLACED = /^(.+) at (?:((?:(?! at ).)+), )?([A-Z]{2})$/;

/** A text split into its wording and, when it ends with them, the place and its country. */
export function starlinksGlobalPlace(description: string): { wording: string; place?: string; country?: string } {
  const placed = PLACED.exec(description);
  return placed ? { wording: placed[1]!, ...(placed[2] ? { place: placed[2] } : {}), country: placed[3]! } : { wording: description };
}

// The same ending in a wording the map is given in lower case.
const PLACED_WORDING = new RegExp(PLACED.source, 'i');

/** The stage Starlinks Global's map gives a wording, with or without its place. */
export function starlinksGlobalMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording)) ?? WORDINGS.get(normalizeStatusWording(PLACED_WORDING.exec(wording)?.[1] ?? wording));
}

/** An event's stage: its title's, else its text's, else the shared wording rules', else nothing. */
export function starlinksGlobalStage(title: string, description: string): ClassifiedWording | null {
  const mapped = starlinksGlobalMappedStage(title) ?? starlinksGlobalMappedStage(description);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => starlinksGlobalMappedStage(wording),
  gaps: [],
};
