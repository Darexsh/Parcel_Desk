import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The English wording of Stallion's tracker. Its scans carry no code. Stallion
 * words its own label and depot scans, and relays the partner that delivers
 * the parcel in that partner's words. Those it maps are the ones seen from
 * Intelcom and PostNL; the rest go to the shared wording rules.
 */
const STAGES: ReadonlyMap<string, Stage> = new Map([
  ['label created', 'registered'],
  ['label printed, awaiting shipment', 'registered'],
  // Intelcom has the shipment's data, a minute after the label.
  ['tendered for delivery', 'registered'],
  // The partner takes the parcel over from Stallion's depot.
  ['received from prior carrier', 'in_transit'],
  ['acceptance', 'in_transit'],
  ['arrived at terminal location', 'in_transit'],
  ['parcel scanned on its journey', 'in_transit'],
  ['loaded on truck', 'out_for_delivery'],
  // Intelcom's delivery, which Stallion follows with its own "Delivered" a minute later.
  ['completed unloading at delivery location', 'delivered'],
  ['delivered', 'delivered'],
]);

// Stallion's depot scans name the depot: "Received at {town} ON, CA".
const RECEIVED_AT = /^received at \S/;
const IN_TRANSIT_FROM = /^in-transit from \S/;

/** The stage the map gives Stallion's wording, if it knows it. */
export function stallionScanStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  if (RECEIVED_AT.test(normalized)) return 'accepted';
  if (IN_TRANSIT_FROM.test(normalized)) return 'in_transit';
  return STAGES.get(normalized);
}

/** Stallion's own label and depot scans, which keep its true clock. */
export function stallionOwnScan(wording: string): boolean {
  const normalized = normalizeStatusWording(wording);
  return ['label created', 'label printed, awaiting shipment'].includes(normalized)
    || RECEIVED_AT.test(normalized) || IN_TRANSIT_FROM.test(normalized);
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function stallionStage(wording: string): ClassifiedWording | null {
  const mapped = stallionScanStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans carry wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : stallionScanStage(wording)),
  gaps: [],
};
