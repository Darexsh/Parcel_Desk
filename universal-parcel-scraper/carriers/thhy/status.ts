import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);

/**
 * The stage Tianhui Hengyuan's map gives a row, by its `normalizeStatusWording` wording:
 * the carrier's own, or the English the adapter shows for it.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 */
export function thhyStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording);
}

/** The English the adapter shows for a row the carrier words only in Chinese, by its `normalizeStatusWording` wording. */
export const thhyEnglish = (_code: string | null, wording: string): string | undefined => WORDINGS.english(wording);

export const statusMap: CarrierStatusMap = { stage: thhyStage, gaps: [] };
