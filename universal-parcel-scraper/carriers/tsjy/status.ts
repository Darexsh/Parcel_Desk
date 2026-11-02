import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * TSJY's own steps in its Kunshan warehouse, written in Chinese. The customer
 * submits a shipping order for goods the warehouse stores; the warehouse picks,
 * packs and dispatches them to the line the order chose.
 */
const OWN: ReadonlyMap<string, Stage> = new Map([
  ['订单已提交，等待系统确认', 'registered'],
  ['仓库开始拣货', 'accepted'],
  ['仓库拣货完成', 'accepted'],
  ['订单打包完成，等待出库', 'accepted'],
  ['订单已出库，开始国际运输', 'in_transit'],
]);

/**
 * 17FEIA's English milestones, which TSJY relays for orders sent on its line,
 * as they read in TSJY's journey. The line's order data comes while TSJY still
 * holds the parcel; once TSJY dispatched it, 17FEIA's receipt and confirmation
 * are the journey going on.
 */
const RELAYED: ReadonlyMap<string, Stage> = new Map([
  ['item information received.', 'accepted'],
  ['the package is on the way to the facility.', 'in_transit'],
  ['warehouse receipt.', 'in_transit'],
  ['the order has information pending customer confirmation.', 'in_transit'],
  ['order confirmed.', 'in_transit'],
  ['order dispatched from warehouse.', 'in_transit'],
  ['export declaration in progress.', 'customs'],
  ['flight has departed.', 'in_transit'],
  ['flight arrived at transit hub.', 'in_transit'],
  ['flight departed from transit hub.', 'in_transit'],
  // The landing before import customs; the shared rules would read customs.
  ['flight arrived at clearance port.', 'in_transit'],
  // The customs broker's warehouse; the shared rules would read a delivery.
  ['broker picked up shipment and delivered to warehouse.', 'customs'],
  ['customs clearance is in progress.', 'customs'],
  ['customs clearance completed.', 'in_transit'],
]);

/** 17FEIA's estimated departure, written before the flight: no scan, so the adapter drops the row. */
export const ESTIMATE = /^estimated departure date\b/i;

/** 17FEIA's delayed flight, between the estimate and the take-off: no movement. */
const DELAY = 'flight delayed.';

/** Whether a row is the line's delayed flight, which keeps the stage of the row before it. */
export function isTsjyDelay(wording: string): boolean {
  return normalizeStatusWording(wording) === DELAY;
}

/** The stage TSJY's map gives a row's wording: its own steps, then 17FEIA's milestones. */
export function tsjyMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return OWN.get(key) ?? RELAYED.get(key);
}

/**
 * A relayed row no table names, through the shared rules. TSJY has dispatched
 * the parcel by the time a later carrier announces or receives it, so those
 * rows are the journey going on.
 */
function relayedStage(wording: string): ClassifiedWording | null {
  const worded = classifyWording(wording, 'pending');
  if (worded.source === 'none') return null;
  return ['pending', 'registered', 'accepted'].includes(worded.stage) ? { stage: 'in_transit', source: 'carrier_map' } : worded;
}

/** A row's stage, or null when nothing reads it. The rows carry no code. */
export function tsjyStage(wording: string): ClassifiedWording | null {
  if (isTsjyDelay(wording)) return null;
  const mapped = tsjyMappedStage(wording);
  return mapped ? { stage: mapped, source: 'carrier_map' } : relayedStage(wording);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code || isTsjyDelay(wording) ? undefined : tsjyMappedStage(wording) ?? relayedStage(wording)?.stage,
  gaps: [{ wording: DELAY, note: 'A delayed flight, not a movement: the parcel keeps the stage it had.' }],
};
