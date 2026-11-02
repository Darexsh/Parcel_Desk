import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const CODES: ReadonlyMap<string, Stage> = new Map([
  ['28.0', 'registered'], ['1.1', 'accepted'], ['1.2', 'accepted'],
  ['8.0', 'in_transit'], ['8.1', 'in_transit'], ['8.2', 'ready_for_pickup'], ['8.3', 'in_transit'],
  ['8.4', 'in_transit'], ['8.18', 'out_for_delivery'], ['8.20', 'in_transit'], ['4.5', 'exception'],
  // International exchange, by the operation list of the open-source lapaygroup/RussianPost client: the
  // exchange office where customs clears the item, transit, arrival in Russia, import and export, customs,
  // and the hand-over to the carrier abroad and the destination's post.
  ['8.5', 'customs'], ['8.6', 'in_transit'], ['8.7', 'in_transit'], ['8.8', 'in_transit'], ['8.13', 'in_transit'],
  ['9.1', 'in_transit'], ['9.2', 'in_transit'], ['10.0', 'in_transit'], ['11.0', 'customs'], ['14.1', 'in_transit'],
  ['33.1', 'in_transit'], ['33.2', 'in_transit'], ['33.3', 'in_transit'],
]);
const DELIVERY = new Set(['2.6', '2.25']);

/** A return operation starts the return leg; a later delivery completes that leg. */
export function russianPostStage(code: string, wording: string, returnLeg = false): ClassifiedWording | null {
  if (DELIVERY.has(code)) return { stage: returnLeg ? 'returned' : 'delivered', source: 'carrier_map' };
  if (code.startsWith('3.')) return { stage: 'exception', source: 'carrier_map' };
  const stage = CODES.get(code);
  if (stage) return { stage, source: 'carrier_map' };
  const staged = classifyWording(wording, 'in_transit');
  return staged.source === 'none' ? null : staged;
}

export const statusMap: CarrierStatusMap = {
  stage: code => code?.startsWith('3.') ? 'exception' : CODES.get(code ?? ''),
  gaps: [...DELIVERY].map(code => ({ code, note: 'Delivery completes the forward or return leg; the adapter reads it with the preceding return operation.' })),
};
