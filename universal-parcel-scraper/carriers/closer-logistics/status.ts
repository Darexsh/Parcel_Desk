import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Closer Logistics' shipment statuses and the labels its tracking page shows
 * for them. A delivery takes a parcel to the recipient; a pickup collects a
 * return from the customer and takes it back to the shop.
 */
const LABELS: ReadonlyMap<string, string> = new Map([
  ['documented', 'Orden de pedido recibida'],
  ['hub', 'Recibido en almacén'],
  ['out_for_delivery', 'En reparto'],
  ['delivered', 'Entregado'],
  ['failed_delivery_attempt', 'Entrega fallida'],
  ['ready_for_pickup', 'Pendiente de recogida'],
  ['picked_up', 'Recogido'],
  ['failed_pickup_attempt', 'Recogida fallida'],
  ['for_return', 'Pendiente de devolución'],
  ['returned', 'Devuelto'],
]);

const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['documented', 'registered'], // The shop sent the order to Closer.
  ['hub', 'in_transit'], // At Closer's warehouse, on either leg.
  ['out_for_delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
  ['failed_delivery_attempt', 'failed_attempt'],
  ['ready_for_pickup', 'registered'], // A return to collect from the customer; the driver's way there is shown live.
  ['picked_up', 'accepted'], // Collected from the customer.
  ['failed_pickup_attempt', 'exception'], // The return stays with the customer.
  ['returned', 'returned'], // Back with the shop.
]);

/** The page's label for a status, or nothing for one it does not name. */
export function closerLabel(code: string): string | undefined {
  return LABELS.get(code);
}

/**
 * The stage of a status. `for_return` is a delivery on its way back to the
 * shop after failing, but the next leg of a collected return.
 */
export function closerStage(code: string, pickup: boolean): Stage | undefined {
  if (code === 'for_return') return pickup ? 'in_transit' : 'exception';
  return STAGES.get(code);
}

/** `for_return` depends on whether the shipment is a delivery or a pickup, so the code alone gives it no stage. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STAGES.get(code) : undefined),
  gaps: [],
};
