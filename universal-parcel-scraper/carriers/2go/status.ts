import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scans carry no code, only a sentence. Those seen in replies
 * are mapped; an arrival names its hub. The earlier tracker's bookings, which
 * the shared rules do not read, are mapped too. Other wording falls to the
 * shared rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Order is placed', 'registered'], // The shipper booked the parcel; 2GO does not have it yet.
  ['Parcel is out for delivery', 'out_for_delivery'],
  ['Parcel has been delivered', 'delivered'],
  ['Booking Created', 'registered'],
  ['Booking Received', 'registered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const ARRIVAL = /^parcel has arrived at \S/;

/** The stage the map gives a scan's wording. */
export function twoGoMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDINGS.get(key) ?? (ARRIVAL.test(key) ? 'in_transit' : undefined);
}

/** A scan's stage: its wording in the map, else the shared wording rules, else nothing. */
export function twoGoStage(wording: string): ClassifiedWording | null {
  const mapped = twoGoMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => twoGoMappedStage(wording),
  gaps: [],
};
