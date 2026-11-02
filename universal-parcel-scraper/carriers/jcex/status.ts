import { classifyWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { SUB_STAGES } from '../../providers/seventeentrack/status.js';
import statuses from './statuses.json' with { type: 'json' };

const key = (code: string | null, wording: string) => JSON.stringify([code, wording]);
// The rows seen, by their code and `normalizeStatusWording` wording.
const ROWS = new Map<string, Stage>(statuses.entries
  .map((entry) => [key('code' in entry ? entry.code ?? null : null, normalizeStatusWording(entry.wording)), entry.stage as Stage]));

/**
 * The stage JCEX's map gives a row. JCEX files its scans under 17TRACK's
 * sub-statuses (`platformEventCode`), and the code decides for rows the map
 * has not seen: JCEX's own event codes group scans of several stages, and the
 * code keeps its origin warehouse's "Arrive at the delivery point" in transit.
 * JCEX also files its handover to the delivering partner as delivered, so
 * `Delivered_Other` counts only with wording the shared rules read as a
 * delivery. A row without a code is read by its wording.
 */
export function jcexStage(code: string | null, wording: string): Stage | undefined {
  const seen = ROWS.get(key(code, wording));
  if (seen || !code) return seen;
  const mapped = Object.hasOwn(SUB_STAGES, code) ? SUB_STAGES[code] : undefined;
  if (mapped === 'delivered' && classifyWording(wording, 'pending').stage !== 'delivered') return undefined;
  return mapped;
}

export const statusMap: CarrierStatusMap = { stage: jcexStage, gaps: [] };
