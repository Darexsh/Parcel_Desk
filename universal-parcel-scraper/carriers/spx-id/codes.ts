import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap, IntentionalStatusGap } from '../../core/status/statusMap.js';

/**
 * SPX's tracking codes, as the order lookup of its trackers in Indonesia,
 * Malaysia, Singapore, Thailand and Vietnam gives them. Only codes seen in those replies
 * are mapped, and a network changes the few it reads differently. A failed
 * pickup leaves the parcel with its seller, export and import clearance are
 * transit milestones, assigning a driver is not yet a delivery round, and every
 * leg of a return is returned.
 */
export const SPX_CODES: ReadonlyMap<string, Stage> = new Map([
  ['A000', 'registered'], // Shopee created the tracking number.
  ['F000', 'registered'], // The seller is preparing the parcel.
  ['F001', 'registered'], // A pickup at the seller that collected nothing.
  ['F004', 'registered'], // A driver is assigned to the pickup.
  ['F096', 'accepted'], // Dropped off by a seller abroad.
  ['F098', 'accepted'], // Dropped off at a drop-off point.
  ['F100', 'accepted'], // Collected from the seller.
  ['F110', 'in_transit'], ['F199', 'in_transit'], // On the way to SPX's warehouse abroad.
  ['F200', 'in_transit'], ['F206', 'in_transit'], ['F210', 'in_transit'], ['F219', 'in_transit'], ['F230', 'in_transit'], ['F239', 'in_transit'],
  ['F299', 'in_transit'], // Warehouse abroad.
  ['F300', 'in_transit'], // With the forwarder.
  ['F339', 'in_transit'], ['F341', 'in_transit'], ['F360', 'in_transit'], ['F399', 'in_transit'], // Clearance, departure and arrival.
  ['F419', 'in_transit'], ['F420', 'in_transit'], // Handed to the domestic network.
  ['F430', 'in_transit'], ['F440', 'in_transit'], ['F441', 'in_transit'], ['F445', 'in_transit'], ['F450', 'in_transit'], // First-mile hub.
  ['F510', 'in_transit'], ['F515', 'in_transit'], ['F540', 'in_transit'], ['F541', 'in_transit'], // Sorting centre.
  ['F550', 'in_transit'], ['F580', 'in_transit'], // Line haul.
  ['F596', 'in_transit'], ['F598', 'in_transit'], ['F599', 'in_transit'], // Delivery hub.
  ['F600', 'out_for_delivery'],
  ['F606', 'out_for_delivery'], // On the way to a self-collection point.
  ['F650', 'failed_attempt'],
  ['F671', 'returned'], ['F672', 'returned'], ['F673', 'returned'], ['F674', 'returned'], ['F677', 'returned'], ['F680', 'returned'], // On the way back.
  ['F699', 'exception'], // The return to the seller has stalled.
  ['F980', 'delivered'],
  ['F999', 'returned'], // Back with the seller.
]);

/**
 * The rows SPX flags hidden that its trackers still read; every network's page leaves out all
 * of them. Most are SPX's bookkeeping: the number's creation, a driver assigned, packing,
 * relabelling, loading a truck minutes before the departure the page shows. These are
 * milestones no shown row stands for: a pickup that collected nothing, import clearance, the
 * arrival at the last-mile hub, and the way back of a return, which a page shows only once the
 * seller is about to get the parcel.
 */
export const SPX_HIDDEN_MILESTONES: ReadonlySet<string> = new Set(['F001', 'F370', 'F599', 'F671', 'F677']);

/** Whether a row the page leaves out is one of SPX's milestones. */
export function isSpxHiddenMilestone(row: Record<string, unknown>): boolean {
  return typeof row.tracking_code === 'string' && SPX_HIDDEN_MILESTONES.has(row.tracking_code.trim().toUpperCase());
}

/** A network's status map, and the stage it gives one scan of its replies. */
export interface SpxStatusMap extends CarrierStatusMap {
  /** The stage the map gives a code. */
  readonly mapped: (code: string) => Stage | undefined;
  /** A scan's stage: its code, else the shared wording rules unless the code is a gap, else nothing. */
  readonly classify: (code: string, wording: string) => ClassifiedWording | null;
}

/** A status map that reads codes, with the codes it leaves without a stage on purpose. */
export function spxStatusMap(codes: ReadonlyMap<string, Stage>, gaps: readonly (IntentionalStatusGap & { code: string })[] = []): SpxStatusMap {
  const unstaged = new Set(gaps.map((gap) => gap.code));
  const mapped = (code: string) => codes.get(code);
  return {
    stage: (code) => (code ? mapped(code) : undefined),
    gaps,
    mapped,
    classify: (code, wording) => {
      const stage = mapped(code);
      if (stage) return { stage, source: 'carrier_map' };
      if (unstaged.has(code)) return null;
      const worded = classifyWording(wording, 'in_transit');
      return worded.source === 'none' ? null : worded;
    },
  };
}
