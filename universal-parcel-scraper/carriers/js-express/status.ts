import { statusWordings } from '../../core/status/english.js';
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { chinaPostRelayedStage } from '../china-post/status.js';
import { imileRelayedStage } from '../imile/status.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage?: string; readonly english?: string; readonly unmapped?: boolean; readonly note?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * JS Express's rows carry wording only: its own warehouse and flight lines,
 * then those of the partners that fly, clear and deliver the parcel, in their
 * words. The map is the wording recorded in `statuses.json`, by its
 * `normalizeStatusWording` form, and the English an entry shows for its
 * Chinese, then China Post's domestic scans and iMile's as JS Express relays them. The
 * shared rules read a destination agent's pickup at the airport, or a
 * courier's receipt, as an acceptance.
 */
const WORDINGS = statusWordings(ENTRIES.flatMap(({ wording, stage, english }) => stage ? [{ wording, stage, english }] : []));

/** A partner's record of the parcel's data: no scan, so no stage. */
const GAPS = ENTRIES.filter((entry) => entry.unmapped)
  .map((entry) => ({ wording: normalizeStatusWording(entry.wording), note: entry.note ?? '' }));
const GAP_WORDINGS = new Set(GAPS.map((gap) => gap.wording));

// USPS's forwarding alert as JS Express relays it, with the time, day and town it names: the parcel goes on to another
// address, as USPS's own map reads its "Forwarded".
const FORWARDED = /^alert, forwarded -> your item was forwarded to a different address\b/;

// iMile's scans as its destination courier, which open with the centre's name in 【】, take iMile's reading.
const mappedStage = (normalized: string): Stage | undefined =>
  WORDINGS.stage(normalized) ?? (FORWARDED.test(normalized) ? 'in_transit' : undefined) ?? chinaPostRelayedStage(normalized)
    ?? imileRelayedStage(normalized);

/** The stage JS Express's map gives a row's wording. */
export function jsExpressMappedStage(wording: string): Stage | undefined {
  return mappedStage(normalizeStatusWording(wording));
}

/** The English shown for a row's wording in Chinese, or undefined. */
export const jsExpressEnglish = (wording: string): string | undefined => WORDINGS.english(normalizeStatusWording(wording));

/** A row's stage: the map, else the shared wording rules, else nothing. A recorded gap has none. */
export function jsExpressStage(wording: string): ClassifiedWording | null {
  if (GAP_WORDINGS.has(normalizeStatusWording(wording))) return null;
  const mapped = jsExpressMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : mappedStage(wording)),
  gaps: GAPS,
};
