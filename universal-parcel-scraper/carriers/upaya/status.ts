import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings of Upaya's tracker, which carries no code: a scan's heading,
 * then its own line. Until a rider collects the parcel the sender still has it,
 * so a pickup being assigned or failing is a registration. Only wordings seen
 * in replies are mapped; another falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['order created', 'registered'],
  ['pickup process: awaiting pickup assignment', 'registered'],
  ['pickup process: pickup assigned to rider', 'registered'],
  // The page shows it as in progress, and another pickup follows.
  ['pickup process: failed pickup', 'registered'],
]);
// Headings whose stage no line under them changes.
const HEADINGS: ReadonlyMap<string, Stage> = new Map([['cancelled', 'exception']]);
// The heading of the sender's pickup.
const PICKUP = /^pickup process:/;
// What the shared rules read in a recipient's pickup or delivery, which a sender's pickup is not.
const RECIPIENT_STAGES: ReadonlySet<Stage> = new Set(['ready_for_pickup', 'failed_attempt', 'out_for_delivery', 'delivered']);

/** The stage Upaya's own wording gives a scan, if the map knows it. */
export function upayaMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? HEADINGS.get(key.split(': ', 1)[0]!);
}

/**
 * A scan's stage from the map, else from the shared wording rules. A pickup
 * wording the map does not know keeps no stage the rules give a recipient's
 * pickup or delivery. Wording neither knows stays without a stage.
 */
export function upayaStage(wording: string): ClassifiedWording | null {
  const mapped = upayaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  if (worded.source === 'none') return null;
  return PICKUP.test(normalizeStatusWording(wording)) && RECIPIENT_STAGES.has(worded.stage) ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : upayaMappedStage(wording)),
  gaps: [],
};
