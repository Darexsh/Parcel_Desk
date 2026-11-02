import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

export interface StoScan extends ClassifiedStatus {
  /** The wording stored for the scan; STO's own text names couriers, phones and addresses. */
  wording: string;
}

// The scan types (scanType) STO's trace returns. Others stay unmapped and keep
// their own label for the shared wording rules.
const SCANS: Readonly<Record<string, StoScan>> = {
  收件: { status: 'in_transit', stage: 'accepted', wording: 'Picked up' },
  发件: { status: 'in_transit', stage: 'in_transit', wording: 'Departed' },
  到件: { status: 'in_transit', stage: 'in_transit', wording: 'Arrived' },
  派件: { status: 'out_for_delivery', stage: 'out_for_delivery', wording: 'Out for delivery' },
  驿站代收: { status: 'in_transit', stage: 'ready_for_pickup', wording: 'At a parcel station for collection' },
  柜机代收: { status: 'in_transit', stage: 'ready_for_pickup', wording: 'In a parcel locker for collection' },
  客户签收: { status: 'delivered', stage: 'delivered', wording: 'Delivered' },
  签收: { status: 'delivered', stage: 'delivered', wording: 'Delivered' },
};

/** The wording of a return scan, which starts the trip back to the sender. */
export const STO_RETURN_STARTED = 'Return to the sender started';

/** The wording of a delivery-side scan on the trip back, by the stage its scan type has. */
export const STO_RETURN_LEG: Readonly<Partial<Record<Stage, string>>> = {
  out_for_delivery: 'Out for delivery back to the sender',
  ready_for_pickup: 'In a parcel locker or station on its way back',
  delivered: 'Returned to the sender',
};

export function stoScan(scanType: string): StoScan | undefined {
  return Object.hasOwn(SCANS, scanType) ? SCANS[scanType] : undefined;
}

/** A scan type the map does not know that names a return (退回, 退件). */
export function isStoReturnScan(scanType: string): boolean {
  return !stoScan(scanType) && /退回|退件/.test(scanType);
}

/**
 * What the map says about one scan, by its scan type and the wording the
 * parser stored for it: the type's own wording (a departure followed by its
 * next facility), its wording on the trip back, where a signature is a return,
 * or a return scan's.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const scan = code ? stoScan(code) : undefined;
    if (!scan) return code && isStoReturnScan(code) && wording === normalizeStatusWording(STO_RETURN_STARTED) ? 'exception' : undefined;
    const own = normalizeStatusWording(scan.wording);
    if (wording === own || (code === '发件' && wording.startsWith(`${own} for `))) return scan.stage;
    const back = STO_RETURN_LEG[scan.stage];
    if (back && wording === normalizeStatusWording(back)) return scan.stage === 'delivered' ? 'returned' : scan.stage;
    return undefined;
  },
  gaps: [],
};
