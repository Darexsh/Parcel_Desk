import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's job codes: `OUT` when a branch or office sends the consignment
 * on, `IN` when the next one receives it. Both are legs inside the network.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['OUT', 'in_transit'],
  ['IN', 'in_transit'],
]);

/**
 * The status line's wordings, as "Out To … On Dated …", and the booking the
 * adapter reads from the page's booking detail. A return or an undelivered
 * consignment was not seen, so other wordings fall to the shared rules.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^\s*BOOKED\b/i, 'accepted'],
  [/^\s*OUT TO\b/i, 'in_transit'],
  [/^\s*RECEIVED AT\b/i, 'in_transit'],
  [/^\s*IN[\s-]?TRANSI(?:S)?T\b/i, 'in_transit'],
  [/^\s*DELIVERED\b/i, 'delivered'],
];

/** The stage Shree Tirupati Courier's job codes, else its wordings, give a scan. */
export function tirupatiMappedStage(code: string | null, wording: string): Stage | undefined {
  const coded = code ? CODES.get(code.toUpperCase()) : undefined;
  return coded ?? WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** A scan's stage: the carrier's own code or wording, else the shared wording rules, else nothing. */
export function tirupatiStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = tirupatiMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => tirupatiMappedStage(code, wording),
  gaps: [],
};
