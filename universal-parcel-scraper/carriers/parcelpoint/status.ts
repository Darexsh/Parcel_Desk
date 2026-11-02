import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * ParcelPoint's event codes, as its tracker's reply names them. A code covers what happens to
 * a parcel at a point, so where the parcel goes next depends on the wording beside it: a point
 * hands a parcel to its recipient or to the carrier collecting a return. A code is mapped only
 * with the wording seen beside it; other wording falls to the shared wording rules.
 */
const CODES: readonly { code: string; wording?: RegExp; stage: Stage }[] = [
  // "Parcel information has been received by PARCELPOINT.": the carrier or retailer booked the
  // parcel to a point, before it arrives there.
  { code: 'BOOKED', stage: 'registered' },
  // "{point} has confirmed delivery of your parcel from {carrier}, it's ready for collection."
  // The shared rules would read the delivery to the point as the recipient's.
  { code: 'CHECKED_IN', wording: /\bready for collection\b/i, stage: 'ready_for_pickup' },
  // "Your parcel has been collected from the PARCELPOINT location.": the recipient took it.
  { code: 'CHECKED_OUT', wording: /\bcollected from the parcelpoint location\b/i, stage: 'delivered' },
];

/** The stage ParcelPoint's map gives an event code with its wording. */
export function parcelpointMappedStage(code: string, wording: string): Stage | undefined {
  const key = code.trim().toUpperCase();
  return CODES.find((entry) => entry.code === key && (!entry.wording || entry.wording.test(wording)))?.stage;
}

/** An event's stage: the map's, else the shared wording rules', else nothing. */
export function parcelpointStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = parcelpointMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? parcelpointMappedStage(code, wording) : undefined),
  gaps: [],
};
