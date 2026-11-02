import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scan wordings and item statuses Tanzania Posts Corporation's tracker
 * prints, in English and without a code. The shared rules read the arrival
 * scans as an acceptance, so the map names each wording seen in a reply;
 * another falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // Posted at the counter; the page names the office after the word, which the parser reads as the place.
  ['acceptance', 'accepted'],
  ['received at office of dispatch', 'in_transit'],
  ['received at destination office', 'in_transit'],
  // The item's status over the scans; the history has no delivery scan.
  ['delivered', 'delivered'],
]);
// Sent on to a region the page names in brackets: the posting region's hub, then the destination's.
const ON_TRANSIT = /^on transit to destination region\b/;

/** The stage the map gives a wording, if it knows it. */
export function tanzaniaPostsWordingStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? (ON_TRANSIT.test(key) ? 'in_transit' : undefined);
}

/** A wording's stage from the map, else the shared wording rules, else nothing, which keeps it visible for review. */
export function tanzaniaPostsStage(wording: string): ClassifiedWording | null {
  const mapped = tanzaniaPostsWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans and the item's status carry no code; the wording alone sets the stage. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : tanzaniaPostsWordingStage(wording)),
  gaps: [],
};
