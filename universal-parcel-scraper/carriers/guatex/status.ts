import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** A departure from a warehouse (Egreso de Bodega), whose stage depends on the row after it. */
export const GUATEX_DEPARTURE = 'E';
/** The cash-on-delivery amount credited to the sender, which the tracker page leaves out of the history. */
export const GUATEX_CREDITED = 'S';
/** The courier's delivery (Entrega Móvil), and a failed attempt, whose wording is the reason. */
const COURIER_DELIVERY = 'T';
const NOT_DELIVERED = 'NE';
const DELIVERIES = new Set([COURIER_DELIVERY, 'N']);
// The page reads a return to the sender from "Devoluci" in a row's wording.
const RETURN = /devoluci/i;

/**
 * The rows' codes (`descripcion`), as the tracker page's script names them,
 * and the departure from an agency (G), which it leaves unnamed.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['PR', 'registered'], // PENDIENTE: the guía is created and the parcel still to collect.
  ['R', 'accepted'], // RECOLECTADO: Recolección Móvil, collected by the courier.
  ['G', 'in_transit'], // Egreso de Agencia: left the agency.
  ['I', 'in_transit'], // EN_BODEGA: Ingreso a Bodega.
  ['T', 'delivered'], // ENTREGADO: Entrega Móvil, the courier's delivery.
  ['N', 'delivered'], // ENTREGADO: Entregado en Agencia, also recorded hours after the courier's delivery.
  ['NE', 'failed_attempt'], // NO ENTREGADO, worded with the reason.
]);

/**
 * The stage a row's code gives it. A row whose wording names a return is the
 * return: delivered back to the sender, or under way. A departure from a
 * warehouse is left out: its stage depends on the row after it.
 */
export function guatexMappedStage(code: string | null, wording: string): Stage | undefined {
  const key = code?.toUpperCase() ?? '';
  if (key === GUATEX_DEPARTURE || key === GUATEX_CREDITED) return undefined;
  const stage = CODES.get(key);
  if (!stage || !RETURN.test(wording)) return stage;
  return DELIVERIES.has(key) ? 'returned' : 'exception';
}

/**
 * A row's stage. A departure from a warehouse is out for delivery when the
 * courier's delivery or a failed attempt follows it, and in transit otherwise:
 * the same code takes parcels between warehouses. A code the page does not
 * name goes to the shared wording rules.
 */
export function guatexStage(code: string, wording: string, nextCode?: string): ClassifiedWording | null {
  if (code === GUATEX_DEPARTURE) {
    if (RETURN.test(wording)) return { stage: 'exception', source: 'carrier_map' };
    const run = nextCode === COURIER_DELIVERY || nextCode === NOT_DELIVERED;
    return { stage: run ? 'out_for_delivery' : 'in_transit', source: 'carrier_map' };
  }
  const mapped = guatexMappedStage(code || null, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = wording ? classifyWording(wording, 'in_transit') : null;
  return worded && worded.source !== 'none' ? worded : null;
}

/** The departure's stage comes from the next row, so the map leaves it unknown. */
export const statusMap: CarrierStatusMap = {
  stage: guatexMappedStage,
  gaps: [
    { code: GUATEX_CREDITED, note: 'The cash-on-delivery amount credited to the sender, after the delivery. It moves nothing, and the adapter leaves it out as the tracker page does.' },
  ],
};
