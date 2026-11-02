import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Event types (`cod_tipo_evento`) of Chilexpress's tracking service and the
 * stage each means. The help centre's page names them; the comments give its
 * names. Event 510 is not in the page's list and words a redirection.
 */
const CODES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['-3', 'registered'], // PreRecepcionada: the order was created.
  ['0', 'registered'], // The order was created.
  ['-1', 'accepted'], // RetiroDesdePdt: collected by Chilexpress, from the sender or, on a return, from a branch.
  ['-2', 'accepted'], // Retirado.
  ['4', 'accepted'], // Recepcionada.
  ['5', 'in_transit'], // RecepcionTransPieza: at a facility, named in the wording.
  ['6', 'in_transit'], // RecepcionTransDesc.
  ['7', 'in_transit'], // RecepTransIntern: received from abroad.
  ['8', 'in_transit'], // TransferenciaRutaOT: on the way to the facility the wording names.
  ['9', 'in_transit'], // TransferenciaRutaOTBCS.
  ['10', 'in_transit'], // TransferenciaLocalOT.
  ['11', 'in_transit'], // TransferenciaLocalOTBCS.
  ['12', 'returned'], // DevolucionCliente: on its way back to the sender.
  ['13', 'out_for_delivery'], // PiezaEnDespacho.
  ['14', 'delivered'], // PiezaEntregada.
  ['15', 'exception'], // PiezaEnRetencion: held, as for an address out of coverage or a collection deadline passed.
  ['16', 'failed_attempt'], // PiezaEnSobrancia: the courier came back with it, as for an unknown recipient or a wrong address.
  ['48', 'customs'], // RecibidaAntesDeAduanaSCL: arrived at Santiago airport before customs.
  ['49', 'in_transit'], // TramiteFinalizadoEnAduana: cleared customs.
  ['51', 'ready_for_pickup'], // DisponibleEnOficinaParaRetiro.
  ['90', 'in_transit'], // envioEnTransito.
  ['91', 'out_for_delivery'], // PiezaEnDistribucion.
  ['510', 'in_transit'], // Redirected to a branch.
]);

// The dispatch and delivery events also carry the leg back to the sender, in their wording.
const TO_SENDER = /\bal remitente\b/;

/**
 * Wordings without a code: those of the tracking service, and those of
 * the tracker page Chilexpress replaced, as universal providers repeat them.
 */
const WORDINGS: Readonly<Record<string, Stage>> = {
  'orden de transporte creada': 'registered',
  'envio retirado por chilexpress': 'accepted',
  'pieza retirada por chilexpress': 'accepted',
  'envio recepcionado por chilexpress': 'accepted',
  'pieza recibida en chilexpress': 'accepted',
  'pieza en transito al destino': 'in_transit',
  'en proceso de despacho': 'in_transit',
  'envio redireccionado': 'in_transit',
  'envio en devolucion a remitente': 'returned',
  'envio en despacho al destinatario': 'out_for_delivery',
  'envio en transito al destinatario': 'out_for_delivery',
  'pieza en ruta al destinatario': 'out_for_delivery',
  'envio en despacho al remitente': 'returned',
  'envio entregado al destinatario': 'delivered',
  'envio entregada a destinatario': 'delivered',
  'pieza entregada a destinatario': 'delivered',
  'envio entregado al remitente': 'returned',
  'envio disponible para retiro en sucursal': 'ready_for_pickup',
  'disponible en oficina para retiro': 'ready_for_pickup',
  'primer intento de entrega: domicilio cerrado': 'failed_attempt',
  'destinatario desconocido': 'failed_attempt',
  'direccion erronea': 'failed_attempt',
  'direccion sin cobertura': 'exception',
  'direccion sin georeferencia': 'exception',
  'envio con plazo vencido de retiro': 'exception',
  'envio retrasado': 'exception',
};

/** A wording in lower case, without accents. */
function wordingKey(wording: string): string {
  return normalizeStatusWording(wording).normalize('NFD').replace(/\p{M}/gu, '');
}

/** The stage of one scan: its event type decides when the map knows it, its wording otherwise. */
export function chilexpressStage(code: string | null, wording: string): Stage | undefined {
  const key = wordingKey(wording);
  const mapped = code === null ? undefined : CODES.get(code);
  if (mapped) return (code === '13' || code === '14') && TO_SENDER.test(key) ? 'returned' : mapped;
  return Object.hasOwn(WORDINGS, key) ? WORDINGS[key] : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: chilexpressStage,
  gaps: [],
};
