import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/**
 * The stage FIRST LINE's map gives a row, by its `normalizeStatusWording` wording. The
 * forwarder's own rows are mapped here; the delivering partner's, such as USPS's, are left to
 * the shared wording rules.
 */
export function firstLineStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** The stage of one FIRST LINE row an aggregator relays, with its wording unchanged; a partner's row is left to the shared rules. */
export function firstLineScan(label: string): { stage: Stage; wording: string } | undefined {
  const stage = firstLineStage(null, normalizeStatusWording(label));
  return stage && { stage, wording: label };
}

export const statusMap: CarrierStatusMap = { stage: firstLineStage, gaps: [] };
