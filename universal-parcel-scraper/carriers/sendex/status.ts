import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * A wording's key: lower case, single spaces and no accents. The tracker
 * writes the same movement with and without accents ("LLEGO", "LLEGÓ"), and
 * one sentence with a stray one ("INSTALACIÓNES").
 */
function key(wording: string): string {
  return normalizeStatusWording(wording.normalize('NFD').replace(/\p{M}/gu, ''));
}

/**
 * Sendex's movements, in Spanish capitals and without a code. Older guías
 * carry sentences ("EL ENVÍO …"), newer ones short labels. A parcel received
 * at the origin branch or picked up from the sender is accepted; arrivals and
 * departures between branches and operations centres (COP, CENTRO OP) are
 * transit. "ENVÍO SALE DE COP" can repeat daily at the destination branch
 * before the delivery round, so it stays transit.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // Short labels.
  ['recibido en oficina', 'accepted'],
  ['en transito', 'in_transit'],
  ['recibido en oficina destino', 'in_transit'],
  ['envio sale de cop', 'in_transit'],
  ['en ruta para entrega', 'out_for_delivery'],
  ['entregado', 'delivered'],
  // The former tracker's overall status of a delivered guía.
  ['entregada', 'delivered'],
  // Sentences.
  ['el envio fue recolectado en origen por sendex', 'accepted'],
  ['el envio llego a las instalaciones de sendex', 'in_transit'],
  ['el envio salio hacia la oficina destino o de enlace', 'in_transit'],
  ['el envio llego a la oficina destino o de enlace', 'in_transit'],
  ['el envio se encuentra en el vehiculo para su entrega', 'out_for_delivery'],
  ['envio con intento de entrega no exitoso', 'failed_attempt'],
  ['el envio fue entregado', 'delivered'],
]);

/** The stage the map gives a movement's wording, if it knows it. */
export function sendexMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

/** A movement's stage: the map, else the shared wording rules, else nothing. */
export function sendexStage(wording: string): ClassifiedWording | null {
  const mapped = sendexMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The movements carry wording only; every wording the tracker was seen to use is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : sendexMappedStage(wording)),
  gaps: [],
};
