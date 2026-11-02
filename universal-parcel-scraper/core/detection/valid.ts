/**
 * What may be a tracking number.
 *
 * What it is: the shape gate the facade, the HTTP server and the input parser
 * apply before a carrier is asked.
 * What it is not: no proof that a parcel exists, no carrier decision and no
 * provider I/O.
 */
import { detectCarrierMatch } from './detect.js';
import { normalizeTrackingNumber } from './normalize.js';

function hasTrackingShape(normalized: string): boolean {
  return normalized.length >= 4
    && normalized.length <= 40
    // Letters and digits, with one underscore inside as Better Trucks writes
    // its BTS_ numbers. The NACEX agency/shipment composite is the only other
    // shape allowed to keep punctuation.
    && (/^[A-Z0-9]+(?:_[A-Z0-9]+)?$/.test(normalized) || /^\d{4}\/\d{8}$/.test(normalized));
}

/**
 * Shape gate for a number entered whole or carried by a carrier's link. A number
 * normally holds a digit. Without one it must be six to ten unbroken letters
 * that a carrier's detection rule claims, as GLS issues six-letter Track IDs:
 * a word no carrier uses is not a number, and neither is a short phrase.
 */
export function validTrackingNumber(raw: string): boolean {
  const normalized = normalizeTrackingNumber(raw);
  if (!hasTrackingShape(normalized)) return false;
  return /\d/.test(normalized)
    || (/^[A-Za-z]{6,10}$/.test(raw.trim()) && detectCarrierMatch(normalized).confidence !== 'none');
}

/** The stricter gate for a number pulled out of pasted prose, where a word is not a number. */
export function validTrackingNumberInText(raw: string): boolean {
  const normalized = normalizeTrackingNumber(raw);
  return hasTrackingShape(normalized) && /\d/.test(normalized);
}
