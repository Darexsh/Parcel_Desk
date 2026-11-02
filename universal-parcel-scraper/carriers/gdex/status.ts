import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * GDEX's scan wordings, in `normalizeStatusWording` form. Hub and branch
 * scans name the site: "Inbound to Kluang", "Outbound by Auto Hub".
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^picked up by courier$/, 'accepted'],
  [/^(?:inbound|outbound) (?:to|by|from)\b/, 'in_transit'],
  [/^in transit$/, 'in_transit'],
  [/^out for delivery$/, 'out_for_delivery'],
  // Filed under "In Transit": the parcel goes out again.
  [/^(?:unsuccessful delivery|undelivered) due to\b/, 'failed_attempt'],
  [/^delivered$/, 'delivered'],
];

/**
 * The app's category for a scan, its `status`, in lower case. "In Transit"
 * also holds failed deliveries, so it stages nothing on its own.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['pickup', 'accepted'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** The stage GDEX's own vocabulary gives a scan: its wording, else its category. */
export function gdexMappedStage(code: string | null, wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.find(([pattern]) => pattern.test(normalized))?.[1] ?? (code ? CODES.get(normalizeStatusWording(code)) : undefined);
}

/** A scan's stage: its wording or category, else the shared wording rules, else nothing. */
export function gdexStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = gdexMappedStage(code || null, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => gdexMappedStage(code, wording),
  gaps: [],
};
