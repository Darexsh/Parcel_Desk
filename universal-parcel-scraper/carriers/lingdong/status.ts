import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// The booked flight's day, as month.day and in English, "预计10.28航班/Flight scheduled for October 28th", or as
// the day of the month in both, "预计30号航班【Expect flight 30th.】".
const FLIGHT_DAY = /^(预计)\d{1,2}\.\d{1,2}(航班\/flight scheduled for )[a-z]+ \d{1,2}(?:st|nd|rd|th)$/;
const FLIGHT_DATE = /^(预计)\d{1,2}(号航班【expect flight )\d{1,2}(?:st|nd|rd|th)(\.?】)$/;

/**
 * The stage Lingdong International's map gives a row, by its `normalizeStatusWording` wording,
 * with a booked flight's day read as an ellipsis.
 * A row's kind code, when it has one, groups many wordings and decides nothing.
 */
export function lingdongStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording.replace(FLIGHT_DAY, '$1…$2…').replace(FLIGHT_DATE, '$1…$2…$3'));
}

export const statusMap: CarrierStatusMap = { stage: lingdongStage, gaps: [] };
