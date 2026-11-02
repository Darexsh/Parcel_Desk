import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// The current consumer site's status labels and its published sample history.
const STATUSES: Record<string, ClassifiedStatus & { wording: string }> = {
  '已揽件': { status: 'in_transit', stage: 'accepted', wording: 'Picked up' },
  '运输中': { status: 'in_transit', stage: 'in_transit', wording: 'In transit' },
  '派送中': { status: 'in_transit', stage: 'out_for_delivery', wording: 'Out for delivery' },
  '待取件': { status: 'in_transit', stage: 'ready_for_pickup', wording: 'Ready for pickup' },
  '已签收': { status: 'delivered', stage: 'delivered', wording: 'Delivered' },
};

export const yundaStatus = (label: string) => Object.hasOwn(STATUSES, label.trim()) ? STATUSES[label.trim()]! : null;

/** The wording the parser gives a scan on the way back to the sender, which says the leg itself. */
const RETURN_LEG = new Map<string, Stage>([
  ['returned to the sender', 'returned'],
  ['out for delivery back to the sender', 'out_for_delivery'],
  ['ready for pickup on its way back', 'ready_for_pickup'],
]);

/** What the map says about one scan: its Chinese label, kept as its code, and the wording of a return leg. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? RETURN_LEG.get(wording) ?? yundaStatus(code)?.stage : undefined),
  gaps: [],
};
