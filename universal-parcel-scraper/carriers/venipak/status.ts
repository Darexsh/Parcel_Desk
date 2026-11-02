import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scan wordings, the part of a scan's text before its place.
 * The page also marks each scan with a number that picks its icon, but that
 * number groups statuses: 2 is both a parcel still at the sender and one out
 * for delivery. The Lithuanian site's English pages word some statuses
 * differently from the Latvian and Estonian ones; both are mapped.
 */
export const VENIPAK_SCANS: Readonly<Record<string, Stage>> = {
  // The sender registered the parcel and still has it.
  'At sender': 'registered',
  // The sender dropped the parcel in a Venipak locker.
  'Is placed for dispatch': 'accepted',
  // A courier collected the parcel from the sender, or from the locker it was dropped in.
  'Picked up': 'accepted',
  'Picked up from sender': 'accepted',
  'At terminal': 'in_transit',
  // On its way to the recipient's door, or to the locker or pickup point they chose.
  'Out for delivery': 'out_for_delivery',
  'The parcel is out for delivery': 'out_for_delivery',
  // In the locker or at the pickup point, waiting for the recipient.
  'Delivered to pickup point': 'ready_for_pickup',
  'Delivered': 'delivered',
};

const SCANS = new Map(Object.entries(VENIPAK_SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage a scan's wording gives it, if any. */
export function venipakScanStage(wording: string): Stage | undefined {
  return SCANS.get(normalizeStatusWording(wording));
}

/** The tracker's scans carry a wording and no status code the adapter keeps. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : SCANS.get(wording),
  gaps: [],
};
