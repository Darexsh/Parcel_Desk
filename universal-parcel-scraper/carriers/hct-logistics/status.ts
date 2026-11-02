import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// The branch or centre a sentence names, as in 貨件已抵達中和營業所，分貨中。
const PLACE = '[^，。]+';
// The pieces a branch counted, after its intake and delivery sentences.
const PIECES = '(?:貨物件數共\\d+件。)?';

/**
 * HCT's scan sentences, as its app's tracking page writes them. They carry no
 * code and name the branch in charge, so a sentence's form is the key. The
 * stages follow the labels HCT's website gives the same sentences.
 */
const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  // The first branch has the parcel; the website labels it 已集貨.
  [new RegExp(`^貨件已抵達${PLACE}，貨件整理中。${PIECES}$`), 'accepted'],
  // Sorting at a branch on the way; the website labels it 轉運中.
  [new RegExp(`^貨件已抵達${PLACE}，分貨中。$`), 'in_transit'],
  [new RegExp(`^貨件已由${PLACE}發出，前往配送站途中。$`), 'in_transit'],
  // Kept at a branch; the website labels it 暫置營業所.
  [new RegExp(`^貨件由${PLACE}保管中。$`), 'in_transit'],
  [new RegExp(`^貨件由${PLACE}人員配送中。$`), 'out_for_delivery'],
  [new RegExp(`^貨件已由${PLACE}送達。${PIECES}$`), 'delivered'],
  // The older tracker's summary of a signed delivery.
  [/^收貨人簽收完畢$/, 'delivered'],
  [/^與客戶另約時間配送。$/, 'failed_attempt'],
  [/^收貨人地址異常。$/, 'exception'],
  // A pickup the sender booked: its notice and the driver sent, both 取件中 on the website.
  [/^取貨通知處理中$/, 'registered'],
  [new RegExp(`^${PLACE}已派遣人員取件中。$`), 'registered'],
  // Collected from the sender; the website labels it 已取件.
  [new RegExp(`^${PLACE}已至客戶端取回貨件。$`), 'accepted'],
];

const NOTICES: readonly (readonly [string, string])[] = [
  ['已電話聯繫，無人接聽。', 'A call nobody answered, on a pickup or a delivery round: it does not say where the parcel is.'],
  ['另約時間再次取件。', 'A pickup moved to another time: the parcel stays with the sender, at the stage it had.'],
];

/** The stage HCT's sentence gives a scan, whichever branch it names. */
export function hctMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return PATTERNS.find(([pattern]) => pattern.test(key))?.[1];
}

/** A scan's stage: its sentence, else the shared wording rules, else nothing. */
export function hctStage(wording: string): ClassifiedWording | null {
  const mapped = hctMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => hctMappedStage(wording),
  gaps: NOTICES.map(([wording, note]) => ({ wording, note })),
};
