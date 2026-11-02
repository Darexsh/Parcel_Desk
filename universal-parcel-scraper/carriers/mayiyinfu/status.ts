import type { Stage } from '../../core/status/index.js';
import { statusWordings } from '../../core/status/english.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = statusWordings(statuses.entries);
// A row relayed from the delivery carrier can end with its tracking link in brackets.
const LINK = /\s*\([^()]*https?:\/\/[^()]*\)$/;
// Mayi Yinfu's flight rows lead with the step, then a comma, the day it expects and a translation.
const STEP = /^(\p{Script=Han}+)[，,]/u;
/** The flight booked for the parcel, a row of the scripted track: still to come. */
export const FLIGHT_BOOKED = /^已排航班$/u;
// The day a flight row expects the next flight or landing: "，预计6号的航班", "，二程预计8号的航班", "，预计8号落地".
const EXPECTED_DAY = /^(\p{Script=Han}+)[，,]\p{Script=Han}*预计\d{1,2}号/u;

/**
 * The stage Mayi Yinfu's map gives a row, by its `normalizeStatusWording`
 * wording, else by that wording without the partner's link, else by the step
 * it leads with. A row's kind code groups many wordings and decides nothing.
 */
export function mayiyinfuStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.stage(wording) ?? WORDINGS.stage(wording.replace(LINK, '')) ?? WORDINGS.stage(STEP.exec(wording)?.[1] ?? '');
}

/**
 * The English a flight row shows, by its `normalizeStatusWording` wording: its
 * step's, without the day it expects, which is still to come.
 */
export function mayiyinfuEnglish(_code: string | null, wording: string): string | undefined {
  const step = EXPECTED_DAY.exec(wording)?.[1];
  return step ? WORDINGS.english(step) : undefined;
}

export const statusMap: CarrierStatusMap = { stage: mayiyinfuStage, gaps: [] };
