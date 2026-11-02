import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The labels YCS's stations give their own scans. Each comes with a numeric
 * code, but one code covers several steps (601 for a partner's intake,
 * departure and delivery round alike), so the label is the key.
 */
const LABELS: ReadonlyMap<string, Stage> = new Map([
  ['檔案上傳成功', 'registered'], // The sender's file reached YCS; the parcel has not.
  ['已取件', 'accepted'],
  ['已集貨', 'accepted'],
  ['轉運中', 'in_transit'],
  ['進站貨件整理中', 'in_transit'],
  ['分貨中', 'in_transit'],
  ['貨到站所', 'in_transit'],
  ['人員配送中', 'out_for_delivery'],
  ['配送中', 'out_for_delivery'],
  ['已配達', 'delivered'],
  ['配完', 'delivered'],
]);

// The branch or centre a partner's sentence names, as in 貨件已抵達…營業所，分貨中。
const PLACE = '([^，。]+)';
// The pieces a branch counted, after its intake and delivery sentences.
const PIECES = '(?:貨物件數共\\d+件。)?';

/**
 * HCT Logistics' sentences, which YCS relays for the parcels HCT delivers for
 * it. They name HCT's branch or centre in charge. YCS has already picked the
 * parcel up when HCT takes it in, so HCT's intake is a step on the way.
 */
const RELAYED: readonly (readonly [RegExp, Stage])[] = [
  [new RegExp(`^貨件已抵達${PLACE}，貨件整理中。${PIECES}$`), 'in_transit'],
  [new RegExp(`^已由${PLACE}取件完成。$`), 'in_transit'],
  [new RegExp(`^貨件已抵達${PLACE}，分貨中。$`), 'in_transit'],
  [new RegExp(`^貨件已由${PLACE}發出，前往配送站途中。$`), 'in_transit'],
  [new RegExp(`^貨件由${PLACE}人員配送中。$`), 'out_for_delivery'],
  [new RegExp(`^貨件已由${PLACE}送達。${PIECES}$`), 'delivered'],
];

function relayed(wording: string): { stage: Stage; place: string } | undefined {
  for (const [pattern, stage] of RELAYED) {
    const match = pattern.exec(wording);
    if (match) return { stage, place: match[1]!.trim() };
  }
  return undefined;
}

/** The branch or centre a relayed HCT sentence names. */
export function ycsRelayedPlace(wording: string): string | undefined {
  return relayed(wording.trim())?.place;
}

/** The stage YCS's label, or the HCT sentence it relays, gives a scan. */
export function ycsMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return LABELS.get(key) ?? relayed(key)?.stage;
}

/** A scan's stage: its label or sentence, else the shared wording rules, else nothing. */
export function ycsStage(wording: string): ClassifiedWording | null {
  const mapped = ycsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => ycsMappedStage(wording),
  gaps: [],
};
