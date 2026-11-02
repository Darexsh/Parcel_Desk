import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const STATUS = new Map<string, ClassifiedStatus>([
  ['123', { status: 'in_transit', stage: 'in_transit' }],
  ['756', { status: 'in_transit', stage: 'in_transit' }],
  ['310', { status: 'in_transit', stage: 'accepted' }],
  ['311', { status: 'in_transit', stage: 'accepted' }],
  ['111', { status: 'in_transit', stage: 'in_transit' }],
  ['131', { status: 'in_transit', stage: 'in_transit' }],
  ['171', { status: 'in_transit', stage: 'in_transit' }],
  ['136', { status: 'in_transit', stage: 'in_transit' }],
  ['176', { status: 'in_transit', stage: 'in_transit' }],
  ['710', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['741', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['746', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['745', { status: 'delivered', stage: 'delivered' }],
  ['835', { status: 'exception', stage: 'exception' }],
  // A security check in the network, seen for a winter sports event: the parcel moves on.
  ['996', { status: 'in_transit', stage: 'in_transit' }],
]);

/** The locker or station code, read with its sign type. */
const STATION = '751';

/** Exact operation codes from the domestic website; unfamiliar codes stay unmapped. */
export function ytoStatus(code: string, signType?: unknown): ClassifiedStatus | undefined {
  if (code === STATION) return signType === '1'
    ? { status: 'in_transit', stage: 'in_transit' } : { status: 'in_transit', stage: 'ready_for_pickup' };
  return STATUS.get(code);
}

/** The wording of a signature on the way back: the sender took the parcel. */
export const YTO_RETURNED = 'Returned to the sender';

/**
 * What the map says about one scan by its operation code, where a signature
 * worded as the trip back is the return. Code 751 is read by a sign type the
 * code does not carry, so the code alone gives it no stage.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const stage = code && code !== STATION ? ytoStatus(code)?.stage : undefined;
    return stage === 'delivered' && wording === normalizeStatusWording(YTO_RETURNED) ? 'returned' : stage;
  },
  gaps: [],
};

export interface YtoScan {
  stage: Stage;
  wording: string;
  returnLeg?: true;
}

// English is ParcelsApp's translation of the label, where one was seen.
const SCANS: ReadonlyArray<readonly [chinese: string, english: string | null, stage: Stage, wording: string]> = [
  ['揽收扫描', 'Pickup scan', 'accepted', 'Picked up'],
  // The courier's own pickup, under the same code as the pickup scan.
  ['业务员收件', null, 'accepted', 'Picked up'],
  ['装件入车扫描', 'Load scan into vehicle', 'in_transit', 'Loaded for transport'],
  ['下车扫描', 'Get off scan', 'in_transit', 'Unloaded at a sorting centre'],
  ['快件城市信息', 'Package city information', 'in_transit', 'In transit'],
  ['退回件扫描', 'Return package scan', 'exception', 'Return to the sender started'],
  ['派件扫描', 'Delivery scan', 'out_for_delivery', 'Out for delivery'],
  ['入柜|入库', 'In cabinet | In storage', 'ready_for_pickup', 'In a parcel locker or pickup station'],
  // The courier took the parcel back out of the locker or station.
  ['小件员取出', 'Small item handler takes out.', 'in_transit', 'Taken out of the locker by the courier'],
  ['PDA正常签收扫描', 'PDA normal delivery scan', 'delivered', 'Delivered'],
  // A security check in the network for a winter sports event: the parcel moves on.
  ['冬运会安检', null, 'in_transit', 'Security check'],
];

function key(label: string): string {
  return label.trim().replace(/\s*\|\s*/g, '|').replace(/[.。]+$/, '').toLowerCase();
}

const BY_LABEL = new Map(SCANS.flatMap(([chinese, english, stage, wording]) => {
  const entry: YtoScan = { stage, wording, ...(chinese === '退回件扫描' ? { returnLeg: true } : {}) };
  return [chinese, english].filter((label) => label !== null).map((label) => [key(label), entry] as const);
}));

/** The stage and stored wording of one YTO scan label, Chinese or translated. */
export function ytoScan(label: string): YtoScan | undefined {
  return BY_LABEL.get(key(label));
}
