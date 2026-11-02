import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);
// A flight row names the day it expects the flight as month-day: "预计10-22飞".
const FLIGHT_DAY = /(预计)\d{1,2}-\d{1,2}(飞)$/u;

// The depot hand-over row starts with a month-day: "10-31 已交仓 留意官网更新".
const HANDED_OVER_DAY = /^\d{1,2}-\d{1,2}( 已交仓 留意官网更新)$/u;

/** The key a row's `normalizeStatusWording` wording is mapped under: a flight's or a hand-over's day becomes an ellipsis. */
export const mesoGlobalScanKey = (wording: string): string => wording.replace(FLIGHT_DAY, '$1…$2').replace(HANDED_OVER_DAY, '…$1');

/**
 * The stage Meso-global's map gives a row, by its whole `normalizeStatusWording`
 * wording: Meso-global's own, or the English the adapter shows for it.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 */
export function mesoGlobalStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(mesoGlobalScanKey(wording));
}

/**
 * The English the adapter shows for a row Meso-global words only in Chinese, by
 * its `normalizeStatusWording` wording; a flight row's without the day it
 * expects, which is still to come, and a hand-over row's without its day.
 */
export const mesoGlobalEnglish = (_code: string | null, wording: string): string | undefined =>
  WORDINGS.english(mesoGlobalScanKey(wording));

export const statusMap: CarrierStatusMap = { stage: mesoGlobalStage, gaps: [] };
