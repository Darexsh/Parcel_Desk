import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status names of TFM Express's tracker, which it writes in each history
 * row's Status column beside the row's activity. The tracker shows them as
 * provider codes. Only names seen in replies are mapped; another name falls to
 * the shared wording rules.
 */
const STATUSES: ReadonlyMap<string, Stage> = new Map([
  // The sender booked the airwaybill; TFM has not collected the parcel yet.
  ['shipment created', 'registered'],
  ['picked up', 'accepted'],
  ['received at hub', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  // The courier found nobody in; the parcel goes out again.
  ['consignee not available', 'failed_attempt'],
  ['delivered', 'delivered'],
]);

/** The stage TFM Express's status names give a status name, in any case and spacing. */
export function tfmExpressMappedStage(status: string): Stage | undefined {
  return STATUSES.get(normalizeStatusWording(status));
}

/** A row's stage: its status name, else the shared rules on its activity, then on its status name. */
export function tfmExpressStage(status: string, activity: string): ClassifiedWording | null {
  const mapped = tfmExpressMappedStage(status);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  for (const text of [activity, status]) {
    const worded = text ? classifyWording(text, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}

export const statusMap: CarrierStatusMap = {
  codeKey: normalizeStatusWording,
  stage: (code) => (code ? tfmExpressMappedStage(code) : undefined),
  gaps: [],
};
