import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Blue Express's scan codes, as the tracking page's lookup sends them with
 * each scan's title. Only codes seen in replies are mapped; another code
 * falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['GE', 'registered'], // Aviso de envío recibido: the sender announced the parcel.
  ['PUO', 'accepted'], // Admitido en Punto Blue Express: dropped off at a point.
  ['PU', 'accepted'], // Retirado: collected from the sender.
  ['ASO', 'accepted'], // Retirado: collected from the point it was dropped off at.
  ['PUH', 'in_transit'], // Centro de distribución de Blue Express.
  ['SOB', 'in_transit'], // Centro de distribución de Blue Express.
  ['DA', 'in_transit'], // Paquete en centro de distribución.
  ['IC', 'in_transit'], // Traslado interregional.
  ['VI', 'in_transit'], // Viaje internacional.
  ['DAA', 'customs'], // Paquete en Aduanas de Chile.
  ['LI', 'in_transit'], // Liberado por Aduanas.
  ['LD', 'out_for_delivery'], // En reparto.
  ['DAO', 'ready_for_pickup'], // Disponible para retiro.
  ['DLO', 'ready_for_pickup'], // Disponible para retiro.
  ['DL', 'delivered'], // Entregado.
  // Why a delivery round, or a delivery to a point, did not deliver.
  ['DI', 'failed_attempt'], // Dirección inubicable.
  ['NH', 'failed_attempt'], // Nadie en casa, or Reiterado: Nadie en casa.
  ['CX', 'failed_attempt'], // Sin acceso al lugar de entrega.
  ['RD', 'failed_attempt'], // Entrega rechaza por destinatario.
  ['CM', 'failed_attempt'], // Necesitamos un nuevo destino.
  ['BA', 'failed_attempt'], // Faltan datos para la entrega.
  ['MR', 'failed_attempt'], // Problemas en la ruta.
  ['XO', 'failed_attempt'], // Punto Blue Express sin capacidad.
  ['TS', 'failed_attempt'], // Problema de entrega: logged after the reason the delivery failed.
  ['DLV', 'returned'], // Pedido entregado al remitente.
]);

// SQ records a request on the order: new delivery details, or the return to the sender.
const RETURN = /^en proceso (?:de )?devoluci[oó]n al remitente\.?$/;
// Instructions and notes that move nothing: new delivery details (SQ), the
// address updated (HRS), the next working day's forecast (CE) and an
// administrative incident on the order (FW, FZ, FZP).
const NOTICES = new Set(['SQ', 'HRS', 'CE', 'FW', 'FZ', 'FZP']);

const key = (text: string) => text.toLocaleLowerCase('es-CL').trim().split(/\s+/).join(' ');

/** Whether a scan starts the parcel's return to its sender. */
export function blueExpressReturnStarts(code: string, wording: string): boolean {
  return code.toUpperCase() === 'SQ' && RETURN.test(key(wording));
}

/** The stage Blue Express's codes give a scan; a return to the sender is under way but not done. */
export function blueExpressMappedStage(code: string, wording: string): Stage | undefined {
  if (blueExpressReturnStarts(code, wording)) return 'exception';
  return CODES.get(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function blueExpressStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = blueExpressMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICES.has(code.toUpperCase())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? blueExpressMappedStage(code, wording) : undefined),
  gaps: [
    { code: 'SQ', wording: 'nueva dirección de entrega', note: 'A new delivery address given for the order; the parcel moves on the scans around it.' },
    { code: 'SQ', wording: 'nuevos datos de entrega', note: 'New delivery details given for the order; the parcel moves on the scans around it.' },
    { code: 'HRS', note: 'The destination address updated; it moves nothing.' },
    { code: 'CE', note: 'A forecast of delivery on the next working day, logged before the delivery round; it moves nothing.' },
    { code: 'FW', note: 'An administrative incident on the order, which can come after the delivery; it moves nothing.' },
    { code: 'FZ', note: 'An administrative incident on the order, which can come after the delivery; it moves nothing.' },
    { code: 'FZP', note: 'An administrative incident on the order resolved; it moves nothing.' },
  ],
};
