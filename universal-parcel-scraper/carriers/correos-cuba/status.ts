import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The states of the Correos de Cuba tracker, which carries no codes. Only
 * states seen on the tracker or explained in a guide to it are mapped;
 * another falls to the wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // Posted: "imponer" is to post an item, not a tax.
  ['Impuesto', 'accepted'],
  ['Clasificado', 'in_transit'],
  // Sent on to the office the scan names.
  ['Facturado', 'in_transit'],
  // Handed to a private small business that distributes parcels for the post.
  ['Facturado a mipyme', 'in_transit'],
  ['Recepcionado', 'in_transit'],
  ['Entregado a aduana', 'customs'],
  ['Entregado a aduana en exportaciones', 'customs'],
  // Released by customs, which sends the item on.
  ['Salida aduana', 'in_transit'],
  ['Entregado', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's state, if it knows it. */
export function correosCubaMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage from its state, else the shared wording rules, else nothing, which keeps it visible for review. */
export function correosCubaStage(wording: string): ClassifiedWording | null {
  if (!wording) return null;
  const mapped = correosCubaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker shows states only; the map leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => correosCubaMappedStage(wording),
  gaps: [],
};
