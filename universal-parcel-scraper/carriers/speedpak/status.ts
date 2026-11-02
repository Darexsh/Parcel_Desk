import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const MAP: Readonly<Record<string, ClassifiedStatus>> = {
  'Shipment Data Received': { status: 'pending', stage: 'registered' },
  'Package Received': { status: 'in_transit', stage: 'accepted' },
  'Arrived at Regional Distribution Center': { status: 'in_transit', stage: 'in_transit' },
  'Departed from Regional Distribution Center': { status: 'in_transit', stage: 'in_transit' },
  'Export Customs Declaration Completed': { status: 'in_transit', stage: 'in_transit' },
  'Departed from Origin Country': { status: 'in_transit', stage: 'in_transit' },
  'Arrived at Destination Hub': { status: 'in_transit', stage: 'in_transit' },
  'Import Customs Clearance Completed': { status: 'in_transit', stage: 'in_transit' },
  '货物运输中': { status: 'in_transit', stage: 'in_transit' },
  'In transit': { status: 'in_transit', stage: 'in_transit' },
  'Arrival scan': { status: 'in_transit', stage: 'in_transit' },
  'The freight handler collected the shipment at the airport': { status: 'in_transit', stage: 'in_transit' },
  'The item is received by PostNL': { status: 'in_transit', stage: 'in_transit' },
  'The item is at the PostNL sorting center': { status: 'in_transit', stage: 'in_transit' },
  'Out for delivery': { status: 'out_for_delivery', stage: 'out_for_delivery' },
};

const MOVING: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };

/**
 * SpeedPAK's own Chinese label for each scan (`eventDescCn`). It stays in
 * SpeedPAK's vocabulary when the English text is a last-mile carrier's
 * wording, so it classifies the scans the English map does not know.
 */
const LABELS: Readonly<Record<string, ClassifiedStatus>> = {
  订单接受: { status: 'pending', stage: 'registered' },
  订单已创建: { status: 'pending', stage: 'registered' },
  包裹已揽收: { status: 'in_transit', stage: 'accepted' },
  '大包收货确认(A-SCAN)': { status: 'in_transit', stage: 'accepted' },
  进入集货中心: MOVING,
  离开集货中心: MOVING,
  进入分拣中心: MOVING,
  到达分拣中心: MOVING,
  离开分拣中心: MOVING,
  出口国报关完成: MOVING,
  始发地出发: MOVING,
  航班起飞: MOVING,
  航班到达: MOVING,
  目的地到港: MOVING,
  干线运输到达: MOVING,
  进口国清关完成: MOVING,
  进口清关完成: MOVING,
  货物运输中: MOVING,
  到达站点: MOVING,
  离开站点: MOVING,
  站点扫描: MOVING,
  同步尾程供应商: MOVING,
  尾程转运中: MOVING,
  离开分拨站点: MOVING,
  目的国小包收货确认: MOVING,
  开始派送: { status: 'out_for_delivery', stage: 'out_for_delivery' },
  派送完成: { status: 'delivered', stage: 'delivered' },
};

const DELIVERED = /^Delivered(?:$|\. \()/;

/** SpeedPAK's Chinese wordings that can come as the English one too, in English. */
const ENGLISH: Readonly<Record<string, string>> = { 货物运输中: 'In transit' };

/** The English shown for a wording SpeedPAK sends in Chinese, or undefined. */
export const speedpakEnglish = (wording: string): string | undefined => (Object.hasOwn(ENGLISH, wording) ? ENGLISH[wording] : undefined);

/**
 * The line naming the last-mile carrier and its reference, in English or
 * Chinese, with a full- or half-width colon. SpeedPAK files it under
 * 同步尾程供应商, the hand-over to that carrier, so it is a movement.
 */
export const HANDOFF = /^(?:LM Carrier|尾程供应商)\s*[:：]\s*\[([^\]]+)\]\s*,\s*(?:LM tracking No[.．]?|尾程跟踪号)\s*[:：]\s*\[([A-Z0-9]{4,40})\]$/;

export function speedpakStatus(wording: string): ClassifiedStatus | null {
  if (DELIVERED.test(wording)) return { status: 'delivered', stage: 'delivered' };
  if (HANDOFF.test(wording)) return MOVING;
  return Object.hasOwn(MAP, wording) ? MAP[wording]! : null;
}

/** The English wording's status, else the Chinese label's. */
export function speedpakScanStatus(wording: string, label: string): ClassifiedStatus | null {
  return speedpakStatus(wording) ?? (Object.hasOwn(LABELS, label) ? LABELS[label]! : null);
}

const STAGE_BY_WORDING = new Map<string, Stage>(Object.entries(MAP).map(([wording, { stage }]) => [normalizeStatusWording(wording), stage]));
const DELIVERED_WORDING = new RegExp(DELIVERED.source, 'i');
const HANDOFF_WORDING = new RegExp(HANDOFF.source, 'i');

/**
 * What the map says about one scan by its English wording, the only key a scan
 * keeps: it has no code, and SpeedPAK's Chinese label, which stages the scans
 * whose English wording is a last-mile carrier's, is not stored with it.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (code) return undefined;
    if (DELIVERED_WORDING.test(wording)) return 'delivered';
    if (HANDOFF_WORDING.test(wording)) return MOVING.stage;
    return STAGE_BY_WORDING.get(wording);
  },
  gaps: [],
};
