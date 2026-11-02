import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * A wording's key: lower case, single spaces, no accents and no closing full
 * stop. The tracker writes some wordings with and some without accents.
 */
function key(wording: string): string {
  return normalizeStatusWording(wording.normalize('NFD').replace(/\p{M}/gu, '')).replace(/[\s.]+$/, '');
}

/**
 * Cruz del Sur's events, in Spanish, without a code. A dispatch the sender
 * created is registered, and the depot receiving it accepts it; processing,
 * loading, the truck's departure and its arrival at the destination branch
 * are transit.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['despacho creado', 'registered'],
  ['recibido en deposito sin procesar', 'accepted'],
  ['despacho procesado', 'in_transit'],
  ['cargado en el camion', 'in_transit'],
  ['salida del camion', 'in_transit'],
  ['llegada de unidad a sucursal destino', 'in_transit'],
  ['en reparto', 'out_for_delivery'],
  ['entregado', 'delivered'],
]);

/** The stage the map gives a wording, if it knows it. */
export function cruzDelSurMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(wording));
}

/** An event's stage: from the map, else from the shared wording rules, else nothing. */
export function cruzDelSurStage(wording: string): ClassifiedWording | null {
  const mapped = cruzDelSurMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The events carry wording only; every wording the tracker was seen to use is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : cruzDelSurMappedStage(wording)),
  gaps: [],
};
