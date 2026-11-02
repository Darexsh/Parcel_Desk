import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['pedido criado | aguardando postagem remetente', 'registered'],
  ['encomenda conferida', 'accepted'],
  // Preparing a delivery is weaker evidence than the later delivery-start scan.
  ['em rota | preparando para entrega', 'in_transit'],
  ['processo de entrega iniciado', 'out_for_delivery'],
  ['destinatario ausente | local fechado', 'failed_attempt'],
  ['encomenda entregue', 'delivered'],
]);

export function fmTransportesMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** Unknown wording stays visible without inventing a stage. */
export function fmTransportesStage(wording: string): ClassifiedWording | null {
  const stage = fmTransportesMappedStage(wording);
  return stage ? { stage, source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : fmTransportesMappedStage(wording),
  gaps: [],
};
