import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** A row's `astatus` for the planned dispatch date of a leg, which the parser stages by its place in the history. */
export const PLANNED_DISPATCH = 'Планируемая дата отправки';

/**
 * Flip Post's row statuses (`astatus`, up to a colon), which the tracking API sends beside the
 * row's town or leg. Another status gets no stage: the shared wording rules read no Russian.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['В пути', 'in_transit'], // On the road between the towns of the leg.
  ['Прибыло в г.', 'in_transit'], // Arrived in the town.
  ['Выдано курьеру на доставку', 'out_for_delivery'],
  // Returns taken back from the courier: the parcel came back from the round undelivered.
  ['Прием возвратов от курьера', 'failed_attempt'],
  ['Доставлено', 'delivered'], // The API puts the receiver's name after a colon.
]);

/** The stage Flip Post's statuses give a row's status, or undefined. */
export function flippostStage(code: string): Stage | undefined {
  return CODES.get(code);
}

export const statusMap: CarrierStatusMap = {
  // A planned dispatch is registered as the first row and in transit after a movement, so its
  // status alone has no stage.
  stage: (code) => (code ? flippostStage(code) : undefined),
  gaps: [],
};
