import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * EURODIS's tracker sends no status codes, only English wording, the same for
 * a shipment's history and its colli's. The gateways are the members' export
 * and import hubs; a parcel at the delivery depot is still in transit.
 */
const WORDINGS: Readonly<Record<string, Stage>> = {
  'shipment data received': 'registered',
  'outbound gateway': 'in_transit',
  'in transit': 'in_transit',
  depot: 'in_transit',
  'inbound gateway': 'in_transit',
  'delivery depot': 'in_transit',
  'out for delivery': 'out_for_delivery',
  delivered: 'delivered',
  'delivered completely': 'delivered',
  // Left where the recipient agreed beforehand that it may be left.
  'delivered by deposit agreement': 'delivered',
  'delivery problem': 'exception',
  'returned to consignor': 'returned',
};

// An arrangement for the delivery, which moves nothing by itself.
const QUIET = new Set(['special delivery agreement']);

/** The stage the map gives a wording, if it knows it. */
export function eurodisWordingStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return Object.hasOwn(WORDINGS, normalized) ? WORDINGS[normalized] : undefined;
}

/** Wording that keeps the stage of the scan before it. */
export function eurodisQuiet(wording: string): boolean {
  return QUIET.has(normalizeStatusWording(wording));
}

/** A scan's stage: EURODIS's wording, else the shared wording rules, else nothing. */
export function eurodisStage(wording: string): ClassifiedWording | null {
  const mapped = eurodisWordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (eurodisQuiet(wording)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one scan, by its wording: EURODIS sends no codes. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : eurodisWordingStage(wording)),
  gaps: [
    { wording: 'special delivery agreement', note: 'An arrangement for the delivery, such as another day or place; it moves nothing by itself.' },
  ],
};
