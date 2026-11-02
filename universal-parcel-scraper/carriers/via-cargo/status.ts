import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Via Cargo's event types, which each scan carries with a fixed Spanish
 * wording. Only types seen in replies are mapped; another type falls to the
 * wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['ALTA', 'accepted'], // INGRESO A VIA CARGO: taken in at the sender's branch.
  ['MANI', 'in_transit'], // EN VIAJE A CD: on its way from the branch to a distribution centre.
  ['RECD', 'in_transit'], // Received at a distribution centre.
  ['CPCE', 'in_transit'], // EN VIAJE: left a distribution centre or a branch.
  // RECIBIDO EN DESTINO: at the destination branch, where the parcel either
  // waits for collection or goes out to the door; the reply does not say which.
  ['RCPV', 'in_transit'],
  ['ENTR', 'delivered'], // ENTREGADA.
]);

/** The stage Via Cargo's event type gives a scan. */
export function viaCargoMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its event type, else the shared wording rules, else nothing. */
export function viaCargoStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = viaCargoMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? viaCargoMappedStage(code) : undefined),
  gaps: [],
};
