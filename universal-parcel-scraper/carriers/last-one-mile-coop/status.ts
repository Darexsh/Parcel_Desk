import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The co-op's cargo states (貨物状況), as the tracker's history rows and its
 * list name them, and as the sentence over a parcel's history words them
 * ("配達完了しています。"). The tracker shows no codes, and the shared wording
 * rules read no Japanese, so a wording not listed here has no stage.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['引受', 'accepted'], // Taken in at a co-op centre, and again by the member company that delivers.
  ['中継連絡', 'in_transit'], // The co-op's headquarters hands the parcel over to the member company that delivers.
  ['配達中', 'out_for_delivery'],
  ['配達完了', 'delivered'],
]);

/** A wording without spaces or the ending the sentence adds. */
function key(wording: string): string {
  return wording.replace(/\s+/g, '').replace(/(?:しています|しました|です)。?$/, '');
}

/** The stage the co-op's wording gives a state or a row. */
export function lastOneMileMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

/** A state's or row's stage from the map, else nothing. */
export function lastOneMileStage(wording: string): ClassifiedWording | null {
  const stage = lastOneMileMappedStage(wording);
  return stage ? { stage, source: 'carrier_map' } : null;
}

/** What the map says about one state, by its wording: the tracker shows no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : lastOneMileMappedStage(wording)),
  gaps: [],
};
