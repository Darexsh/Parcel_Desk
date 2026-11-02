import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status codes of FasTrak's shipment history. A row's wording can change
 * under the same code (`ARRHUB` has read both "ARRIVAL SCAN" and "ARRIVAL
 * HUB"), so the code decides. Only codes seen in replies are mapped; another
 * code falls to the wording.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // The shipper's order reached AIT, by upload or through the website; the freight is still with the shipper.
  ['UPLOAD', 'registered'],
  ['WEBENT', 'registered'],
  ['PUCOMP', 'accepted'],
  ['INTRAN', 'in_transit'],
  ['ARRHUB', 'in_transit'],
  // The destination terminal, before it unloads the freight.
  ['DEST', 'in_transit'],
  // Checked into the delivery terminal, which then calls the recipient to book the delivery.
  ['RECOVD', 'in_transit'],
  ['OFD', 'out_for_delivery'],
  ['POD', 'delivered'],
]);

/**
 * Wording without a code: the progress label the page shows over the
 * history, and the rows of the former eaFasTrak tracker.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['initiated', 'registered'],
  ['in transit', 'in_transit'],
  ['delivered', 'delivered'],
  ['shipment accepted by ait', 'accepted'],
  ['pickup complete', 'accepted'],
  ['confirmed on board/ in transit', 'in_transit'],
  ['shipment is in transit', 'in_transit'],
  ['arrived @ destination terminal', 'in_transit'],
  // The destination station calls to arrange the delivery.
  ['calling shipper/consignee', 'in_transit'],
]);

const GAPS: readonly { readonly code: string; readonly note: string }[] = [
  { code: 'EMAILD', note: 'The shipment\'s details emailed to the shipper or the delivery location; it moves nothing.' },
  { code: 'APPTDE', note: 'A delivery appointment and its window, stamped with the window\'s start: an estimate, not a scan.' },
];
const GAP_CODES: ReadonlySet<string> = new Set(GAPS.map((gap) => gap.code));

/** The stage the map gives a row's code, else its wording, if it knows either. */
export function aitMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code.toUpperCase()) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording));
}

/** A row's stage: the map, else nothing for a gap, else the shared wording rules, else nothing. */
export function aitStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = aitMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (code && GAP_CODES.has(code.toUpperCase())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its code and wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => aitMappedStage(code, wording),
  gaps: GAPS,
};
