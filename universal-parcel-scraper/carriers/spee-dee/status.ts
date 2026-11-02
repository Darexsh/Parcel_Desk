import type { ClassifiedStatus } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Activities of Spee-Dee's package progress table, as the page writes them.
// Other wording is left to the shared classifier.
const ACTIVITIES = new Map<string, ClassifiedStatus>([
  ['ARRIVAL SCAN', { status: 'in_transit', stage: 'in_transit' }],
  ['OUT FOR DELIVERY', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['DELIVERED', { status: 'delivered', stage: 'delivered' }],
]);

/** An activity as it is kept: what follows "OUT FOR DELIVERY" in parentheses, a route number, is dropped. */
export function speeDeeActivity(raw: string): string {
  return /^OUT FOR DELIVERY\s*\(.*\)$/i.test(raw) ? 'OUT FOR DELIVERY' : raw;
}

export function speeDeeStatus(activity: string): ClassifiedStatus | undefined {
  return ACTIVITIES.get(activity.toUpperCase());
}

/** What the map says about one scan: its activity, as the parser keeps it. */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => speeDeeStatus(wording)?.stage, gaps: [] };
