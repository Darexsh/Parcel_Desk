import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * eCourier's statuses, as its tracking page and its merchant API word them.
 * The page gives no code. Another wording falls to the shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(Object.entries({
  // The merchant booked the order, on the panel or through the API.
  'Initiated': 'registered',
  'Initiated API': 'registered',
  'Picked Up': 'accepted',
  // eCourier's fulfilment centre packed the order from the merchant's stock it holds.
  'Parcel process by Fulfillment': 'accepted',
  'In Source Branch': 'in_transit',
  'In Transit': 'in_transit',
  'Sent to Destination Hub': 'in_transit',
  'In Destination Hub': 'in_transit',
  'In Destination Branch': 'in_transit',
  // The delivering branch gave the parcel to a rider; "On the way to Delivery" follows when they set out.
  'Delivery Agent Assigned': 'in_transit',
  'On the way to Delivery': 'out_for_delivery',
  'Delivered': 'delivered',
} satisfies Record<string, Stage>).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage eCourier's map gives a status, if it knows the wording. */
export function ecourierWordingStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** A status's stage: its wording, else the shared wording rules, else nothing. */
export function ecourierStage(wording: string): ClassifiedWording | null {
  const mapped = ecourierWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => ecourierWordingStage(wording),
  gaps: [],
};
