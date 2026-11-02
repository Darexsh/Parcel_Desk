import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The page's status codes (`haitatsuJokyoCode`), each with the sentence it
 * shows beside the number. Only codes seen with their sentence are mapped.
 * The page's script also files 02, 05, 06, 21, 23, 24 and 31 to 44 under its
 * progress steps, but a step can hold a failed run or a return as well, so
 * those codes stay unmapped until a reply shows what they say.
 */
const CODES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['16', 'accepted'], // 発送店にあります: at the branch that dispatches it.
  ['15', 'in_transit'], // 発送店を出発しています: left that branch.
  ['25', 'in_transit'], // 協力会社へ中継しています: handed to a partner company for the last leg.
  ['07', 'in_transit'], // 配達店に到着しています: at the branch that delivers it.
  ['14', 'out_for_delivery'], // 現在配達中です, sometimes with the hour it is due by.
  ['08', 'delivered'], // 配達済みです
  ['22', 'delivered'], // 配達済みです（再配達）: delivered on a second run.
]);

/**
 * The milestones the detail lists, each with the branch and the time it was
 * reached. 配達回送 is an extra one for a shipment handed on to a partner company.
 */
const MILESTONES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['受付', 'accepted'],
  ['発送', 'in_transit'],
  ['中継', 'in_transit'],
  ['到着', 'in_transit'],
  ['配達回送', 'in_transit'],
  ['持出', 'out_for_delivery'],
  ['配達', 'delivered'],
]);

/** The stage a status code gives, if the map knows it. */
export function seinoCodeStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** The stage a milestone gives, by its label without spaces. */
export function seinoMilestoneStage(label: string): Stage | undefined {
  return MILESTONES.get(label.replace(/\s+/g, ''));
}

/** A status code stages the summary; a scan has no code, and its milestone's label stages it. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? seinoCodeStage(code) : seinoMilestoneStage(wording)),
  gaps: [],
};
