import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

/**
 * The tracker's own status column, in Korean whatever language the page is
 * in, which the adapter keeps as the provider code. Another code falls to the
 * English wording, then to the shared rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['등록', 'registered'], // The sender registered the parcel; Exmate does not have it yet.
  ['입고완료', 'accepted'], // Exmate's warehouse in Korea received the parcel.
  ['출고완료', 'in_transit'], // The parcel left the warehouse for the airport.
  ['출발', 'in_transit'], // The flight left Korea.
  ['현지도착', 'in_transit'], // The parcel arrived in the destination country.
  ['통관심사중', 'customs'], // Customs in the destination country is reviewing the parcel.
  ['통관완료', 'in_transit'], // Customs cleared the parcel, which moves on.
  ['배송사접수', 'in_transit'], // The local carrier took the parcel over.
  ['배송중', 'in_transit'], // The local carrier has the parcel.
  ['배달중', 'out_for_delivery'],
  ['부재중', 'failed_attempt'], // The recipient was not in.
  ['배송완료', 'delivered'],
  ['배달완료', 'delivered'],
]);

/** The English line the page shows beside Exmate's own statuses. */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(([
  ['Registered', 'registered'],
  ['DPC In-housing', 'accepted'],
  ['Shipped Out', 'in_transit'],
  ['Departed', 'in_transit'],
  ['Arrived at Destination Country', 'in_transit'],
  ['Customs Cleared', 'in_transit'],
  ['Received by Carrier', 'in_transit'],
  ['Delivered', 'delivered'],
] as const).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a status code, else its wording. */
export function exmateMappedStage(code: string | null, wording: string): Stage | undefined {
  return (code ? CODES.get(code.trim()) : undefined) ?? WORDINGS.get(normalizeStatusWording(wording));
}

/** A scan's stage: its code or wording in the map, else the shared wording rules, else nothing. */
export function exmateStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = exmateMappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => exmateMappedStage(code, wording),
  gaps: [],
};
