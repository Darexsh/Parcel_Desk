import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const labels: Record<string, ClassifiedStatus> = {
  NOTIFICADO: { status: 'pending', stage: 'registered' },
  ACEPTADA: { status: 'in_transit', stage: 'accepted' },
  'EN TRANSITO': { status: 'in_transit', stage: 'in_transit' },
  'EN REPARTO': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'DISPONIBLE EN PUNTO NACEX': { status: 'in_transit', stage: 'ready_for_pickup' },
  AUSENTE: { status: 'exception', stage: 'failed_attempt' },
  // A redelivery, address change or pickup point the recipient agreed puts
  // the parcel back on its way; the agency's request to be contacted and an
  // incident closed without success are problems.
  'SOLUCION DE ENTREGA CONCERTADA': { status: 'in_transit', stage: 'in_transit' },
  'SOLUCION DE ENTREGA EN PUNTO': { status: 'in_transit', stage: 'in_transit' },
  'CAMBIO DE DIRECCION': { status: 'in_transit', stage: 'in_transit' },
  'CONTACTA CON AGENCIA': { status: 'exception', stage: 'exception' },
  'SOLUCIONADO SIN OK': { status: 'exception', stage: 'exception' },
  ENTREGADO: { status: 'delivered', stage: 'delivered' },
};

// Notices record a message or note, not a movement. A notice after a scan
// keeps that scan's stage; only a first notice of the shipment registers it.
const notices = new Set(['NOTIFICADO', 'SIN ESTADO']);

const key = (label: string) => label.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();

export function classifyNacexStatus(label: string): ClassifiedStatus | undefined {
  const value = key(label);
  return Object.hasOwn(labels, value) ? labels[value] : undefined;
}

export function isNacexNotice(label: string): boolean {
  return notices.has(key(label));
}

/** What the map says about one scan by its label. A notice takes its stage from the scans around it, so it has none of its own. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code || isNacexNotice(wording) ? undefined : classifyNacexStatus(wording)?.stage),
  gaps: [
    { wording: 'notificado', note: 'A notice recorded the day the shipment is booked: it keeps the stage of the scan before it, and registers only a shipment that has no scan yet.' },
    { wording: 'sin estado', note: 'An administrative note: it keeps the stage of the scan before it, and registers only a shipment that has no scan yet.' },
  ],
};

const movements = new Set(['ACEPTADA', 'EN TRANSITO', 'EN REPARTO', 'DISPONIBLE EN PUNTO NACEX']);

/** Scans whose trailing depot and locality are a place, not a note or a recipient. */
export function isNacexMovement(label: string): boolean {
  return movements.has(key(label));
}
