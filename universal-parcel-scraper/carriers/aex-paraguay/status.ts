import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** A wording's key: lower case, single spaces, no accents and no closing full stop. */
function key(wording: string): string {
  return normalizeStatusWording(wording.normalize('NFD').replace(/\p{M}/gu, '')).replace(/[\s.]+$/, '');
}

/**
 * AEX's events and the guía's states beside them, in Spanish, without codes. A label the sender
 * generated is registered; the pickup and a reception at an AEX office accept the parcel, in
 * either order. A guía assigned to a driver for delivery is out for delivery.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // Events of the current page.
  ['el remitente genero la etiqueta de envio y el paquete esta pendiente de retiro por aex', 'registered'],
  ['recepcion en oficina de aex', 'accepted'],
  ['el paquete fue retirado y se encuentra en poder de aex', 'accepted'],
  ['asignado a repartidor para entrega', 'out_for_delivery'],
  ['entrega realizada', 'delivered'],
  // States of the current page.
  ['guia generada', 'registered'],
  ['paquete en oficinas de aex', 'accepted'],
  ['recoleccion realizada', 'accepted'],
  ['entregada', 'delivered'],
  // Steps of the current page's progress rail.
  ['paquete recibido por aex', 'accepted'],
  ['en camino', 'in_transit'],
  ['salio para entrega', 'out_for_delivery'],
  // Events and states of the former page, and states of AEX's API documentation.
  ['solicitud de servicio creada', 'registered'],
  ['pendiente', 'registered'],
  ['recepcion en oficinas de aex', 'accepted'],
  ['en oficinas de aex', 'accepted'],
  ['pickup realizado', 'accepted'],
  ['retiro realizado', 'accepted'],
  ['salida a ruta para entrega', 'out_for_delivery'],
  ['en ruta para entrega', 'out_for_delivery'],
  ['en ruta para la entrega', 'out_for_delivery'],
  ['entregado', 'delivered'],
]);

/** The stage the map gives an event or a state, if it knows it. */
export function aexMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

/**
 * An event's stage: the event, then the state beside it, from the map; else the shared wording
 * rules on the event, then on the state; else nothing.
 */
export function aexStage(event: string, state: string): ClassifiedWording | null {
  const mapped = aexMappedStage(event) ?? aexMappedStage(state);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  for (const wording of [event, state]) {
    const worded = wording ? classifyWording(wording, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}

/** The page shows wording only; every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : aexMappedStage(wording)),
  gaps: [],
};
