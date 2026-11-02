import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Urbano's scan codes (`chk`), with the wording its tracker writes for each.
 * Only codes seen in replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['PU', 'registered'], // "PEDIDO CREADO": the order booked, the parcel not yet with Urbano.
  ['AO', 'accepted'], // "RECIBIMOS EN ORIGEN": received at the origin hub.
  ['CK', 'in_transit'], // "Entro a Pre-Embarque": loaded for the line haul.
  ['DD', 'in_transit'], // "DESPACHAMOS A SU CIUDAD": dispatched to the destination city.
  ['AR', 'in_transit'], // "LLEGO A LA CIUDAD DESTINO": arrived at the destination station.
  ['ER', 'out_for_delivery'], // "SALIO A ENTREGARSE"
  ['CV', 'failed_attempt'], // "INTENTAMOS ENTREGARTE": a visit that did not deliver, its reason after it.
  ['EN', 'delivered'], // "ENTREGAMOS TU PEDIDO"
]);

/**
 * The shipment's `id_proceso` where the tracking page gives it its own label
 * over the progress rail: "Devuelto" and "Listo para recoger". The other
 * steps of the rail follow the scans.
 */
const PROCESSES: ReadonlyMap<number, Stage> = new Map([
  [21, 'returned'],
  [23, 'ready_for_pickup'],
  [24, 'ready_for_pickup'],
]);

/** The stage Urbano's codes give a scan code. */
export function urbanoMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** The stage the page's label for a shipment's process gives, when it names one. */
export function urbanoProcessStage(process: number): Stage | undefined {
  return PROCESSES.get(process);
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function urbanoStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = urbanoMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? urbanoMappedStage(code) : undefined),
  gaps: [],
};
