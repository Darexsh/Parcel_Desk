import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Servientrega's process codes (`IdProceso`), one per scan. Only codes seen in
 * replies are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'], // Guide generated.
  ['2', 'accepted'], // Admitted at a service point (CDS).
  ['3', 'registered'], // Made ready at the sender's for the pickup round.
  ['4', 'accepted'], // Made ready at the service point for the pickup round.
  ['6', 'accepted'], // First entry at the origin logistics centre.
  ['9', 'out_for_delivery'], // In the delivery zone.
  ['10', 'failed_attempt'], // Back at the logistics centre from a delivery round, often with the reason.
  ['11', 'delivered'], // Delivery verified.
  ['12', 'in_transit'], // Left for the destination town.
  ['14', 'in_transit'], // Entered a logistics centre on the way.
  ['15', 'in_transit'], // Taken off the delivery round back to the local warehouse.
  ['17', 'in_transit'], // In transit at an intermediate town.
  ['18', 'in_transit'], // Leaving an intermediate town.
  ['24', 'delivered'], // Reported delivered by the courier; a verification follows.
  ['25', 'exception'], // Notice that the parcel goes back, with the reason.
  ['32', 'out_for_delivery'], // Handed over for delivery to the door.
]);

/**
 * The guide's overall state (`estadoActual`), which comes without a code. The
 * tracker's script names more states than replies showed.
 */
const STATES: ReadonlyMap<string, Stage> = new Map([
  ['recibido', 'accepted'],
  ['recibido del cliente', 'accepted'],
  ['en procesamiento', 'in_transit'],
  ['procesado', 'in_transit'],
  ['siniestrado', 'exception'], // Lost or damaged in Servientrega's care.
  ['entregado', 'delivered'],
  ['entregado a remitente', 'returned'],
]);

/** The stage Servientrega's process codes give a scan. */
export function servientregaMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** The stage of the guide's overall state, read case-insensitively. */
export function servientregaStateStage(state: string): Stage | undefined {
  return STATES.get(state.toLocaleLowerCase('es').trim().split(/\s+/).join(' '));
}

/** A scan's stage: its process code, else the shared wording rules, else nothing. */
export function servientregaStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = servientregaMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? servientregaMappedStage(code) : servientregaStateStage(wording)),
  gaps: [],
};
