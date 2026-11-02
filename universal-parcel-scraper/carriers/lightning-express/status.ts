import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The order status codes of Lightning Express's tracking service, with the
 * English labels the tracking page gives them. The reply names a status in
 * Chinese (`status_name`); the code decides.
 */
const CODES: ReadonlyMap<string, { stage: Stage; label: string }> = new Map([
  ['0', { stage: 'registered', label: 'Label created' }],
  ['5', { stage: 'accepted', label: 'Package collected' }],
  ['4', { stage: 'out_for_delivery', label: 'Out for delivery' }],
  ['2', { stage: 'delivered', label: 'Delivered' }],
  // Back at the depot after a delivery run that did not deliver: a parcel can go
  // out again and be delivered after it, so it is no return to the sender.
  ['3', { stage: 'failed_attempt', label: 'Returned to warehouse' }],
  ['-1', { stage: 'exception', label: 'This order has been cancelled' }],
] as const);

/** The stage Lightning Express's status code gives, if the map knows the code. */
export function lightningExpressStage(code: string): Stage | undefined {
  return CODES.get(code)?.stage;
}

/** The tracking page's English label for a status code. */
export function lightningExpressLabel(code: string): string | undefined {
  return CODES.get(code)?.label;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? lightningExpressStage(code) : undefined),
  gaps: [
    { code: '1', note: 'A state the tracking page\'s own script ignores, drawing the parcel as a new label; nothing says what it means.' },
  ],
};
