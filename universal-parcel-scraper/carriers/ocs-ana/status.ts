import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * OCS's activities, the first column of its history, as its English page words
 * them. A scan's wording is the activity, then the memo beside it after a
 * colon, as "Importation Entry: Manifest Declaration (Z)". The activity stages
 * the scan. Only activities seen in replies are mapped; another falls to the
 * shared wording rules.
 */
const ACTIVITIES: ReadonlyMap<string, Stage> = new Map([
  // The shipper's data, sent by EDI, before OCS has the shipment.
  ['shipment information entered at customer site', 'registered'],
  ['shipment data entry', 'registered'],
  ['pickup', 'accepted'],
  ['arrived at facility', 'in_transit'],
  ['departed from facility', 'in_transit'],
  ['in transit', 'in_transit'],
  ['export declaration', 'customs'],
  // Japanese customs released the shipment for export.
  ['export authorization', 'in_transit'],
  ['flight departure', 'in_transit'],
  ['importation entry', 'customs'],
  ['released from customs', 'in_transit'],
  // The delivery route in Japan is set, and the shipment waits for the contracted delivery company.
  ['delivery route fix', 'in_transit'],
  ['ready to hand over to contracted company', 'in_transit'],
  ['delivered', 'delivered'],
]);

/** The activity of the contracted Japanese delivery company's own scans, whose memo holds their status. */
const PARTNER_ACTIVITY = 'status updated by delivery contracted company';
const PARTNER_STATUSES: ReadonlyMap<string, Stage> = new Map([
  // The delivery company took the shipment over from OCS.
  ['pickup', 'in_transit'],
  ['in transit', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/** A scan's wording split into its activity and its memo, in `normalizeStatusWording` form. */
function parts(wording: string): { activity: string; memo: string } {
  const normalized = normalizeStatusWording(wording);
  const at = normalized.indexOf(': ');
  return at < 0 ? { activity: normalized, memo: '' } : { activity: normalized.slice(0, at), memo: normalized.slice(at + 2) };
}

/** The stage OCS's activities, or the delivery company's memo, give a scan's wording. */
export function ocsMappedStage(wording: string): Stage | undefined {
  const { activity, memo } = parts(wording);
  return activity === PARTNER_ACTIVITY ? PARTNER_STATUSES.get(memo) : ACTIVITIES.get(activity);
}

/**
 * A scan's stage: the map, else the shared wording rules, else nothing. A
 * delivery company's scan the map does not know is read by its memo alone,
 * since the activity's own words say nothing of its status.
 */
export function ocsStage(wording: string): ClassifiedWording | null {
  const mapped = ocsMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const { activity, memo } = parts(wording);
  if (activity === PARTNER_ACTIVITY && !memo) return null;
  const worded = classifyWording(activity === PARTNER_ACTIVITY ? memo : wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => ocsMappedStage(wording),
  gaps: [],
};
