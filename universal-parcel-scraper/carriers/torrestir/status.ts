import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The wordings of Torrestir's tracker, which carries no codes: its scans in
 * Portuguese, the language the adapter asks for, and in English and Spanish,
 * then the progress bar's steps the scans do not share. Only wordings seen on
 * the tracker are mapped; another falls to the wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Guia Criada', 'registered'],
  ['Order Registered', 'registered'],
  ['Guía Creada', 'registered'],
  ['Recolhido', 'accepted'],
  ['Collected', 'accepted'],
  ['Recogido', 'accepted'],
  ['Na Plataforma de Origem', 'in_transit'],
  ['At the Warehouse of Origin', 'in_transit'],
  ['Em Transito', 'in_transit'],
  ['In Transit', 'in_transit'],
  ['En Tránsito', 'in_transit'],
  ['Na Plataforma de Destino', 'in_transit'],
  ['On Distribution Platform', 'in_transit'],
  ['En la plataforma de destino', 'in_transit'],
  ['Em Distribuiçao', 'out_for_delivery'],
  ['In Distribution', 'out_for_delivery'],
  ['En Distribución', 'out_for_delivery'],
  // Brought back to the warehouse from a delivery round; the parcel then goes out again.
  ['Devolvido', 'failed_attempt'],
  ['Returned', 'failed_attempt'],
  ['Devuelto', 'failed_attempt'],
  ['Entregue', 'delivered'],
  ['Delivered', 'delivered'],
  ['Entregado', 'delivered'],
  // The progress bar's steps.
  ['Documentado', 'registered'],
  ['Documented', 'registered'],
  ['Em trânsito', 'in_transit'],
  ['Em distribuição', 'out_for_delivery'],
  ['In Deliver', 'out_for_delivery'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a wording, if it knows it. */
export function torrestirMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function torrestirStage(wording: string): ClassifiedWording | null {
  const mapped = torrestirMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker shows wordings only; the map leaves none out on purpose. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => torrestirMappedStage(wording),
  gaps: [],
};
