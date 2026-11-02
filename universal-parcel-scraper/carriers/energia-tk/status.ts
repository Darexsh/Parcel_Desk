import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * TK Energia's state codes (`idState`). A state's sub-state (`idSubState`)
 * says whether cargo at a warehouse is on its way or ready for issue; the
 * provider code is both, as `1-3`.
 */
const STATES: ReadonlyMap<number, Stage> = new Map([
  // The tracker's "cargo with the sender": the receipt is made out, the cargo
  // has not reached an Energia warehouse.
  [0, 'registered'],
  [3, 'registered'],
  [1, 'in_transit'], // At a warehouse.
  [2, 'in_transit'], // On a trip between two cities.
  [20, 'delivered'], // Handed out.
]);
const AT_WAREHOUSE = 1;
const READY_FOR_ISSUE = 3;

/**
 * The labels the tracker itself reads: it flags a receipt "Выдана" or
 * "Готов к выдаче" by its state's own label, and words cargo still with the
 * sender as "Груз у отправителя".
 */
const LABELS: ReadonlyMap<string, Stage> = new Map([
  ['груз у отправителя', 'registered'],
  ['готов к выдаче', 'ready_for_pickup'],
  ['выдана', 'delivered'],
]);

/** The stage Energia's state and sub-state give a provider code such as `1-3`. */
export function energiaMappedStage(code: string): Stage | undefined {
  const match = /^(\d{1,4})-(\d{1,4})$/.exec(code);
  if (!match) return undefined;
  const [state, sub] = [Number(match[1]), Number(match[2])];
  if (state === AT_WAREHOUSE && sub === READY_FOR_ISSUE) return 'ready_for_pickup';
  return STATES.get(state);
}

/** A state's stage: its codes, else the tracker's own label, else the shared wording rules, else nothing. */
export function energiaStage(code: string, label: string, wording: string): ClassifiedWording | null {
  const stage = energiaMappedStage(code) ?? LABELS.get(normalizeStatusWording(label));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? energiaMappedStage(code) : undefined) ?? LABELS.get(wording),
  gaps: [
    { wording: 'не готова к выдаче', note: 'The tracker\'s flag for a receipt neither handed out nor ready for issue; a summary of the states, not one of them.' },
  ],
};
