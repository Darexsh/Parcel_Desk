import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's wordings, as `normalizeStatusWording` keys them: transport
 * scans in New Zealand, Australia, the United States and Europe, air and ocean
 * milestones, and the overall statuses the page heads a shipment with.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  // New Zealand and Australian transport.
  ['information received', 'registered'],
  ['pickup allocated to driver', 'registered'],
  ['picked up', 'accepted'],
  ['in transit', 'in_transit'],
  ['at delivery depot', 'in_transit'],
  ['on delivery vehicle', 'out_for_delivery'],
  ['delivered', 'delivered'],
  // The older tracker's delivery.
  ['delivered!', 'delivered'],
  // American transport, once the place is taken off the wording.
  ['booked', 'registered'],
  ['pickup assigned to driver', 'registered'],
  ['goods picked up', 'accepted'],
  ['departed from terminal', 'in_transit'],
  ['arrived at terminal', 'in_transit'],
  ['on drivers vehicle en-route', 'out_for_delivery'],
  ['goods delivered', 'delivered'],
  ['collected by customer', 'delivered'],
  // European transport.
  ['order received', 'registered'],
  ['shipment loaded into line haul truck', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  // Air and ocean jobs. Cleared customs puts the cargo back in transit.
  ['booking confirmation sent', 'registered'],
  ['pickup cartage advised', 'registered'],
  ['pick up cartage complete', 'accepted'],
  ['origin customs cleared', 'in_transit'],
  ['departure from first load port', 'in_transit'],
  ['arrival at final discharge port', 'in_transit'],
  ['customs clearance commenced', 'customs'],
  ['customs clearance finalised', 'in_transit'],
  // Released at destination, before the delivery cartage.
  ['cargo available', 'in_transit'],
  ['cargo delivered', 'delivered'],
  ['full container delivered', 'delivered'],
  // Overall statuses.
  ['created', 'registered'],
  ['received', 'accepted'],
  ['departed', 'in_transit'],
  ['departed origin', 'in_transit'],
  ['arrived at final discharge port', 'in_transit'],
  ['final delivery', 'delivered'],
]);

// A container job's leg, named after its kind: "Picked Up (Site Movement)".
// The legs before the last move the container between sites; the last ends
// with its final delivery.
const CONTAINER_LEG = /^(final )?(?:pending collection|pick up|picked up|deliver|delivery) \([^()]+\)$/;

// The step the older tracker offered notifications for: expected, not done.
const EXPECTED = 'due for delivery';

/** The stage the tracker's own wording gives. */
export function mainfreightMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  const mapped = WORDINGS.get(key);
  if (mapped) return mapped;
  const leg = CONTAINER_LEG.exec(key);
  if (!leg) return undefined;
  return leg[1] && /delivery \(/.test(key) ? 'delivered' : 'in_transit';
}

/** A scan's stage: the tracker's wording, else the shared wording rules, else nothing. */
export function mainfreightStage(wording: string): ClassifiedWording | null {
  const mapped = mainfreightMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (normalizeStatusWording(wording) === EXPECTED) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

// American transport scans name the place after the wording, with its ZIP code.
const PLACED = /^(goods picked up) from (.+)$|^(goods delivered|on drivers vehicle en-route) to (.+)$|^((?:departed from|arrived at) terminal) (.+)$/i;
const ZIP = /,\s*\d{5}(?:-\d{4})?$/;

/** A wording without the place an American scan names in it, and that place without its ZIP code. */
export function placedWording(wording: string): { wording: string; place?: string } {
  const match = PLACED.exec(wording);
  if (!match) return { wording: wording.replace(ZIP, '') };
  const [said, place] = match[1] ? [match[1], match[2]!] : match[3] ? [match[3], match[4]!] : [match[5]!, match[6]!];
  const town = place.replace(ZIP, '').trim();
  return { wording: said, ...(town ? { place: town } : {}) };
}

/** The tracker's scans carry no code; the wording alone gives the stage. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mainfreightMappedStage(wording),
  gaps: [{ wording: EXPECTED, note: 'A step the older tracker offered notifications for: expected, not done.' }],
};
