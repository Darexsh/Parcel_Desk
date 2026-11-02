import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export const TCC_DELIVERED_WORDING = 'Hemos entregado tu envío';
const NOVELTIES: Readonly<Record<string, Stage>> = { '252': 'failed_attempt', '766': 'in_transit' };
const WORDINGS: Readonly<Record<string, Stage>> = {
  [normalizeStatusWording(TCC_DELIVERED_WORDING)]: 'delivered',
  'mercancía no entregada a destinatario - no se encuentra el destinatario o no hay nadie en la dirección': 'failed_attempt',
  'mercancía sin despachar hacia centro de operación destino tcc - pendiente consolidación de carga': 'in_transit',
};
const STEPS: Readonly<Record<string, Stage>> = { '1': 'registered', '1.1': 'accepted', '2': 'in_transit', '3': 'in_transit',
  '4': 'in_transit', '5': 'out_for_delivery', '6': 'delivered' };

/** The official client's seven progress positions; none creates an undated scan. */
export function tccStepStage(step: string): Stage | undefined {
  return STEPS[step];
}

export function tccStage(code: string | null, wording: string): ClassifiedWording | null {
  const stage = (code ? NOVELTIES[code] : undefined) ?? WORDINGS[normalizeStatusWording(wording)];
  if (stage) return { stage, source: 'carrier_map' };
  const inferred = classifyWording(wording, 'in_transit');
  return inferred.source === 'none' ? null : inferred;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? NOVELTIES[code] : undefined) ?? WORDINGS[normalizeStatusWording(wording)],
  gaps: [],
};
