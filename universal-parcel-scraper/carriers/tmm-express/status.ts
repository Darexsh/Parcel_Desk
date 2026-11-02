import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

type Entry = { code?: string; wording: string; stage: string };

const ENTRIES = statuses.entries as readonly Entry[];

/**
 * TMM Express's status codes, from the consignment data its tracking page
 * carries. The codes are the same in every language the page has.
 */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .filter((entry) => entry.code).map((entry) => [entry.code!, entry.stage as Stage]));

// Its wordings, for a code the map does not hold: the English ones without the
// remark the page can add after " - ", and those archived lookups showed in Russian and Ukrainian.
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage TMM Express's map gives a status code, else its wording. */
export function tmmExpressMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code.trim().toUpperCase()) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: TMM Express's map, else the shared wording rules, else nothing. */
export function tmmExpressStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = tmmExpressMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => tmmExpressMappedStage(code, wording),
  gaps: [],
};
