import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The milestones Inter Rapidísimo's tracker draws on its rail. The service
 * sends no status code, so each milestone is staged by its Spanish name.
 */
export const INTERRAPIDISIMO_MILESTONES: Readonly<Record<string, Stage>> = {
  // Admitted at the counter or collected from the sender.
  'Recibimos tu envío': 'accepted',
  'En bodega de origen': 'in_transit',
  'Viajando al destino': 'in_transit',
  'En bodega de destino': 'in_transit',
  'En reparto': 'out_for_delivery',
  // Kept at the destination office for the recipient to collect.
  'Recoge en oficina': 'ready_for_pickup',
  // Held after a failed delivery or an uncollected wait until the sender or recipient says what to do.
  'Esperando tu acción': 'exception',
  'Entregamos tu envío': 'delivered',
  // The guide ends here; the way back travels under a new guide.
  'Devuelto al remitente': 'returned',
};

const MILESTONES = new Map(Object.entries(INTERRAPIDISIMO_MILESTONES).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
// "1a entrega fallida": the tracker counts the attempts that did not deliver.
const FAILED_ATTEMPT = /^\d+a entrega fallida$/;

/** The stage Inter Rapidísimo's map gives a milestone name in `normalizeStatusWording` form. */
function mappedStage(wording: string): Stage | undefined {
  return MILESTONES.get(wording) ?? (FAILED_ATTEMPT.test(wording) ? 'failed_attempt' : undefined);
}

/** A milestone's stage: its name, else the shared wording rules, else nothing. */
export function interrapidisimoStage(wording: string): ClassifiedWording | null {
  const mapped = mappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker's milestones carry a name and no status code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : mappedStage(wording)),
  gaps: [],
};
