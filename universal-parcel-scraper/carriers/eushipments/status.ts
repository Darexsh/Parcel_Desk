import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The statuses of euShipments' order history, which carry no code. A warehouse
 * or hub status names its place after the wording; the map reads the wording
 * without it. Another wording falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['New', 'registered'],
  // The order at euShipments' fulfilment warehouse.
  ['Warehouse', 'accepted'],
  // Line haul between euShipments' hubs.
  ['Loaded hub', 'in_transit'],
  ['Unloaded hub', 'in_transit'],
  // The last-mile courier has the parcel.
  ['Picked up', 'in_transit'],
  ['In transit', 'in_transit'],
  ['On delivery', 'out_for_delivery'],
  ['Delivered', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

// "Warehouse Sample", "Loaded hub Sample (HR)": the wording, then the place and its country.
const PLACED = /^(warehouse|loaded hub|unloaded hub) (.+?)(?: \(([a-z]{2})\))?$/i;

/** A status split into its wording and, for a warehouse or hub, the place it names. */
export function eushipmentsPlace(description: string): { wording: string; place?: string; country?: string } {
  const placed = PLACED.exec(description);
  return placed ? { wording: placed[1]!, place: placed[2]!, ...(placed[3] ? { country: placed[3].toUpperCase() } : {}) } : { wording: description };
}

/** The stage euShipments' map gives a wording in `normalizeStatusWording` form, with or without its place. */
export function eushipmentsMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(eushipmentsPlace(wording).wording);
}

/** A wording's stage: the map, else the shared wording rules, else nothing. */
export function eushipmentsStage(wording: string): ClassifiedWording | null {
  const mapped = eushipmentsMappedStage(normalizeStatusWording(eushipmentsPlace(wording).wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => eushipmentsMappedStage(wording),
  gaps: [],
};
