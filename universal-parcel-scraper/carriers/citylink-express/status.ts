import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * City-Link's scan codes, `CP_Code`. Only codes seen in replies are mapped.
 * `SP` covers several problems told apart by the scan's disposal code, so it
 * is mapped with that code only.
 */
const FAMILIES: ReadonlyMap<string, Stage> = new Map([
  ['SR', 'registered'], // The shipper's record: "Shipment information sent to City-Link".
  ['PK', 'in_transit'], // Arrived at a City-Link facility, at origin and at later hubs.
  ['OB', 'in_transit'], // Departed the origin facility.
  ['CR', 'in_transit'], // At a City-Link facility, such as the hub at the airport.
  ['HD', 'in_transit'], // Departed a facility.
  ['RV', 'in_transit'], // At the facility that delivers.
  ['OD', 'out_for_delivery'], // With the delivery courier.
  ['DL', 'delivered'],
]);

/** Codes with their disposal code. */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['SP:60', 'failed_attempt'], // The courier could not reach the receiver on the primary number.
]);

/** Wordings the older tracker showed without a code, in `normalizeStatusWording` form. */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^shipment collected$/, 'accepted'],
  // "Shipment Bound for RAWANG, MALAYSIA", "Depart to SHAH ALAM, MALAYSIA".
  [/^(?:shipment bound for|depart(?:ed)? to)\b/, 'in_transit'],
  // Received at a hub, named in the location.
  [/^received by$/, 'in_transit'],
  [/^unable to (?:access|contact receiver)\b/, 'failed_attempt'],
];

/** The stage City-Link's own vocabulary gives a scan: its code, else its wording. */
export function citylinkMappedStage(code: string | null, wording: string): Stage | undefined {
  const upper = code?.toUpperCase() ?? '';
  const family = upper.split(':')[0]!;
  const mapped = CODES.get(upper) ?? (family === 'SP' ? undefined : FAMILIES.get(family));
  if (mapped) return mapped;
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** A scan's stage: its code or wording, else the shared wording rules, else nothing. */
export function citylinkStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = citylinkMappedStage(code || null, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => citylinkMappedStage(code, wording),
  gaps: [],
};
