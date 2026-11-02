import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Fukuyama's milestones, as the tracker's history rows name them, and its
 * states, as the summary words them ("配達完了です"). The tracker shows no codes,
 * and the shared wording rules read no Japanese, so a wording not listed here
 * has no stage.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['受付', 'accepted'], // Taken in at the sending branch.
  ['発送', 'in_transit'], // Left the sending branch.
  ['輸送中', 'in_transit'], // The summary while the parcel travels between branches.
  ['到着', 'in_transit'], // Reached the delivering branch.
  ['持出', 'out_for_delivery'], // Taken out on the delivery round.
  ['配達中', 'out_for_delivery'],
  ['持戻', 'failed_attempt'], // Brought back to the branch, typically because nobody was in.
  ['配達完了', 'delivered'],
]);

/** A wording without spaces or the sentence ending the summary adds. */
function key(wording: string): string {
  return wording.replace(/\s+/g, '').replace(/です。?$/, '');
}

/** The stage Fukuyama's wording gives a milestone or a summary. */
export function fukuyamaMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

/** A milestone's or summary's stage from the map, else nothing. */
export function fukuyamaStage(wording: string): ClassifiedWording | null {
  const stage = fukuyamaMappedStage(wording);
  return stage ? { stage, source: 'carrier_map' } : null;
}

/** What the map says about one milestone or summary, by its wording: the tracker shows no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : fukuyamaMappedStage(wording)),
  gaps: [],
};
