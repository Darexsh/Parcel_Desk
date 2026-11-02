import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The statuses Domain's tracking service gives an order, in English and on its French route.
 * The reply gives a status no code; another wording falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The order left the Ontario Cannabis Store's warehouse with Domain; the shared rules leave it unread.
  ['Your order has been shipped!', 'in_transit'],
  ['Votre commande a été expédiée!', 'in_transit'],
  ['Out for Delivery', 'out_for_delivery'],
  ['En cours de livraison', 'out_for_delivery'],
  ['Your order has been delivered!', 'delivered'],
  ['Votre commande a été livrée!', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a status wording. */
export function domainLogisticsMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A status's stage: the map's, else the shared wording rules', else nothing. */
export function domainLogisticsStage(wording: string): ClassifiedWording | null {
  const mapped = domainLogisticsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => domainLogisticsMappedStage(wording),
  gaps: [],
};
