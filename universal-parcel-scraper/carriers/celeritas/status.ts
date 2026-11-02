import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** Lower case, single spaces and no accents: the tracker writes some wordings with and some without them. */
function key(wording: string): string {
  return normalizeStatusWording(wording).normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * The scans Celeritas's tracker names, in Spanish. They carry no code. A
 * parcel the shop has registered but not handed over is pending receipt;
 * the cross-dock, origin-agency and local-platform scans are transit, also on
 * the way back. A delivery postponed at the Celeritas Point did not happen;
 * after a failed attempt the parcel waits at the transport agency for seven
 * days. An agreed delivery date leaves it waiting at the depot. A return on
 * its way to, or at, the returns warehouse is returned.
 */
const SCANS: ReadonlyMap<string, Stage> = new Map([
  ['envio pendiente de recibir', 'registered'],
  ['lectura en almacen de cruce', 'in_transit'],
  ['envio recibido en agencia de origen', 'in_transit'],
  ['recibido en plataforma local', 'in_transit'],
  ['envio en reparto', 'out_for_delivery'],
  ['pospuesta en punto', 'failed_attempt'],
  ['destinatario ausente', 'failed_attempt'],
  ['entrega concertada', 'in_transit'],
  ['disponible para recoger en agencia de transporte', 'ready_for_pickup'],
  ['devolucion preparada en plataforma local', 'returned'],
  ['devolucion entregada en almacen de destino', 'returned'],
]);

/**
 * The heading above the scans. "ENVIO DEVUELTO" holds for the whole shipment
 * even when a later cross-dock scan follows the return. "EN GESTION" only says
 * the shipment is open and leaves the stage to the scans.
 */
const HEADINGS: ReadonlyMap<string, Stage> = new Map([
  ['envio devuelto', 'returned'],
]);

/** The stage the map gives a scan's wording, if it knows it. */
export function celeritasScanStage(wording: string): Stage | undefined {
  return SCANS.get(key(wording));
}

/** The stage the heading gives the shipment, if the map knows it. */
export function celeritasHeadingStage(heading: string): Stage | undefined {
  return HEADINGS.get(key(heading));
}

/** A scan's stage from the map, else from the shared wording rules; wording neither knows stays without one. */
export function celeritasStage(wording: string): ClassifiedWording | null {
  const mapped = celeritasScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. The heading never comes as a scan. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : celeritasScanStage(wording)),
  gaps: [],
};
