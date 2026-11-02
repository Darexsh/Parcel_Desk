import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The history rows the tracking page names, by status id, with its wording
 * and the stage each gives. The page draws a five-step rail: the order
 * entered, its planning (or cancellation, or a new date), the driver on the
 * way to collect it from the sender, then on the way to deliver it (or a
 * failed collection), and the outcome. Collecting from the sender is not yet
 * Chazki holding the parcel, so it stays registered; the trip to the door is
 * out for delivery.
 */
const ROWS: ReadonlyMap<number, { wording: string; stage?: Stage }> = new Map([
  [154, { wording: 'Orden ingresada', stage: 'registered' }],
  [155, { wording: 'En programación', stage: 'registered' }],
  [159, { wording: 'Orden cancelada', stage: 'exception' }],
  // A new date for the order: it moves nothing.
  [199, { wording: 'En reprogramación' }],
  [156, { wording: 'En tránsito a recoger el pedido', stage: 'registered' }],
  // The page shows this one only when the order has no 156.
  [157, { wording: 'En tránsito a recoger el pedido', stage: 'registered' }],
  [161, { wording: 'Falló la recolección', stage: 'exception' }],
  [162, { wording: 'En tránsito a entregar el pedido', stage: 'out_for_delivery' }],
  [169, { wording: 'Fallado', stage: 'failed_attempt' }],
  [168, { wording: 'Devolución fallida', stage: 'exception' }],
  [198, { wording: 'En proceso de devolución', stage: 'returned' }],
  [170, { wording: 'Retornada a almacen', stage: 'returned' }],
  [166, { wording: 'Entregado', stage: 'delivered' }],
]);

/**
 * The order's current status, by the name the reply gives it, with the
 * wording and stage of the step the page lights for it. The page shows the
 * collection under way as the trip to deliver, and the clearing and
 * completion after a delivery as delivered.
 */
const CURRENT: Readonly<Record<string, { wording: string; stage?: Stage }>> = {
  NEW: { wording: 'Orden ingresada', stage: 'registered' },
  PLANNED: { wording: 'En programación', stage: 'registered' },
  CANCELED: { wording: 'Orden cancelada', stage: 'exception' },
  REPROGRAMMING: { wording: 'En reprogramación' },
  ASSIGNED: { wording: 'En tránsito a recoger el pedido', stage: 'registered' },
  GOTO_PICK: { wording: 'En tránsito a recoger el pedido', stage: 'registered' },
  ARRIVED_PICK: { wording: 'En tránsito a recoger el pedido', stage: 'registered' },
  PICKING: { wording: 'En tránsito a entregar el pedido', stage: 'out_for_delivery' },
  GOTO_DELIVER: { wording: 'En tránsito a entregar el pedido', stage: 'out_for_delivery' },
  ARRIVED_DELIVER: { wording: 'En tránsito a entregar el pedido', stage: 'out_for_delivery' },
  DELIVERING: { wording: 'En tránsito a entregar el pedido', stage: 'out_for_delivery' },
  FAILED_PICK: { wording: 'Falló la recolección', stage: 'exception' },
  FAILED_DROP: { wording: 'Fallado', stage: 'failed_attempt' },
  DELIVERED: { wording: 'Entregado', stage: 'delivered' },
  COMPLETED: { wording: 'Entregado', stage: 'delivered' },
  CLEARING: { wording: 'Entregado', stage: 'delivered' },
  RETURN: { wording: 'En proceso de devolución', stage: 'returned' },
  RETURNED: { wording: 'Retornada a almacen', stage: 'returned' },
  FAILED_RETURN: { wording: 'Devolución fallida', stage: 'exception' },
};

/** A history row the page names: its wording and stage. */
export function chazkiRow(statusId: number): { wording: string; stage?: Stage } | undefined {
  return ROWS.get(statusId);
}

/** The page's step for the order's current status, by its name. */
export function chazkiCurrent(name: string): { wording: string; stage?: Stage } | undefined {
  return Object.hasOwn(CURRENT, name) ? CURRENT[name] : undefined;
}

/** The stage a row's status id, or a summary's status name, gives. */
export function chazkiStage(code: string): Stage | undefined {
  return /^\d{1,6}$/.test(code) ? chazkiRow(Number(code))?.stage : chazkiCurrent(code)?.stage;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? chazkiStage(code) : undefined),
  gaps: [
    { code: '199', note: 'A new date for the order; it moves nothing.' },
    { code: 'REPROGRAMMING', note: 'A new date for the order; it moves nothing.' },
    { code: '160', note: 'A history row the tracking page neither names nor shows; the adapter leaves it out.' },
    { code: '216', note: 'A history row the tracking page neither names nor shows; the adapter leaves it out.' },
  ],
};
