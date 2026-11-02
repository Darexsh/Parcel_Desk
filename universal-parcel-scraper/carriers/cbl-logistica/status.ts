import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The shipment's situation, `SITUACION_LOCALIZADOR`, with the label the
 * locator page heads it with and the step of its progress rail.
 */
const SITUATIONS: ReadonlyMap<string, { readonly stage: Stage; readonly label: string }> = new Map([
  ['DOC', { stage: 'registered', label: 'DOCUMENTADA' }], // The sender has documented the shipment.
  ['TRANS', { stage: 'in_transit', label: 'EN TRANSITO' }],
  ['DEST', { stage: 'in_transit', label: 'EN DESTINO' }], // At the branch that delivers.
  ['REPA', { stage: 'out_for_delivery', label: 'EN REPARTO' }],
  ['EFEC', { stage: 'delivered', label: 'ENTREGADA' }],
]);

// The page's label for a shipment carrying the incident flag, in place of its situation's.
export const CBL_INCIDENT = 'INCIDENCIA';

/** The stage a situation code gives the shipment. */
export function cblMappedStage(code: string): Stage | undefined {
  return SITUATIONS.get(code.toUpperCase())?.stage;
}

/**
 * The shipment's stage and label as the page shows them: the incident flag
 * puts INCIDENCIA over any situation but a delivery, which is final.
 */
export function cblSituation(code: string, incident: boolean): { stage: Stage; label: string } | undefined {
  const situation = SITUATIONS.get(code.toUpperCase());
  if (incident && situation?.stage !== 'delivered') return { stage: 'exception', label: CBL_INCIDENT };
  return situation;
}

/**
 * A scan's stage by the shared wording rules. Scans come without a code; an
 * incident the rules do not read is still a problem with the shipment.
 */
export function cblScanStage(wording: string, incident: boolean): ClassifiedWording | null {
  const worded = classifyWording(wording, incident ? 'exception' : 'in_transit');
  if (worded.source !== 'none') return worded;
  return incident ? { stage: 'exception', source: 'carrier_map' } : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? cblMappedStage(code)
    : wording === normalizeStatusWording(CBL_INCIDENT) ? 'exception' : undefined),
  gaps: [],
};
