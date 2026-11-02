import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

// The category the tracker puts before each status, as "Shipment - Delivered".
const CATEGORY = /^shipment\s*-\s*/i;
// A reason the former tracker gave in brackets after the status.
const BRACKETED = /\s*\[[^\]]*\]\s*$/;

/**
 * The tracker's statuses without their category, and the former trax.pk
 * tracker's, whose reasons came in brackets. Returns to the shipper are an
 * exception until the parcel is back.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Booked', 'registered'],
  // A rider collected the parcel from the shipper.
  ['Rider Picked', 'accepted'],
  // Taken in at the origin office, which a parcel dropped there starts with.
  ['Arrived at Origin', 'accepted'],
  ['In Transit', 'in_transit'],
  ['Arrived at Destination', 'in_transit'],
  ['Out for Delivery', 'out_for_delivery'],
  ['Delivery Unsuccessful', 'failed_attempt'],
  ['Delivered', 'delivered'],
  ['Parcel Booked', 'registered'],
  ['Parcel Recieved Office', 'accepted'],
  ['Parcel In Transit', 'in_transit'],
  ['Shipment Reached At Destination', 'in_transit'],
  ['Attempt Not Successful', 'failed_attempt'],
  ['Return Marked', 'exception'],
  ['Return Confirm', 'exception'],
  ['Return In Transit', 'exception'],
  ['Return Shipment Reached At Destination', 'exception'],
  ['Return Out for Delivery', 'exception'],
  ['Returned', 'returned'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** A status without the tracker's category or a bracketed reason. */
export function slgtraxStatusKey(status: string): string {
  return status.trim().replace(CATEGORY, '').replace(BRACKETED, '');
}

/** The stage the map gives a status, read case-insensitively. */
export function slgtraxMappedStage(status: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(slgtraxStatusKey(status)));
}

// Billing lines of the former tracker, which move no parcel.
const BILLING = new Set(['payment done', 'charges deducted']);

/** A scan's stage: the map's, else the shared wording rules', else nothing. */
export function slgtraxStage(status: string): ClassifiedWording | null {
  const mapped = slgtraxMappedStage(status);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (BILLING.has(normalizeStatusWording(slgtraxStatusKey(status)))) return null;
  const worded = classifyWording(status, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  codeKey: slgtraxStatusKey,
  stage: (code, wording) => (code ? slgtraxMappedStage(code) : undefined) ?? slgtraxMappedStage(wording),
  gaps: [
    { code: 'Payment Done', note: 'The cash on delivery paid out to the shipper, a billing line that moves no parcel.' },
    { code: 'Charges Deducted', note: 'Return charges billed to the shipper, a billing line that moves no parcel.' },
    { wording: 'payment done', note: 'The cash on delivery paid out to the shipper, a billing line that moves no parcel.' },
    { wording: 'charges deducted', note: 'Return charges billed to the shipper, a billing line that moves no parcel.' },
  ],
};
