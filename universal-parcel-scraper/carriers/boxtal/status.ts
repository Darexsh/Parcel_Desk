import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Boxtal files each scan of the collecting carrier under a state letter of its
 * own, beside the carrier's text. The tracking page shows the letter's label
 * (`boxtalState.*` in its translations): A waiting for pick-up, B waiting for
 * drop-off, C in transit, D exception, E delivery attempt, F and H delivered,
 * G at a relay point, R returned and Z other.
 */
const STATES: ReadonlyMap<string, Stage> = new Map([
  ['A', 'registered'],
  ['B', 'registered'],
  ['C', 'in_transit'],
  ['D', 'exception'],
  ['E', 'failed_attempt'],
  ['F', 'delivered'],
  ['G', 'ready_for_pickup'],
  ['H', 'delivered'],
  ['R', 'returned'],
]);

/** The stage Boxtal's state letter gives a scan. */
export function boxtalMappedStage(state: string | null): Stage | undefined {
  return state === null ? undefined : STATES.get(state);
}

/** A scan's stage: its state letter's, else the shared wording rules', else nothing. */
export function boxtalStage(state: string | null, description: string): ClassifiedWording | null {
  const mapped = boxtalMappedStage(state);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => boxtalMappedStage(code),
  gaps: [{ code: 'Z', note: 'Boxtal labels it "Other"; the collecting carrier\'s text decides.' }],
};
