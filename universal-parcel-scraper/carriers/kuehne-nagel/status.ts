import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The public tracker names every milestone with a label key such as
// "location-milestone.arrival.in-delivery.road" and words it from its own
// English messages. The code is the key without its family prefix, and the
// code alone decides the stage. Entries without a stage are notices and
// documents that move nothing.
const STAGES = new Map<string, Stage>(statuses.entries.flatMap(entry =>
  entry.stage ? [[entry.code, entry.stage as Stage] as const] : []));
const LABELS = new Map<string, string>(statuses.entries.map(entry => [entry.code, entry.wording] as const));

/** The stage of one Kuehne+Nagel milestone code, or undefined for a notice or a code the map does not know. */
export function kuehneNagelStage(code: string): Stage | undefined {
  return STAGES.get(code);
}

/** The tracker's English wording for a milestone code, when its messages hold one. */
export function kuehneNagelLabel(code: string): string | undefined {
  return LABELS.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: code => code ? kuehneNagelStage(code) : undefined,
  gaps: statuses.entries.flatMap(entry => entry.stage ? [] : [{ code: entry.code, note: entry.note! }]),
};
