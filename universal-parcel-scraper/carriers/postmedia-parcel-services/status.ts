import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scans carry no code, only a message in English and in French.
 * The messages seen in replies are mapped, and the pickup message the page's
 * script singles out; other wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  // The seller's or marketplace's own scan, before the parcel reaches a Postmedia hub.
  ['Shipment has left seller facility and is in transit', 'in_transit'],
  ['L\'envoi a quitté l\'établissement du vendeur et est en transit', 'in_transit'],
  ['Arrival Scan/Received Hub', 'accepted'], // The first scan at a Postmedia hub.
  ['Scan d\'arrivée/centre de réception', 'accepted'],
  ['Out for delivery', 'out_for_delivery'],
  ['En cours de livraison', 'out_for_delivery'],
  ['Delivered', 'delivered'],
  ['Livré', 'delivered'],
  ['Available for pickup', 'ready_for_pickup'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's message. */
export function postmediaMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its message in the map, else the shared wording rules, else nothing. */
export function postmediaStage(wording: string): ClassifiedWording | null {
  const mapped = postmediaMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => postmediaMappedStage(wording),
  gaps: [],
};
