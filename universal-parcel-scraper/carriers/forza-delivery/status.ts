import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The stage ids of Forza's milestones, the page's code for each scan. Only
 * ids seen in replies are mapped; another id falls to the wording rules, as
 * do the incidents (45), whose wording is their classification.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['15', 'registered'], // Generado: the guía was created.
  ['1', 'registered'], // Solicitado: the sender asked for the collection.
  ['2', 'accepted'], // Recolectado: collected from the sender.
  ['11', 'in_transit'], // Arribó a las instalaciones: arrived at a Forza facility.
  ['10', 'in_transit'], // En Inventario: in a facility's stock.
  ['19', 'in_transit'], // En Tránsito: between facilities.
  ['4', 'out_for_delivery'], // En ruta: on the courier's round, the last scan before the delivery.
  ['5', 'delivered'], // Entregado.
]);

/** The stage Forza's stage ids give a scan. */
export function forzaMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its stage id, else the shared wording rules, else nothing, which keeps it visible for review. */
export function forzaStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = forzaMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? forzaMappedStage(code) : undefined),
  gaps: [],
};
