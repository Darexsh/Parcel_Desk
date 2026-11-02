import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wording of the history rows of Dohrn's XML trace. The rows carry no
 * code; the shipment's lifecycle above them has one.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  // The shipper asked for a pickup; the freight is not collected yet.
  ['pickup request received', 'registered'],
  ['picked up', 'accepted'],
  ['scanned on dock', 'in_transit'],
  ['freight unloaded', 'in_transit'],
  ['loaded on trailer', 'in_transit'],
  // Loaded at a terminal on the way onto the trailer bound for the delivering terminal.
  ['loaded on trailer for delivery', 'in_transit'],
  ['trailer arrived', 'in_transit'],
  // A partner carrier takes the freight for its last leg.
  ['enroute to connecting line', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  // The delivery run left without the freight; it goes out again.
  ['attempted - no frt on truck', 'failed_attempt'],
  ['delivered', 'delivered'],
]);

// Rows whose wording ends with a terminal or a day: "Trailer Departed For Sturgeon, Mo",
// "Appointment Set: 10/18/21" (a delivery appointment booked with the consignee).
const PREFIXES: readonly (readonly [RegExp, Stage])[] = [
  [/^trailer departed for \S/, 'in_transit'],
  [/^appointment set:\s*\d/, 'in_transit'],
];

/**
 * Rows the trace lists and Dohrn's tracking page leaves out: a trailer
 * manifest, whose place can be another terminal than the one holding the
 * freight, and the driver's run to the consignee after "Out For Delivery".
 */
const HIDDEN = new Set(['manifested', 'en-route']);

/** The shipment's lifecycle codes: 80 is a delivery, 0 a rate quote. */
const LIFECYCLES: ReadonlyMap<string, Stage> = new Map([['80', 'delivered']]);
export const QUOTE_LIFECYCLE = '0';

/** The stage the map gives a history row's wording, if it knows it. */
export function dohrnMappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return STAGES.get(normalized) ?? PREFIXES.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** Whether a row is one the tracking page leaves out. */
export function dohrnHiddenRow(wording: string): boolean {
  return HIDDEN.has(normalizeStatusWording(wording));
}

/**
 * A row's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function dohrnStage(wording: string): ClassifiedWording | null {
  const mapped = dohrnMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The lifecycle's stage: its code, else its wording through the row map and the shared rules. */
export function dohrnLifecycleStage(code: string, wording: string): ClassifiedWording | null {
  const coded = LIFECYCLES.get(code);
  if (coded) return { stage: coded, source: 'carrier_map' };
  return wording ? dohrnStage(wording) : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? LIFECYCLES.get(code) : HIDDEN.has(wording) ? undefined : dohrnMappedStage(wording)),
  gaps: [
    { wording: 'manifested', note: 'A trailer manifest, which Dohrn\'s tracking page leaves out; its place can be another terminal than the one holding the freight.' },
    { wording: 'en-route', note: 'The driver\'s run to the consignee after "Out For Delivery", which Dohrn\'s tracking page leaves out.' },
    { code: QUOTE_LIFECYCLE, note: 'A rate quote filed under the number, not a shipment.' },
  ],
};
