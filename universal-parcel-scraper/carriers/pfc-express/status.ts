import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { code?: string; wording: string; stage?: string };
const ENTRIES = statuses.entries as readonly Entry[];

/** The wordings seen on PFC's tracker and the older inquiry page, in `normalizeStatusWording` form. */
const WORDINGS = new Map<string, Stage>(ENTRIES.filter((entry) => !entry.code && entry.stage)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
/** The tracker's tabs, which class each parcel's item. */
const SUMMARIES = new Map<string, Stage | null>(ENTRIES.filter((entry) => entry.code)
  .map((entry) => [entry.code!, (entry.stage as Stage | undefined) ?? null]));
// China Post's scans, relayed in Chinese, name any office in brackets.
const OFFICE_SCANS: readonly (readonly [RegExp, Stage])[] = [
  [/^邮件(?:到达|离开)【[^】]+】/, 'in_transit'],
  [/^邮件已在【[^】]+】完成分拣/, 'in_transit'],
];
// The older inquiry page put the facility's code before some wordings, as in "PFCSZ,Picked up shipment.".
const FACILITY = /^([A-Z][A-Z0-9]{1,11})\s*,\s*(.+)$/;

/** The stage PFC's map gives a scan's wording, or a relayed China Post scan at any office. */
export function pfcExpressStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? OFFICE_SCANS.find(([pattern]) => pattern.test(key))?.[1];
}

/** A scan's wording and the facility the older page put before it, with the stage the map or the shared rules give it. */
export interface PfcExpressScan {
  readonly wording: string;
  readonly facility: string;
  readonly stage?: ClassifiedWording;
}

/** A scan's text read through the map; a wording the map does not know is left to the shared rules. */
export function pfcExpressScan(text: string): PfcExpressScan {
  const mapped = pfcExpressStage(text);
  if (mapped) return { wording: text, facility: '', stage: { stage: mapped, source: 'carrier_map' } };
  const prefixed = FACILITY.exec(text);
  const after = prefixed ? pfcExpressStage(prefixed[2]!) : undefined;
  if (after) return { wording: prefixed![2]!, facility: prefixed![1]!, stage: { stage: after, source: 'carrier_map' } };
  const worded = classifyWording(text, 'in_transit');
  return { wording: text, facility: '', ...(worded.source === 'none' ? {} : { stage: worded }) };
}

/**
 * The stage a tab of the tracker gives a parcel: null for one whose tab sets
 * none, undefined for a tab the map does not know.
 */
export function pfcExpressSummaryStage(summary: string): Stage | null | undefined {
  return SUMMARIES.get(summary);
}

/** Scans come without a code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === null ? pfcExpressStage(wording) : undefined),
  gaps: [],
};
