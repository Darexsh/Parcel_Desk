import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Veloces' shipment status ids, which its lookup sends with each status's name.
 * Only ids seen in replies are mapped; another id falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'], // Guía Generada: the shop made the guide; Veloces has not collected the parcel.
  ['11', 'accepted'], // Recogido por transportadora: collected from the shop.
  ['2', 'accepted'], // Bodega Origen: received at the origin warehouse.
  ['3', 'in_transit'], // En Ruta: on its way, between cities or to the delivery round.
  ['13', 'in_transit'], // Bodega Destino: at the destination warehouse.
  ['8', 'out_for_delivery'], // En Camino: with the courier; each one starts a delivery attempt.
  ['5', 'failed_attempt'], // Novedad: the courier's report of an attempt that did not deliver, with its reason.
  ['17', 'exception'], // Novedad (En bodega): back at the warehouse, waiting for the incident to be solved.
  ['4', 'delivered'], // Entregado.
  ['16', 'returned'], // En Proceso de Devolución: the return to the shop has started.
  ['21', 'returned'], // Devolución en Bodega.
  ['22', 'returned'], // Devolución en ruta.
  ['9', 'returned'], // Devolución Proveedor: back with the shop.
]);

/** The stage Veloces' status ids give a status. */
export function velocesMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A status's stage: its id, else the shared wording rules, else nothing. */
export function velocesStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = velocesMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? velocesMappedStage(code) : undefined),
  gaps: [],
};
