import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * A wording's key: lower case, single spaces, no accents, no text in
 * brackets and no closing full stop. The tracker writes some wordings with
 * and some without accents, and puts a centre or a branch in brackets.
 */
function key(wording: string): string {
  return normalizeStatusWording(wording.replace(/\([^()]*\)/g, ' ').normalize('NFD').replace(/\p{M}/gu, ''))
    .replace(/\s+([,.])/g, '$1').replace(/[\s.]+$/, '');
}

/**
 * OCASA's events, in Spanish: the sentence under each event, then the
 * heading over it. Neither carries a code. A booking for pickup or a parcel
 * the sender confirmed is registered, and the pickup accepts it; distribution
 * centres and branches are transit. An address the driver could not find, a
 * recipient who was out and a delivery something outside OCASA prevented are
 * failed attempts, after which the driver comes back. A shipment OCASA closed
 * without delivery, telling the buyer to ask the shop, is an exception; the
 * return follows it. The heading "En distribución" covers both the pickup and
 * a departure from a centre, so it is transit when the sentence is unknown.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // Sentences of the current page.
  ['el envio ya esta confirmado para que lo retiremos por el domicilio del remitente', 'registered'],
  ['pasamos a buscar el envio por el domicilio del remitente y lo estamos llevando a nuestra planta para iniciar el proceso de entrega', 'accepted'],
  ['el envio ha llegado al centro de distribucion ocasa', 'in_transit'],
  ['el pedido llego al centro de distribucion ocasa, responsable de la entrega a destino', 'in_transit'],
  ['el envio ha salido del centro de distribucion de ocasa', 'in_transit'],
  ['hoy estamos pasando a entregar el envio por el domicilio de destino en el rango horario de 9 a 18 horas', 'out_for_delivery'],
  ['pasamos por el domicilio de destino y no te encontramos', 'failed_attempt'],
  ['pasamos por el domicilio de destino y no te encontramos. regresaremos nuevamente a visitarte dentro de las proximas 72 horas habiles', 'failed_attempt'],
  ['tuvimos un inconveniente ajeno a ocasa que impidio la entrega. regresaremos nuevamente a visitarte dentro de las proximas 72 horas habiles', 'failed_attempt'],
  ['no se pudo encontrar el domicilio', 'failed_attempt'],
  ['entregamos el envio. gracias por utilizar el servicio de ocasa para tus entregas', 'delivered'],
  ['te informo que el proceso de envio ha finalizado. por favor contactate con la marca por la cual realizaste la compra para obtener mayor informacion', 'exception'],
  ['el envio esta en proceso de devolucion al remitente', 'returned'],
  // Sentences of the former page.
  ['el envio esta confirmado para iniciar el proceso de distribucion', 'registered'],
  ['el envio fue recibido en nuestra planta, y esta siendo preparado para enviarlo al domicilio de destino', 'in_transit'],
  ['envio ha sido despachado desde el centro de distribucion de ocasa', 'in_transit'],
  ['el envio ha llegado al centro de distribucion ocasa responsable de la entrega final', 'in_transit'],
  ['el envio esta en camino para ser recibido por la sucursal final de destino y llevarlo al domicilio de destino', 'in_transit'],
  ['hoy estamos pasando a entregar el envio por el domicilio de destino', 'out_for_delivery'],
  ['intentamos ubicar el domicilio de destino para hacer la entrega y nos ha sido imposible', 'failed_attempt'],
  ['intentamos ubicar el domicilio de destino para hacer la entrega del envio y nos ha sido imposible', 'failed_attempt'],
  ['el envio ingreso a nuestra planta para iniciar el proceso de devolucion', 'returned'],
  // Headings of the current page.
  ['confirmado', 'registered'],
  ['en distribucion', 'in_transit'],
  ['pedido en centro', 'in_transit'],
  ['despachado a sucursal', 'in_transit'],
  ['hoy llegamos', 'out_for_delivery'],
  ['entrega no efectuada', 'failed_attempt'],
  ['entrega no efectuada regresaremos nuevamente a visitarte dentro de las proximas 72 horas habiles', 'failed_attempt'],
  ['reprogramado', 'failed_attempt'],
  ['visita sin exito', 'failed_attempt'],
  ['entregado', 'delivered'],
  ['en devolucion', 'returned'],
  // Steps of the former page's progress rail.
  ['en proceso de retiro', 'registered'],
  ['retirado', 'accepted'],
  ['en camino a destino', 'in_transit'],
  ['en proceso de entrega', 'out_for_delivery'],
]);

/** The stage the map gives a sentence or a heading, if it knows it. */
export function ocasaMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

/**
 * An event's stage: its sentence, then its heading, from the map; else the
 * shared wording rules on the sentence, then on the heading; else nothing.
 */
export function ocasaStage(sentence: string, heading: string): ClassifiedWording | null {
  const mapped = ocasaMappedStage(sentence) ?? ocasaMappedStage(heading);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  for (const wording of [sentence, heading]) {
    const worded = wording ? classifyWording(wording, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}

/** The events carry wording only; every wording the tracker was seen to use is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : ocasaMappedStage(wording)),
  gaps: [],
};
