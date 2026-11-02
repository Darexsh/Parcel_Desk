import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * TufesaPack's movement codes, which the tracker sends beside the wording its
 * page shows for a scan. Only codes seen in replies are mapped; another code
 * falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  // REGISTRO DE ENVIO, shown as "Envío Documentado": checked in at the origin branch's counter.
  ['RG', 'accepted'],
  // REGISTRO DE EMBARQUE: loaded on a coach.
  ['EM', 'in_transit'],
  // REGISTRO DE TRAYECTO: recorded at a stop on the coach's route.
  ['TK', 'in_transit'],
  // REGISTRO DE DESEMBARQUE: taken off the coach.
  ['DS', 'in_transit'],
  // ENTREGA DE ENVIO.
  ['EN', 'delivered'],
]);

// RECEPCION DE ENVIO EN CONTENEDOR, shown as "Recibido En Sucursal Destino":
// the parcel waits there when the recipient collects it, and goes on otherwise.
const DESTINATION_BRANCH = 'RC';

/** The stage TufesaPack's codes give a scan code alone. */
export function tufesaMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/**
 * A scan's stage: its code, else the shared wording rules, else nothing.
 * `collected` is a shipment the recipient collects at the destination branch.
 */
export function tufesaStage(code: string, wording: string, collected: boolean): ClassifiedWording | null {
  if (code.toUpperCase() === DESTINATION_BRANCH) return { stage: collected ? 'ready_for_pickup' : 'in_transit', source: 'carrier_map' };
  const mapped = tufesaMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  // The destination branch's receipt takes its stage from the shipment's delivery type, so the map leaves it out.
  stage: (code) => (code ? tufesaMappedStage(code) : undefined),
  gaps: [],
};
