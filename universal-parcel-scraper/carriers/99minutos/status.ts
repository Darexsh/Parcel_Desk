import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's status names, which the shipment summary and every history row
 * carry, with the stage each gives. 99minutos collects the parcel at the shop
 * (`Collecting`, `Collected`), keeps it at a station (`Warehouse`), moves it
 * between cities (`Linehaul`) and delivers it to the door (`ToDelivery`) or
 * to one of its P99 points (`ToP99`, `P99`). The tracker words a P99 point as a
 * reception point and ranks it with a station on its progress rail, so it is
 * not read as ready for collection.
 */
const STAGES: Readonly<Record<string, Stage>> = {
  Draft: 'registered',
  Created: 'registered',
  Collecting: 'registered',
  UnsuccessfulCollect: 'exception',
  Collected: 'accepted',
  Warehouse: 'in_transit',
  Linehaul: 'in_transit',
  ToP99: 'in_transit',
  P99: 'in_transit',
  ToDelivery: 'out_for_delivery',
  Delivery: 'delivered',
  UnsuccessfulDelivery: 'failed_attempt',
  ToReturn: 'returned',
  Return: 'returned',
  Cancelled: 'exception',
  TheftOrLoss: 'exception',
  Damaged: 'exception',
  NotShowIncidence: 'exception',
};

/** The incident the tracker shows instead of a row's wording for `NotShowIncidence`. */
export const INCIDENT_ROW = 'Hubo un incidente con tu pedido, por favor contacta a Atención al Cliente';

/** The tracker's wording for each status, from its own message table. */
const WORDING: Readonly<Record<string, string>> = {
  Draft: 'Orden por confirmar',
  Created: 'Orden creada: Tu pedido está siendo preparado por el negocio.',
  Collecting: 'Vamos en camino al negocio a recoger tu pedido.',
  UnsuccessfulCollect: 'No fue posible recoger tu pedido en el negocio. Volveremos a intentarlo.',
  Collected: 'Ya hemos recogido tu pedido en el negocio.',
  Warehouse: 'Tu pedido está en nuestro almacén, estamos preparándonos para entregarlo.',
  Linehaul: 'Tu pedido va en camino hacia la ciudad de destino',
  ToDelivery: 'Tu pedido está en camino hacia tu domicilio',
  Delivery: 'Tu pedido fue entregado exitosamente.',
  ToReturn: 'Tu pedido está en camino de vuelta al negocio de origen',
  Return: 'Tu pedido fue devuelto en el negocio de origen',
  UnsuccessfulDelivery: 'No pudimos entregar tu pedido',
  ToP99: 'Tu pedido está en camino a un punto de entrega',
  P99: 'Tu pedido está en un punto de recepción',
  Cancelled: 'Tu pedido fue cancelado por el negocio.',
  TheftOrLoss: 'Hubo una incidencia con tu pedido. Contacta al negocio donde hiciste tu compra para próximos pasos.',
  Damaged: 'Hubo una incidencia con tu pedido. Contacta al negocio donde hiciste tu compra para próximos pasos.',
  NotShowIncidence: INCIDENT_ROW,
};

/**
 * Summary codes the tracker shows as an incident whatever the status name: a
 * theft, a cancellation, damage and two the developer documentation leaves
 * unnamed.
 */
const INCIDENT_CODES: ReadonlySet<number> = new Set([8001, 8002, 8003, 8004, 8006]);

/** The stage a status name gives, if the map knows it. */
export function ninetynineStage(code: string): Stage | undefined {
  return Object.hasOwn(STAGES, code) ? STAGES[code] : undefined;
}

/** The tracker's wording for a status name, if it has one. */
export function ninetynineWording(code: string): string | undefined {
  return Object.hasOwn(WORDING, code) ? WORDING[code] : undefined;
}

/** Whether a summary's numeric code is one the tracker shows as an incident. */
export function ninetynineIncident(code: unknown): boolean {
  return typeof code === 'number' && INCIDENT_CODES.has(code);
}

/** What the map says about one row, by its status name. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? ninetynineStage(code) : undefined),
  gaps: [],
};
