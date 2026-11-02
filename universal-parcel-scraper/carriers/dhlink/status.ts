import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * DHLink's standard nodes, by the `nodeCode` a row carries. The warehouse
 * lines (WH), the ePacket line (EUBJ) and the postal line (J) name their nodes
 * alike; FA001 to DE001 are the steps of the tracking page's progress rail.
 * "Dispatched" is the warehouse's or the collection point's receipt; TQ001 is
 * the last-mile partner taking the parcel over.
 */
const NODE_CODES: ReadonlyMap<string, Stage> = new Map([
  ['WH001', 'accepted'],
  ['EUBJ007', 'accepted'],
  ['WH011', 'in_transit'],
  ['EUBJ009', 'in_transit'],
  ['FA001', 'in_transit'],
  ['EUBJ010', 'in_transit'],
  ['AD001', 'in_transit'],
  ['TQ001', 'in_transit'],
  // A US line's rail, the same nodes with WC ahead.
  ['WCTQ001', 'in_transit'],
  ['QG001', 'in_transit'],
  // Import clearance done, before the last-mile partner takes the parcel.
  ['QG002', 'in_transit'],
  ['JH001', 'in_transit'],
  ['J013', 'out_for_delivery'],
  ['DE002', 'out_for_delivery'],
  ['J014', 'delivered'],
  ['DE001', 'delivered'],
]);

/** The same nodes by name, for a line whose codes the map does not know yet. */
const NODE_NAMES: ReadonlyMap<string, Stage> = new Map([
  ['dispatched', 'accepted'],
  ['outbound', 'in_transit'],
  ['origin leaving', 'in_transit'],
  ['original leaving', 'in_transit'],
  ['destination arrived', 'in_transit'],
  ['pending delivery', 'out_for_delivery'],
  ['delivered', 'delivered'],
]);

/**
 * DHLink's own wordings, the English that EMS relays beside China Post's
 * scans and GOFO's relayed scans, where the shared rules would read them
 * otherwise or not at all.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['arrive at the collection warehouse', 'accepted'],
  ['the collection warehouse has completed sorting', 'accepted'],
  ['package received & scanned at warehouse', 'accepted'],
  ['package received and scanned at warehouse', 'accepted'],
  ['parcel handed over to carrier,waiting for transportation', 'accepted'],
  // A line's collection point and its domestic warehouse, before export.
  ['the goods arrive at the receiving point', 'accepted'],
  ["package received & scanned at carrier's domestic warehouse.", 'accepted'],
  ["package depart carrier's domestic warehouse.", 'in_transit'],
  // China Post's receipt (中国邮政 已收取邮件).
  ['package received', 'accepted'],
  ['the package has sent from the warehouse', 'in_transit'],
  ['package departed from the warehouse', 'in_transit'],
  ['flight departure', 'in_transit'],
  ['the flight has taken off', 'in_transit'],
  ['the flight has arrived and the board is being dismantled', 'in_transit'],
  ['flight arrival', 'in_transit'],
  // Import clearance is done and the parcel moves on.
  ['customs clearance completed', 'in_transit'],
  ['customs import clearance completed, awaiting pickup by local carrier', 'in_transit'],
  // The hand-over to the US partner, first announced, then made.
  ['ups/usps/fedex', 'in_transit'],
  // On its way to the last-mile partner after import clearance, on a US line SwiftX delivers.
  ['in transit to service provider', 'in_transit'],
  ['货物已交ups/usps/fedex,the goods have been delivered to ups/usps/fedex', 'in_transit'],
  // GOFO's scans in its own words, which DHLink relays on a US line GOFO delivers.
  ['shipping label created', 'registered'],
  ['arrived at gofo regional hub', 'in_transit'],
  ['loaded on vehicle', 'in_transit'],
  ['departed gofo regional hub', 'in_transit'],
  ['in transit to next facility', 'in_transit'],
  ['arrived at gofo delivery station', 'in_transit'],
  // A US line's trucking between its origin and destination hubs, before the last-mile carrier picks the parcel up.
  ['arrived at origin hub', 'in_transit'],
  ['departed origin hub', 'in_transit'],
  ['arrived at destination hub', 'in_transit'],
  ['departed destination hub', 'in_transit'],
  // Its last-mile warehouse, then the delivery round.
  ['arrived at warehouse', 'in_transit'],
  // The flight landed in the destination country.
  ['package arrived at destination country', 'in_transit'],
  // The last-mile partner's depot taking in the parcel the line handed over.
  ['shipment received in depot', 'in_transit'],
  // The last-mile carrier's pickup on a row without DHLink's node, then its local facility's receipt.
  ['package picked up by last-mile carrier', 'in_transit'],
  ['parcel received by local facility.', 'in_transit'],
  ['out for delivery', 'out_for_delivery'],
  // China Post hands the dispatch to the airline after taking the parcel.
  ['handed over to airlines', 'in_transit'],
  // DHLink's own nodes QG001 and JH001: export clearance, then the hand-over to the airline.
  ['customs export clearance completed', 'in_transit'],
  ['package handed over to airline', 'in_transit'],
  ['item presented to customs', 'customs'],
  // Export customs released the item (出口海关/放行).
  ['item returned from customs?', 'in_transit'],
  // China Post's 安排投递 abroad.
  ['scheduled for delivery', 'out_for_delivery'],
]);

/** DHLink's and China Post's scans in Chinese, and a relayed USPS notice. */
const PATTERNS: readonly (readonly [RegExp, Stage])[] = [
  // The order a line on the Hualei platform writes when the parcel's data reaches it: before any
  // scan, DHLink's shipper data; after DHLink's scans, the line DHLink booked, which the parser
  // keeps from stepping back.
  [/^货物电子信息已经?收到$/, 'registered'],
  [/^已入库$/, 'accepted'],
  [/已收取邮件$/, 'accepted'],
  [/^已出库$/, 'in_transit'],
  [/^邮件(?:到达|离开)/, 'in_transit'],
  [/完成分拣/, 'in_transit'],
  [/^揽投配发$/, 'in_transit'],
  [/^航空公司(?:接收|启运)$/, 'in_transit'],
  [/^飞机到达进港$/, 'in_transit'],
  [/^已交承运商运输$/, 'in_transit'],
  [/已出口直封$/, 'in_transit'],
  [/^出口海关\/放行$/, 'in_transit'],
  // China's export clearance done ("domestic clearance"), as its QG001 node words it in English, and its export declaration.
  [/^国内清关完成$/, 'in_transit'],
  [/^出口申报完成$/, 'in_transit'],
  // At the airport waiting for a flight, in Chinese with DHLink's English.
  [/^arriving at the airport - arranging flights\b|^到达机场-安排航班中$/, 'in_transit'],
  [/^到达寄达地(?:处理中心)?$/, 'in_transit'],
  // Collected at the destination port after import clearance, though its English says a delivery was made.
  [/^目的港已提货/, 'in_transit'],
  [/^离开【[^】]*】处理中心$/, 'in_transit'],
  [/^送交出口海关$/, 'customs'],
  // A line's own rows in Chinese, most with its English after them: the collection point and the
  // operation centre, the warehouse's intake and customs' release before the flight, the flight,
  // the dispatch unpacked and collected, import clearance, then the destination warehouse and the
  // hand-over to the local carrier.
  [/^到达收货点$/, 'accepted'],
  // DHLink's warehouses after its receipt: one in China before export ("您的物品已到达华东仓"), and one in
  // the destination country after import clearance ("Your item arrived at … warehouse").
  [/^您的物品已(?:到达|离开).{1,30}仓$/, 'in_transit'],
  [/^your item arrived at .{1,120} warehouse$/, 'in_transit'],
  [/^货物离开操作中心$/, 'in_transit'],
  [/^进仓时间[:：]/, 'in_transit'],
  [/^通关放行[;；]/, 'in_transit'],
  [/^航班起飞[,，]/, 'in_transit'],
  [/^航班已落地[;；]/, 'in_transit'],
  [/^拆板提货中[;；]/, 'in_transit'],
  [/^拆板清关中[;；]/, 'customs'],
  [/^清关完成[,，]交仓中/, 'in_transit'],
  [/^货物已交仓[,，]/, 'in_transit'],
  [/^包裹交接给本地物流商处理/, 'in_transit'],
  [/安排投递$/, 'out_for_delivery'],
  [/已妥投$/, 'delivered'],
  // USPS's attempt, relayed after the post office's place.
  [/\bno access to delivery location$/, 'failed_attempt'],
];

function wordingStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? PATTERNS.find(([pattern]) => pattern.test(key))?.[1];
}

// DHLink's own nodes in Chinese, in the English it words them in elsewhere: QG001 for China's export clearance.
const ENGLISH: ReadonlyMap<string, string> = new Map([
  ['国内清关完成', 'Customs export clearance completed'],
  ['到达机场-安排航班中', 'Arriving at the airport - arranging flights'],
]);

/** The English shown for DHLink's own wording in Chinese, or for a wording in both languages, its English half. */
export function dhlinkEnglish(wording: string): string | undefined {
  const text = wording.replace(/\s+/g, ' ').trim();
  const english = ENGLISH.get(text);
  if (english) return english;
  const split = text.lastIndexOf('/');
  const half = split > 0 ? ENGLISH.get(text.slice(split + 1).trim()) : undefined;
  return half && normalizeStatusWording(half) === normalizeStatusWording(text.slice(0, split)) ? text.slice(0, split).trim() : undefined;
}

/** The flight DHLink books the parcel on, written before it: no scan, so the adapter drops the row. */
export const FLIGHT_BOOKED = /^预计配载航班(?:\d{1,2}月\d{1,2}日|时间[:：])/;

/**
 * A row's stage: its node, by code then by name, DHLink's map of the wording,
 * else the shared rules, which read the partners' relayed English. Null when
 * nothing reads it.
 */
export function dhlinkStage(code: string, name: string, wording: string): ClassifiedWording | null {
  const mapped = NODE_CODES.get(code) ?? NODE_NAMES.get(normalizeStatusWording(name)) ?? wordingStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'pending');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? NODE_CODES.get(code) : undefined) ?? wordingStage(wording),
  gaps: [],
  gapNote: (_code, wording) => (FLIGHT_BOOKED.test(wording)
    ? 'The flight the parcel is booked on, any date, not a movement: the adapter drops the row and the parcel keeps the stage it had.' : undefined),
};
