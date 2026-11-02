import type { ClassifiedStatus } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const LABELS: Record<string, ClassifiedStatus> = {
  'PENDIENTE DE RECOGER': { status: 'pending', stage: 'registered' },
  'ENVIO RECOGIDO EN ORIGEN': { status: 'in_transit', stage: 'accepted' },
  'EN TRANSITO': { status: 'in_transit', stage: 'in_transit' },
  // The delivering franchise expects the parcel, then receives it.
  'PENDIENTE DE RECIBIR EN DESTINO': { status: 'in_transit', stage: 'in_transit' },
  'RECIBIDO EN FRANQUICIA DE DESTINO': { status: 'in_transit', stage: 'in_transit' },
  'ENVIO EN REPARTO': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'DESTINATARIO AUSENTE O CERRADO': { status: 'exception', stage: 'failed_attempt' },
  // A delivery agreed with the recipient puts the parcel back on its way.
  'ENTREGA CONCERTADA': { status: 'in_transit', stage: 'in_transit' },
  'CONCERTADA PROXIMA ENTREGA': { status: 'in_transit', stage: 'in_transit' },
  // Deliveries held until the recipient pays, books a slot or gives the missing details.
  'ENTREGA APLAZADA PENDIENTE DE COBRO O CITA PREVIA': { status: 'exception', stage: 'exception' },
  'PENDIENTE DE RECIBIR DATOS DE ENTREGA': { status: 'exception', stage: 'exception' },
  'DIRECCION ENTREGA INCOMPLETA': { status: 'exception', stage: 'exception' },
  'DEPOSITADO EN PUNTO MRW': { status: 'in_transit', stage: 'ready_for_pickup' },
  'DEPOSITADO EN POINTCORNER DESTINO': { status: 'in_transit', stage: 'ready_for_pickup' },
  'ENVIO ENTREGADO': { status: 'delivered', stage: 'delivered' },
  // A delivery undone: the parcel goes back out.
  'ENVIO REABIERTO PARA ENTREGAR': { status: 'in_transit', stage: 'in_transit' },
  'DIRECCION ENTREGA INCORRECTA': { status: 'exception', stage: 'failed_attempt' },
  'DEVUELTO AL REMITENTE': { status: 'exception', stage: 'returned' },
  // www.mrw.pt renders the same history in Portuguese.
  'PENDENTE DE RECOLHER': { status: 'pending', stage: 'registered' },
  'ENVIO RECOLHIDO NA ORIGEM': { status: 'in_transit', stage: 'accepted' },
  'EM TRANSITO': { status: 'in_transit', stage: 'in_transit' },
  'ENVIO EM DISTRIBUICAO': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  'DESTINATARIO AUSENTE OU FECHADO': { status: 'exception', stage: 'failed_attempt' },
  'ACORDADA PROXIMA ENTREGA': { status: 'in_transit', stage: 'in_transit' },
  'DEPOSITADO EM MRW POINT': { status: 'in_transit', stage: 'ready_for_pickup' },
  'DEPOSITADO NO POINTCORNER DESTINO': { status: 'in_transit', stage: 'ready_for_pickup' },
  'ENVIO ENTREGUE': { status: 'delivered', stage: 'delivered' },
};

export function classifyMrwStatus(value: string): ClassifiedStatus | undefined {
  const key = value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
  return Object.hasOwn(LABELS, key) ? LABELS[key] : undefined;
}

/** The label a history row takes when the map does not know its status, which can name the recipient. */
export const MRW_NEUTRAL_STATUS = 'Actualización de seguimiento';

/** What the map says about one scan: MRW's statuses carry no code. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => classifyMrwStatus(wording)?.stage,
  gaps: [{
    wording: normalizeStatusWording(MRW_NEUTRAL_STATUS),
    note: "The adapter's label for a status its map does not know, kept out of the result because it can name the recipient: it names no milestone.",
  }],
};
