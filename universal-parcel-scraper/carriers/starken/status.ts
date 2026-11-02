import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Starken's `macro_estado`, the step of the tracking page's progress rail a
 * scan belongs to, and the `tipoTermino` that closes an order without a
 * delivery. Only codes seen in replies or in the page's script are mapped.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['EMITIDO', 'registered'], // The sender created the order; Starken has not received the parcel.
  ['ORIGEN', 'accepted'], // Received at, and leaving, the branch it was handed in at.
  ['TRANSITO', 'in_transit'],
  // At or on the way to the destination branch, before delivery or collection. A parcel
  // ready to collect says so in its wording.
  ['DESTINO', 'in_transit'],
  ['EN REPARTO', 'out_for_delivery'],
  ['ENTREGADO', 'delivered'],
  ['DEVUELTO', 'returned'],
  ['CONTACTO/TERMINO', 'exception'], // A presumed loss, logged as "PROCESANDO ENVIO".
  // How the page names an order closed without a delivery.
  ['EXTRAVIADO', 'exception'],
  ['ANULADO', 'exception'],
  ['DECOMISADO', 'exception'],
  ['REMATADO', 'exception'],
  ['REZAGO', 'exception'],
  ['CERRADO CON EXCEPCION', 'exception'],
  ['RECLAMO', 'exception'],
]);

/** The note the system adds every few days while a parcel waits, which moves nothing. */
export const STARKEN_WAITING = 'el envío sigue en proceso anterior';
// Wording that is more precise than its step of the rail.
const READY = /^listo para retiro\b/;
const ATTEMPT = /^intento de entrega\b/;

/** The stage Starken's codes give a step or closing code. */
export function starkenMappedStage(code: string): Stage | undefined {
  return CODES.get(code.trim().toUpperCase());
}

function mapped(code: string | null, wording: string): Stage | null | undefined {
  if (wording === STARKEN_WAITING) return null;
  if (READY.test(wording)) return 'ready_for_pickup';
  if (ATTEMPT.test(wording)) return 'failed_attempt';
  return code ? starkenMappedStage(code) : undefined;
}

/** A scan's stage: its wording where that is more precise, its code, else the shared wording rules. */
export function starkenStage(code: string, wording: string): ClassifiedWording | null {
  const stage = mapped(code, normalizeStatusWording(wording));
  if (stage) return { stage, source: 'carrier_map' };
  if (stage === null) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => mapped(code, wording) ?? undefined,
  gaps: ['TRANSITO', 'DESTINO'].map((code) => ({ code, wording: STARKEN_WAITING,
    note: 'Added every few days while the parcel waits, with no new scan; it moves nothing.' })),
};
