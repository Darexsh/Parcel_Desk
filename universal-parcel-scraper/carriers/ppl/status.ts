import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Every scan of PPL's tracking service carries an event code, and the code
// alone decides the stage. The wording follows the requested language and
// several codes share one wording, so it is never read. Entries without a
// stage are cash-on-delivery payment steps: they move nothing.
const CODES = new Map<string, Stage>(statuses.entries.flatMap(entry =>
  entry.stage ? [[entry.code, entry.stage as Stage] as const] : []));

/** The stage of one PPL event code, or undefined for a payment step or a code the map does not know. */
export function pplStage(code: string): Stage | undefined {
  return CODES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: code => code ? pplStage(code) : undefined,
  gaps: statuses.entries.flatMap(entry => entry.stage ? [] : [{ code: entry.code, note: entry.note! }]),
};
