import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The milestones of Copa Courier's tracker, in capitals, without the station
 * code the page writes after them. The tracker carries no codes. Only wording
 * seen in replies is mapped; other wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['envio recibido en origen', 'accepted'],
  ['partiendo de origen o punto de transito', 'in_transit'],
  ['recibido en punto de transito', 'in_transit'],
  ['recibido en destino', 'in_transit'],
  ['arribo a estacion', 'in_transit'],
  ['llego al centro de distribucion', 'in_transit'],
  ['en proceso de aduana', 'customs'],
  ['liberado por aduana', 'in_transit'],
  ['en vehiculo de copa courier para su entrega', 'out_for_delivery'],
  // Handed on for delivery outside the station's own rounds: no delivery is recorded after it.
  ['entrega en area remota', 'in_transit'],
  ['confirmacion de entrega', 'delivered'],
  ['envio entregado', 'delivered'],
]);

/** The key of a wording: the app's form, without accents, which the tracker writes on some milestones and not others. */
function keyOf(wording: string): string {
  return normalizeStatusWording(wording).normalize('NFD').replace(/\p{M}/gu, '');
}

/** The stage the map gives a wording, if it knows it. */
export function copaCourierMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(keyOf(wording));
}

/** A wording's stage from the map, else from the shared wording rules; wording neither knows stays without one. */
export function copaCourierStage(wording: string): ClassifiedWording | null {
  const mapped = copaCourierMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : copaCourierMappedStage(wording)),
  gaps: [],
};
