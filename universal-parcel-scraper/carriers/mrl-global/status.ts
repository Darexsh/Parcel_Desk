import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event labels of MRL Global's tracking page, which shows no codes. The
 * map covers the labels seen on the page and the stages its track-and-trace
 * API documentation lists; another label falls to the shared rules.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['manifest scan', 'registered'],
  ['pickup scan', 'accepted'],
  ['in transit', 'in_transit'],
  ['linehaul scan', 'in_transit'],
  ['receiver scan at destination depo', 'in_transit'],
  // Handed to an agent for the delivery; the page names neither the agent nor its number.
  ['onforward scan to an agent', 'in_transit'],
  // The page prints the depot in brackets after it; the parser takes it off first.
  ['scanned in depot', 'in_transit'],
  // A handling scan without further detail, seen all along a consignment's way.
  ['other scan', 'in_transit'],
  ['onboard delivery scan', 'out_for_delivery'],
  ['attempted delivery', 'failed_attempt'],
  ['ready for collection scan', 'ready_for_pickup'],
  ['confirmation of delivery', 'delivered'],
]);

/** The stage the map gives one of the page's labels, if it knows it. */
export function mrlMappedStage(label: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(label));
}

/** A label's stage: the map, else the shared wording rules, else nothing. */
export function mrlStage(label: string): ClassifiedWording | null {
  const mapped = mrlMappedStage(label);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(label, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its label: the page gives no code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : mrlMappedStage(wording)),
  gaps: [],
};
