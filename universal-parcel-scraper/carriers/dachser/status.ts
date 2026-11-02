/**
 * Dachser status classification.
 *
 * The Customer Iberia endpoint has no status code: it sends a free-text
 * `descripcionIncidencia` per event and a free-text `estadoExpedicion` for the
 * shipment, in Spanish and occasionally English, French, German or Italian.
 * Both classifiers therefore work on accent-folded, lower-cased substrings,
 * ordered so that negatives and future-dated notices are decided before the
 * broad delivery words they contain.
 */
import type { CarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import type { Stage } from '../../generated/catalog.js';

/** Lower-cased, accent-free text, for language-independent matching. */
export function plainText(raw: unknown): string {
  return (typeof raw === 'string' ? raw : '')
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
}

interface EventRule {
  stage: Stage;
  description: string;
  needles: string[];
}

/**
 * Event wording rules, in priority order. The first match wins, so
 * "no entregado" is classified before the "entregado" it contains, and a
 * rescheduled delivery appointment ("fecha de entrega", "cita") never counts
 * as a delivery.
 */
export const EVENT_RULES: readonly EventRule[] = [
  { stage: 'exception', description: 'Shipment exception', needles: ['incidencia', 'averia', 'danad', 'rechazad', 'direccion incorrecta'] },
  { stage: 'failed_attempt', description: 'Delivery attempt was unsuccessful', needles: ['no entreg', 'entrega fallida', 'failed delivery', 'unsuccessful'] },
  { stage: 'returned', description: 'Shipment returned', needles: ['devol', 'retorn', 'return', 'retour'] },
  { stage: 'in_transit', description: 'Delivery appointment updated', needles: ['fecha de entrega', 'cita', 'appointment', 'avis de livraison'] },
  { stage: 'delivered', description: 'Delivered', needles: ['entregado', 'entregada', 'delivered', 'zugestellt', 'consegnat'] },
  { stage: 'out_for_delivery', description: 'Out for delivery', needles: ['reparto', 'proceso de entrega', 'out for delivery', 'in zustellung'] },
  { stage: 'ready_for_pickup', description: 'Ready for pickup', needles: ['recogida', 'ready for pickup', 'ready for collection', 'abholbereit'] },
  { stage: 'customs', description: 'Customs processing', needles: ['aduana', 'customs', 'clearance', 'zoll'] },
  { stage: 'in_transit', description: 'Shipment departed a Dachser facility', needles: ['salida', 'departed', 'outbound'] },
  { stage: 'in_transit', description: 'Shipment arrived at a Dachser facility', needles: ['llegada', 'arrived', 'inbound'] },
  { stage: 'accepted', description: 'Shipment accepted by Dachser', needles: ['recogido', 'aceptado', 'picked up', 'accepted'] },
  { stage: 'registered', description: 'Shipment registered by Dachser', needles: ['registrado', 'creado', 'announced', 'registered', 'information received'] },
];

/** The rule an event's own wording matches, without the in-transit default. */
function eventRule(rawDescription: unknown): EventRule | undefined {
  const value = plainText(rawDescription);
  return EVENT_RULES.find((rule) => rule.needles.some((needle) => value.includes(needle)));
}

/** The stage and the neutral English wording we show for one event row. */
export function eventLabel(rawDescription: unknown): { stage: Stage; description: string } {
  const matched = eventRule(rawDescription);
  return matched
    ? { stage: matched.stage, description: matched.description }
    : { stage: 'in_transit', description: 'Dachser tracking update' };
}

/**
 * The shipment-level status. `hasEvents` keeps a shipment with history but no
 * recognized heading in transit, while a shipment with neither stays unknown.
 */
export function shipmentStatus(rawStatus: unknown, hasEvents: boolean): {
  status: CarrierResult['status'];
  text: string;
} {
  const value = plainText(rawStatus);
  if (['no entreg', 'incidencia', 'averia', 'failed', 'problem', 'devol', 'return', 'retour']
    .some((needle) => value.includes(needle))) return { status: 'exception', text: 'Shipment exception' };
  if (['entregado', 'entregada', 'delivered', 'zugestellt', 'consegnat']
    .some((needle) => value.includes(needle))) return { status: 'delivered', text: 'Delivered' };
  if (['reparto', 'proceso de entrega', 'out for delivery', 'in zustellung']
    .some((needle) => value.includes(needle))) return { status: 'out_for_delivery', text: 'Out for delivery' };
  if (['registrado', 'creado', 'announced', 'registered', 'information received']
    .some((needle) => value.includes(needle))) return { status: 'pending', text: 'Shipment registered by Dachser' };
  if (value || hasEvents) return { status: 'in_transit', text: 'In transit' };
  return { status: 'unknown', text: 'Tracking update unavailable' };
}

/** The stage of each English wording a rule gives a stored event. */
const STAGE_BY_LABEL = new Map(EVENT_RULES.map((rule) => [normalizeStatusWording(rule.description), rule.stage]));

/**
 * What the map says about one scan: the English wording its rule gave it, else, for a copy of
 * Dachser's own wording, the rules. A scan no rule matched stays open, since the stored scan does
 * not keep the wording its neutral update replaced.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => STAGE_BY_LABEL.get(wording) ?? eventRule(wording)?.stage,
  gaps: [],
};
