import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * SEFL's scan wordings, in `normalizeStatusWording` form. The freight is
 * picked up by its origin service center and moves between service centers,
 * each scan naming the trailer, until the one that delivers. The codes do not
 * tell a pickup from an arrival, so the wording decides first. The summary's
 * location ("At destination: …", "Delivered to Customer") and the events the
 * tracer offers for e-mail and text updates share this list.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^shipment pickup(?: using trailer \S+| info entered)?$/, 'accepted'],
  [/^(?:closed|dispatched|arrive) trailer\b/, 'in_transit'],
  [/^(?:hold for appointment|appointment scheduled|enroute to destination|arrived at destination)$/, 'in_transit'],
  [/^at (?:origin|destination):/, 'in_transit'],
  [/^out for delivery\b/, 'out_for_delivery'],
  [/^delivered(?: to customer)?$/, 'delivered'],
  [/^(?:delayed\/potentially late|shortage\/damage delivered exception)$/, 'exception'],
];

/**
 * The status codes SEFL's Web Connect documentation lists. Replies give
 * `SPU`, which the list calls "Scheduled for pickup", to the pickup itself,
 * and `LOD` to pickups and arrivals alike.
 */
const CODES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['ENS', 'registered'], // Electronic notification of shipment: the shipper's advance notice.
  ['SPU', 'accepted'],
  ['DOC', 'in_transit'], // On dock.
  ['LOD', 'in_transit'], // Loaded on trailer.
  ['CFD', 'in_transit'], // Closed for dispatch to the next service center.
  ['DIS', 'in_transit'], // Dispatched.
  ['DFU', 'in_transit'], // Dropped for unloading.
  ['HAP', 'in_transit'], // Hold for appointment.
  ['CFC', 'in_transit'], // Closed for city.
  ['DPT', 'in_transit'], // Delivery print trailer.
  ['CDY', 'out_for_delivery'], // Closed for city delivery: on the delivery run.
  ['DLV', 'delivered'],
  ['OSD', 'exception'], // Over, short or damaged.
]);

// A record SEFL voided, which says nothing about the freight.
const VOID = 'VOD';

/** The stage SEFL's own wording gives a scan, or a summary's location. */
export function seflWordingStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** The stage SEFL's wording, else its code, gives a scan. */
export function seflMappedStage(code: string, wording: string): Stage | undefined {
  return seflWordingStage(wording) ?? CODES.get(code.toUpperCase());
}

/** A scan's stage: SEFL's wording or code, else the shared wording rules, else nothing. */
export function seflStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = seflMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (code.toUpperCase() === VOID) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => seflMappedStage(code ?? '', wording),
  gaps: [{ code: VOID, note: 'A record SEFL voided; it says nothing about where the freight is.' }],
};
