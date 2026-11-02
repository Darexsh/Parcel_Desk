import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The event texts MHI's tracker shows: its own export scan, then the last-mile
 * carrier's scans in MHI's English. Each row also names a coarse category,
 * which files a delivery attempt under "Delivery" and a pick-up point under
 * "Out for delivery", so the text decides.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Your order has been processed at the UK export facility. It is now on route to the receiver.', 'in_transit'],
  ['Shipment information sent to last mile service provider', 'registered'],
  ['Notification sent to recipient', 'in_transit'],
  ['Handed Over to Delivery Partner', 'in_transit'],
  ['Arrived at sorting center', 'in_transit'],
  ['Dispatched from sorting center', 'in_transit'],
  ['Assigned to Transport', 'in_transit'],
  ['Shipment at final delivery center', 'in_transit'],
  ['Delivery scheduled in the final delivery depot', 'out_for_delivery'],
  ['Delivery attempted', 'failed_attempt'],
  ['Arrived at Pick-up Point', 'ready_for_pickup'],
  ['Successfully delivered', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

// A category settles a stage only where it cannot hide another one.
const CATEGORIES: ReadonlyMap<string, Stage> = new Map([['transit', 'in_transit'], ['pre-alert', 'registered']]);

/** The stage MHI's map gives an event text. */
export function mhiMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** An event's stage: its text's, else the shared wording rules', else its category's, else nothing. */
export function mhiStage(description: string, category: string): ClassifiedWording | null {
  const mapped = mhiMappedStage(description);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  if (worded.source !== 'none') return worded;
  const filed = CATEGORIES.get(category.toLowerCase());
  return filed ? { stage: filed, source: 'carrier_map' } : null;
}

/** Every text seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mhiMappedStage(wording),
  gaps: [],
};
