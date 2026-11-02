import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scan codes, from its Código column. Only codes seen on the
 * page are mapped; another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['007', 'accepted'], // The sender dropped the parcel at a pickup point.
  ['012', 'in_transit'], // The pickup point handed the parcel to DPD.
  // Collected by the courier; after an earlier movement, as at the pickup point
  // the sender dropped it at, a hand-over in transit.
  ['COL', 'accepted'],
  ['INB', 'in_transit'], // Scanned in at a depot on the way.
  ['HUB', 'in_transit'],
  ['PEC', 'in_transit'], // Scanned in at the depot before delivery.
  ['402', 'in_transit'], // Back at the depot to go out again.
  ['403', 'in_transit'], // Back at the depot after a failed attempt, not a return to the sender.
  ['410', 'in_transit'], // Held at the depot.
  ['723', 'in_transit'], // The sender corrected the address after a failed attempt.
  ['OFD', 'out_for_delivery'],
  // The driver left the parcel at a pickup point or locker, and the point took it in.
  ['001', 'ready_for_pickup'],
  ['002', 'ready_for_pickup'],
  ['500', 'failed_attempt'], // The address is wrong or unknown.
  ['501', 'failed_attempt'], // The address is incomplete or unreadable.
  ['506', 'failed_attempt'], // The recipient was not in.
  ['508', 'failed_attempt'], // The recipient was closed for holidays.
  ['521', 'failed_attempt'], // The locker or pickup point was full.
  // Nobody collected the parcel in time, and a return to the sender ordered:
  // delivery stops, and the parcel has not reached the sender yet.
  ['008', 'exception'],
  ['424', 'exception'],
  ['611', 'returned'],
  ['POD', 'delivered'],
]);

/** A courier's collection: it accepts the parcel, unless an earlier scan already did or moved it. */
export const DPD_PT_COLLECTION = 'COL';
/** The proof of delivery. After a return to the sender is ordered, it is the delivery back to the sender. */
export const DPD_PT_DELIVERY = 'POD';
/** The return to the sender, ordered. */
export const DPD_PT_RETURN = '424';
/** The pickup point's own scan; its comment names the point. */
export const DPD_PT_POINT_RECEIPT = '002';
/** The expected delivery day, dated when DPD set it rather than with the day: the history leaves it out. */
export const DPD_PT_FORECAST = '714';

// Messages to the recipient and requests for a new delivery or address: no
// movement, so the parcel keeps its stage.
const NOTICES: ReadonlyMap<string, string> = new Map([
  ['706', 'A message giving the recipient a delivery window; it moves nothing.'],
  ['709', 'A message telling the recipient of the next delivery; it moves nothing.'],
  ['714', 'The expected delivery day, which the history leaves out; it moves nothing.'],
  ['741', 'A request for a new delivery; the scans after it show what happened.'],
  ['743', 'A request to change the address; the scans after it show what happened.'],
]);

/** The stage DPD Portugal's code gives a scan, if any, read without the scans before it. */
export function dpdPtMappedStage(code: string): Stage | undefined {
  return CODES.get(code.toUpperCase());
}

export function isDpdPtNotice(code: string): boolean {
  return NOTICES.has(code.toUpperCase());
}

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function dpdPtStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = dpdPtMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (isDpdPtNotice(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * What the map says about one scan. A collection and a proof of delivery take
 * their stage from the scans before them, so the map does not know it from
 * their code; notices are left without a stage on purpose.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code) => code && code !== DPD_PT_COLLECTION && code !== DPD_PT_DELIVERY ? dpdPtMappedStage(code) : undefined,
  gaps: [...NOTICES].map(([code, note]) => ({ code, note })),
};
