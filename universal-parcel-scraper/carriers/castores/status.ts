import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Castores' history heads each row with the step of the journey the page files
 * it under, then gives the branch's own status, written "heading: status" when
 * the two differ. Neither carries a code. The heading gives the stage, except
 * under the delivery run, which also holds a row that is not one.
 */
const HEADINGS: ReadonlyMap<string, Stage> = new Map([
  // The carta porte was made out at the origin branch, with the freight in its warehouse.
  ['documentado', 'accepted'],
  // The freight was collected; the branch writes it as on its way.
  ['recolectado', 'accepted'],
  ['en centro de distribución origen', 'in_transit'],
  ['en trayecto', 'in_transit'],
  ['en centro de distribución destino', 'in_transit'],
  ['entregado', 'delivered'],
]);

/** Whole rows, for the heading whose rows differ. */
const ROWS: ReadonlyMap<string, Stage> = new Map([
  ['en ruta de entrega', 'out_for_delivery'],
  ['en ruta de entrega: en trayecto', 'out_for_delivery'],
  // The carta porte reached the destination branch ahead of the freight, which
  // the next rows unload into its warehouse before the delivery run.
  ['en ruta de entrega: talon recuperado en oficina', 'in_transit'],
]);

/** The stage the map gives a row's wording, if it knows it. */
export function castoresMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  const row = ROWS.get(key);
  if (row) return row;
  const colon = key.indexOf(': ');
  return HEADINGS.get(colon < 0 ? key : key.slice(0, colon));
}

/**
 * A row's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function castoresStage(wording: string): ClassifiedWording | null {
  const mapped = castoresMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The page carries wording only; the map leaves none of it out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : castoresMappedStage(wording)),
  gaps: [],
};
