import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Transaher's wording, in `normalizeStatusWording` form: the situations its
 * history lists in capitals, and the status its summary heads the page with.
 * Only wording seen on the tracker is mapped; other wording falls to the
 * shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // The summary's status while the sender's data is all Transaher has.
  ['notificado a transaher', 'registered'],
  ['registrado', 'registered'],
  ['salida de origen', 'in_transit'],
  ['en reparto', 'out_for_delivery'],
  ['entregado', 'delivered'],
]);

// A note to agree a day and time to unload with the recipient: it moves nothing.
const APPOINTMENT = 'pedir dia y hora descarga';

/** The stage Transaher's own wording gives a situation or summary status. */
export function transaherMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A situation's or the summary's stage: Transaher's wording, else the shared rules, else nothing. */
export function transaherStage(wording: string): ClassifiedWording | null {
  const mapped = transaherMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (normalizeStatusWording(wording) === APPOINTMENT) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  // The tracker gives no codes.
  stage: (code, wording) => (code ? undefined : transaherMappedStage(wording)),
  gaps: [
    { wording: APPOINTMENT, note: 'A note to agree a day and time to unload with the recipient; it moves nothing.' },
  ],
};
