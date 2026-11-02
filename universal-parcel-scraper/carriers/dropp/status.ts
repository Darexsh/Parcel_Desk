import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

export type DroppStep = 'added' | 'airborne' | 'warehouse' | 'transit' | 'consignment' | 'delivered';

/**
 * The steps the tracker dates, in the order the page lists them, each with the
 * label Dropp's English tracking gives it. `etakef`, the expected arrival in
 * Iceland, is an estimate between `airborne` and `warehouse`, not a step.
 */
export const DROPP_STEPS: readonly { readonly step: DroppStep; readonly wording: string }[] = [
  { step: 'added', wording: 'Parcel expected' },
  { step: 'airborne', wording: 'Parcel on the way to Iceland' },
  { step: 'warehouse', wording: 'Parcel arrived at Dropp terminal' },
  { step: 'transit', wording: 'Parcel out for delivery' },
  { step: 'consignment', wording: 'Parcel ready for pickup' },
  { step: 'delivered', wording: 'Parcel delivered' },
];

const STAGES: ReadonlyMap<string, Stage> = new Map<DroppStep, Stage>([
  ['added', 'registered'], // The merchant created the order; the parcel is not with Dropp yet.
  ['airborne', 'in_transit'], // On the way to Iceland, for a parcel from abroad.
  ['warehouse', 'in_transit'], // At Dropp's terminal.
  ['consignment', 'ready_for_pickup'], // At the pickup point or locker.
  ['delivered', 'delivered'],
]);

/** The stage a step's code gives, where the code alone settles it. */
export function droppMappedStage(code: string): Stage | undefined {
  return STAGES.get(code.toLowerCase());
}

/**
 * A step's stage. `transit` takes a parcel from the terminal to where it is
 * handed out: to the door for a home delivery, or to the pickup point, whose
 * own step follows.
 */
export function droppStage(step: DroppStep, home: boolean): Stage | undefined {
  if (step === 'transit') return home ? 'out_for_delivery' : 'in_transit';
  return droppMappedStage(step);
}

// `transit` depends on the reply's `home` flag, so the code alone gives no stage.
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? droppMappedStage(code) : undefined),
  gaps: [],
};
