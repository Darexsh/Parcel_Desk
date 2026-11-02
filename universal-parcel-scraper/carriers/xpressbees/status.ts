import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
// Exact states in the official public seller tracking feed.
const STAGES: Readonly<Record<string, Stage>> = {
  'data received': 'registered', 'out for pickup': 'registered', 'pickup scheduled': 'registered',
  picked: 'accepted', pickdone: 'accepted', 'picked up': 'accepted',
  intransit: 'in_transit', 'in transit': 'in_transit', 'reached at destination': 'in_transit',
  'out for delivery': 'out_for_delivery', delivered: 'delivered',
  'wrong pincode': 'exception', 'return undelivered': 'failed_attempt', 'rto undelivered': 'failed_attempt',
  rto: 'exception', 'return to origin': 'exception', 'return to origin intransit': 'in_transit', 'rto in transit': 'in_transit', 'reached at origin': 'in_transit',
  'return to origin out for delivery': 'out_for_delivery', 'rto out for delivery': 'out_for_delivery',
  'rto delivered': 'returned', 'return delivered': 'returned',
};
export function xpressbeesStage(raw: string): Stage | undefined {
  return STAGES[raw.toLowerCase().replace(/[-_]/g, ' ').trim().replace(/\s+/g, ' ')];
}

/**
 * What the map says about one scan: its state wording. Wording it does not list took the row's
 * category, which the stored scan does not keep, so it stays open; so does a bare delivery,
 * which is the return's when that category is a return to origin.
 */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => (wording === 'delivered' ? undefined : xpressbeesStage(wording)),
  gaps: [{ wording: 'delivered', note: 'Delivered, or the return delivered to the sender when the row\'s category is a return to origin: the stored scan does not keep the category.' }],
};
