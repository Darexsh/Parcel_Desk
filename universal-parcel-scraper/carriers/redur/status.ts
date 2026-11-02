import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** Upper case, without accents and with single spaces, as the scans are compared. */
function comparable(wording: string): string {
  return wording.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * The tracker's scan wordings, in Spanish as the adapter reads them and in
 * English as the tracker's English page shows them. Only wordings seen on the
 * tracker are mapped; another falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['DOCUMENTACION', 'registered'], // The sender's data reached Redur, dated to the day alone.
  ['DATA ENTERING', 'registered'],
  ['ENTRADA PLAZA ORIGEN', 'accepted'], // The first scan at the origin depot.
  ['INBOUND ORIGIN DEPOT', 'accepted'],
  ['SALIDA PLAZA ORIGEN', 'in_transit'],
  ['OUTBOUND ORIGIN DEPOT', 'in_transit'],
  ['ENTRADA PLAZA TRANSITO', 'in_transit'],
  ['INBOUND TRANSIT DEPOT', 'in_transit'],
  ['SALIDA PLAZA TRANSITO', 'in_transit'],
  ['OUTBOUND TRANSIT DEPOT', 'in_transit'],
  ['ENTRADA PLAZA DESTINO', 'in_transit'],
  ['INBOUND FINAL DEPOT', 'in_transit'],
  // Loaded on a truck for another country, where a partner delivers.
  ['CARGA CAMION T. INTERNACIONAL', 'in_transit'],
  ['TRUCK LOAD INTERNATIONAL TRAFFIC', 'in_transit'],
  // Waiting for a delivery day to be agreed with the recipient, and agreed.
  ['PENDIENTE DE FECHA CONCERTADA', 'in_transit'],
  ['FECHA DE ENTREGA CONCERTADA', 'in_transit'],
  ['BOOKING AGREED DATE', 'in_transit'],
  ['SALIDA A REPARTO', 'out_for_delivery'],
  ['OUT FOR DELIVERY', 'out_for_delivery'],
  ['DESTINATARIO AUSENTE', 'failed_attempt'],
  ['INCORRECT ADDRESS', 'failed_attempt'], // The parcel goes out again once the address is put right.
  ['CERRADO PERMANENTE/TEMPORAL', 'failed_attempt'], // The address was found closed.
  ['RECOGERAN EN AGENCIA', 'ready_for_pickup'], // Held at the depot for the recipient to collect.
  ['ENTREGA', 'delivered'],
  ['DELIVERY', 'delivered'],
  ['DEVOLUCION A ORIGEN', 'returned'], // On its way back to the sender.
]);

/** The stage Redur's wording gives a scan. */
export function redurMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(comparable(wording));
}

/** A scan's stage: its wording, else the shared wording rules, else nothing. */
export function redurStage(wording: string): ClassifiedWording | null {
  const mapped = redurMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry no codes: the map reads their wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : redurMappedStage(wording)),
  gaps: [],
};
