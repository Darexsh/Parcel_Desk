import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * KEX Express' scan codes (`s_code`). Only codes seen in replies are mapped;
 * another code falls to the wording rules.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['005', 'accepted'], // Dropped at a KEX service point by the sender.
  ['010', 'accepted'], // Picked up from the sender by a courier.
  ['105', 'in_transit'], // Arrived at the origin station.
  ['106', 'in_transit'], // Departed from the origin station.
  ['109', 'in_transit'], // Arrived at a distribution centre.
  ['110', 'in_transit'], // Departed from a distribution centre.
  ['103', 'in_transit'], // Arrived at the destination station.
  ['045', 'out_for_delivery'],
  ['POD', 'delivered'],
]);

/**
 * The part of a code the map reads. The page groups numbered codes by their
 * first three digits, as `105.1` with `105` and `060.01M` with `060`.
 */
export function kexCodeKey(code: string): string {
  const upper = code.trim().toUpperCase();
  return /^\d{3}\./.test(upper) ? upper.slice(0, 3) : upper;
}

/** The stage KEX Express' codes give a scan code. */
export function kexMappedStage(code: string): Stage | undefined {
  return CODES.get(kexCodeKey(code));
}

// The courier's call to the recipient moves nothing; the placeholder a
// platform's number gets before the parcel reaches KEX is no scan.
const NOTICE = /^(?:CAL|WKD)$/;

/** A scan's stage: its code, else the shared wording rules, else nothing. */
export function kexStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = kexMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (NOTICE.test(kexCodeKey(code))) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  codeKey: kexCodeKey,
  stage: (code) => (code ? kexMappedStage(code) : undefined),
  gaps: [
    { code: 'CAL', note: 'The courier called the recipient during the delivery round; the parcel does not move.' },
    { code: 'WKD', note: 'The placeholder a selling platform\'s number gets before the parcel reaches KEX Express, stamped with the time of the lookup; the adapter drops it.' },
  ],
};
