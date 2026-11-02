import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Urvaam's scan `status` codes. Only codes seen in replies are mapped; the
 * labels are the tracker's Spanish captions.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['0', 'registered'], // Envio Grabado: the sender filed the parcel's data.
  ['1', 'accepted'], // Recibido Plataforma: received at an Urvaam platform, Madrid's or Barcelona's.
  ['18', 'in_transit'], // Clasificado.
  ['19', 'in_transit'], // Recibido Plataforma: received at the depot or partner that delivers it.
  ['9', 'in_transit'], // Segundo recibido Plataforma: back at that depot after a failed round.
  ['2', 'out_for_delivery'], // En Reparto, Segunda reparto.
  ['3', 'delivered'], // Entregado, also to the letterbox.
  ['8', 'failed_attempt'], // Incidencia, with the reason the delivery failed.
  ['15', 'exception'], // A claim: the parcel confirmed lost, or compensated.
]);

/**
 * The tracker's own category of a scan, `track_status`, which it shows above the
 * history: registered, in transit, out for delivery, delivered, a problem, at
 * a pickup point and a return. It files a failed delivery under in transit.
 */
const CATEGORIES: ReadonlyMap<string, Stage> = new Map([
  ['1', 'registered'],
  ['3', 'out_for_delivery'],
  ['4', 'delivered'],
  ['5', 'exception'],
  ['6', 'ready_for_pickup'],
  ['7', 'returned'],
]);
const IN_TRANSIT_CATEGORY = '2';

// "Devolver al remitente" starts a return, under the platform code;
// "Devuelto al remitente" ends it, under the delivery code.
const RETURNING = /^devolver al remitente\b/i;
const RETURNED = /^devuelto al remitente\b/i;
// Failed deliveries whose reason is a loss, a theft, missing contents, damage
// or a refusal, rather than a round that can go out again.
const LOST_OR_REFUSED = /extrav|perdid|robad|\brobo\b|contenido|rotur|da[ñn]ad|rechaz|no acepta/i;

/** The stage Urvaam's code and wording give a scan, without its category. */
export function urvaamMappedStage(code: string, wording: string): Stage | undefined {
  if (RETURNED.test(wording)) return 'returned';
  if (RETURNING.test(wording)) return 'exception';
  const mapped = CODES.get(code);
  if (mapped === 'failed_attempt' && LOST_OR_REFUSED.test(wording)) return 'exception';
  return mapped;
}

/**
 * A scan's stage: its code and wording, else its category when that names a
 * milestone, else the shared wording rules, else in transit for the in-transit
 * category, else nothing.
 */
export function urvaamStage(code: string, category: string, wording: string): ClassifiedWording | null {
  const mapped = urvaamMappedStage(code, wording) ?? CATEGORIES.get(category);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  if (worded.source !== 'none') return worded;
  return category === IN_TRANSIT_CATEGORY ? { stage: 'in_transit', source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? urvaamMappedStage(code, wording) : undefined),
  gaps: [],
};
