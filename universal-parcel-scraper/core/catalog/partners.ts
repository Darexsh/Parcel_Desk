import { detectCarrierMatch } from '../detection/index.js';

/**
 * Carriers that follow some parcels under the number of the carrier that
 * delivers them.
 *
 * Cainiao shows AliExpress buyers the delivery carrier's own number on some
 * lanes, from the day the parcel ships. Both carriers then know one number, at
 * different stages of the same journey.
 */
const PARTNER_NUMBER_ORIGINS: ReadonlySet<string> = new Set(['aliexpress']);

export function followsPartnerNumbers(carrier: string): boolean {
  return PARTNER_NUMBER_ORIGINS.has(carrier);
}

/**
 * Carriers whose tracker also finds a parcel by the number its delivery
 * partner gave it. Evri International answers Paack's, Hermes Germany's or
 * DHL's number with its own history of the parcel. That number is still the
 * partner's, unlike an origin's above.
 */
const PARTNER_NUMBER_TRACKERS: ReadonlySet<string> = new Set(['evri']);

/** Whether the carrier's tracker also finds parcels by their delivery partner's number. */
export function tracksPartnerNumbers(carrier: string): boolean {
  return PARTNER_NUMBER_TRACKERS.has(carrier);
}

/**
 * The partner that owns a number reported under one of those trackers: the
 * carrier another catalog rule claims the number for at high confidence.
 */
export function partnerNumberOwner(carrier: string, number: string): string | undefined {
  if (!PARTNER_NUMBER_TRACKERS.has(carrier)) return undefined;
  const detected = detectCarrierMatch(number);
  return detected.confidence === 'high' && detected.carrier !== carrier ? detected.carrier : undefined;
}
