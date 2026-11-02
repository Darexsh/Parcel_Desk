import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * WINIT's codes for the scans its own warehouses and depots write. Only codes
 * seen in replies or in WINIT's tracking documentation are mapped.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['WFD', 'registered'], // The order is submitted; the warehouse has not prepared it yet.
  ['PAC', 'accepted'], // Packed in the overseas warehouse, which already holds the goods.
  // "Awaiting pickup": packed and waiting for the courier to collect it from
  // the warehouse, not for the recipient.
  ['DIC', 'accepted'],
  ['WFR', 'accepted'], // "Ready for pick-up", again by the courier.
  ['GAO', 'in_transit'], // On the way to the courier's depot.
]);

/**
 * WINIT's own wording, for scans that come without a code, and the partners'
 * wording the shared rules do not read. A courier's "awaiting pickup" or
 * "ready for pick-up" is the recipient's, so those are left to the shared
 * rules and read as WINIT's only through their codes.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['prepare for shipments', 'registered'],
  ['提交订单', 'registered'],
  ['item(s) packed', 'accepted'],
  ['acceptance', 'accepted'],
  ['货物已收到', 'accepted'],
  ['拣选完成', 'accepted'],
  ['打包完成', 'accepted'],
  ['processing shipment', 'in_transit'],
  ['enroute to operation center', 'in_transit'],
  ['入库完成', 'in_transit'],
  ['操作中转', 'in_transit'],
  ['已交航', 'in_transit'],
  ['已出库', 'in_transit'],
  ['发货完成', 'in_transit'],
  // Shown once the warehouse hands the parcel over; not the courier's final round.
  ['派送中', 'in_transit'],
  // UPS keeps a parcel at an Access Point until the recipient collects it.
  ['ups access point™ possession', 'ready_for_pickup'],
]);

// WINIT's depot line can name the service after it.
const DEPOT = /^enroute to carrier[’']s depot\b/;

/** The stage WINIT's map gives a scan's code or wording. */
export function winitMappedStage(code: string | null, wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return (code ? CODES.get(code.toUpperCase()) : undefined) ?? WORDINGS.get(key) ?? (DEPOT.test(key) ? 'in_transit' : undefined);
}

/** A scan's stage: WINIT's map, else the shared wording rules, else nothing. */
export function winitStage(code: string | null, wording: string): ClassifiedWording | null {
  const mapped = winitMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The tab the tracker files a shipment under. In Transit, Transfer Post
 * Office (an untracked service) and Not Found leave the stage to the scans.
 */
const TABS: ReadonlyMap<string, Stage> = new Map([
  ['haveSignedIn', 'delivered'],
  ['failed', 'failed_attempt'],
  ['exception', 'exception'],
]);

export const WINIT_TABS = ['haveSignedIn', 'failed', 'exception', 'transportation', 'sendPost', 'noQuery'] as const;

export function winitTabStage(tab: string | undefined): Stage | undefined {
  return tab ? TABS.get(tab) : undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => winitMappedStage(code, wording),
  gaps: [],
};
