/**
 * How far along the way to the recipient a stage places a parcel, for a carrier whose summary
 * label groups several scans. Customs and the delivery round both come after transit and are
 * not ordered against each other; stages off the way (exceptions, returns, pickup, delivery)
 * have no place here.
 */
import type { Stage } from '../../generated/catalog.js';

const PROGRESS = new Map<string, number>([
  ['registered', 0], ['accepted', 1], ['in_transit', 2], ['customs', 3], ['out_for_delivery', 3],
]);

/** Whether a scan's stage places the parcel further along than a summary's. */
export function furtherAlong(summary: string | undefined, scan: string | undefined): scan is Stage {
  const [from, to] = [PROGRESS.get(summary ?? ''), PROGRESS.get(scan ?? '')];
  return from !== undefined && to !== undefined && to > from;
}
