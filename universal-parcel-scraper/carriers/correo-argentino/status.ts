import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The scans carry no code. Correo Argentino's own history names each event in
 * Spanish capitals; the international form's history uses the UPU's IPS event
 * names in English, mostly ending with their leg. The shared rules read most
 * of these names as no milestone at all.
 */
const SCANS: ReadonlyMap<string, Stage> = new Map([
  ['ingreso al correo', 'accepted'],
  ['en proceso de clasificación', 'in_transit'],
  ['llegada al centro de procesamiento', 'in_transit'],
  // Arrived from abroad at the international processing centre.
  ['llegada del país', 'in_transit'],
  // The import procedure: the addressee is told, declares the item to AFIP, pays, and customs releases it.
  ['en proceso de importación (*)', 'customs'],
  ['en proceso de importación', 'customs'],
  // Left Argentina; the post of the destination tracks it from there.
  ['salida del país', 'in_transit'],
  ['en poder del cartero', 'out_for_delivery'],
  ['receive item from customer', 'accepted'],
  ['receive item at office of exchange', 'in_transit'],
  ['insert item into bag', 'in_transit'],
  ['send item abroad', 'in_transit'],
  ['send item to domestic location', 'in_transit'],
  ['record item customs information', 'customs'],
  ['send item to customs', 'customs'],
  // Customs handed the item back: a release, which the shared rules read as customs.
  ['return item from customs', 'in_transit'],
  ['unsuccessful item delivery attempt', 'failed_attempt'],
  ['receive item at collection point for pick-up', 'ready_for_pickup'],
  ['deliver item', 'delivered'],
]);

/** The status column of a delivery visit ("INTENTO DE ENTREGA"), which says how it went. */
const VISITS: ReadonlyMap<string, Stage> = new Map([
  ['entregado', 'delivered'],
  // Collected at the branch it waited at.
  ['entrega en sucursal', 'delivered'],
  ['en espera en sucursal', 'ready_for_pickup'],
  ['desconocido', 'failed_attempt'],
  ['dirección insuficiente', 'failed_attempt'],
  // Nobody collected it in time, so it goes back to its sender.
  ['plazo vencido no reclamo', 'returned'],
]);

// The leg an IPS name ends with: "(Otb)", "(Inb)", "(Domestic)", or a foreign post's data, "(EDI-received)".
const LEG = /\s*\((?:otb|inb|domestic|edi-received)\)$/;
// A closed door, with the visit's number: "DOMICILIO CERRADO/1 VISITA".
const CLOSED = /^domicilio cerrado\b/;
const VISIT = 'intento de entrega';

/** A domestic scan's wording: the event, then, after a delivery visit, the status column saying how it went. */
export function scanWording(event: string, status: string): string {
  if (!status) return event;
  return event ? `${event}: ${status}` : status;
}

/** The stage the map gives Correo Argentino's wording, if it knows it. */
export function correoArgentinoScanStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  const scan = SCANS.get(key.replace(LEG, ''));
  if (scan) return scan;
  if (!key.startsWith(`${VISIT}: `)) return undefined;
  const status = key.slice(VISIT.length + 2);
  return VISITS.get(status) ?? (CLOSED.test(status) ? 'failed_attempt' : undefined);
}

/**
 * A scan's stage from the map, else from the shared wording rules. A delivery
 * visit without its status column has none, and wording neither knows stays
 * without a stage, so it remains visible for review.
 */
export function correoArgentinoStage(wording: string): ClassifiedWording | null {
  const mapped = correoArgentinoScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (normalizeStatusWording(wording) === VISIT) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : correoArgentinoScanStage(wording)),
  gaps: [
    { wording: VISIT, note: 'A delivery visit; its status column, read with it, says whether it delivered the item.' },
  ],
};
