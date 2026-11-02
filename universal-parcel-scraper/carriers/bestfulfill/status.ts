import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { subStatusStage } from '../../providers/seventeentrack/status.js';
import statuses from './statuses.json' with { type: 'json' };

const key = (code: string | null, wording: string) => JSON.stringify([code, wording]);
// The rows seen, by their sub-status and `normalizeStatusWording` wording.
const ROWS = new Map<string, Stage>((statuses.entries as readonly { code?: string; wording: string; stage: string }[])
  .map((entry) => [key(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.stage as Stage]));

/** 17TRACK's code: BestFulfill repeats "InfoReceived" after its underscore. */
const subCode = (code: string): string => (code === 'InfoReceived_InfoReceived' ? 'InfoReceived' : code);

/**
 * A scan's stage. BestFulfill files its scans and its partners' under
 * 17TRACK's sub-statuses, and the code decides where it is specific, with
 * 17TRACK's safeguards: generic transit yields to any reading of the wording,
 * a delivery code counts only with wording read as a delivery, and a customs
 * code yields to wording that says customs is done. Otherwise
 * the shared wording rules decide.
 */
export function bestfulfillStage(code: string | null, wording: string): ClassifiedWording | null {
  const seen = ROWS.get(key(code, normalizeStatusWording(wording)));
  if (seen) return { stage: seen, source: 'carrier_map' };
  const worded = classifyWording(wording, 'pending');
  const coded = code ? subStatusStage(subCode(code), worded.source === 'none' ? 'pending' : worded.stage, wording) : undefined;
  // A customs code on a scan that says customs is done ("customs cleared") yields to the wording.
  if (coded && !(coded === 'customs' && worded.source !== 'none' && worded.stage !== 'customs')) return { stage: coded, source: 'carrier_map' };
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const staged = bestfulfillStage(code, wording);
    return staged?.source === 'carrier_map' ? staged.stage : undefined;
  },
  gaps: [],
};
