import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { countryCode, countryTimeZone } from '../../core/time/index.js';

/** Correos's own clock: mainland Spain's. */
export const CORREOS_HOME_ZONE = 'Europe/Madrid';

/**
 * On an item from abroad, Correos lists the origin post's scans at its outward
 * office of exchange (B030000V) and in its customs (B170000V) at that post's
 * wall clock: India Post's own scans have the same minutes on Kolkata time,
 * and Japan Post's on Tokyo time. Correos's own scans, from C010000V on, are
 * on Madrid's clock.
 */
const ORIGIN_CODE = /^B\d/;

/**
 * Correos's summaries of those scans, for relays that give no code: alone, or
 * as one part of 17TRACK's "PHASE, summary, details".
 */
const ORIGIN_WORDING = /(?:^|,)\s*(?:en oficina de cambio|en aduana de origen|in the exchange office)\s*(?:,|$)/i;

/**
 * The country of the post that sent an item from abroad, which its S10 code's
 * suffix names; null for Spain's own items and other codes.
 */
function foreignOrigin(number: string): string | null {
  const country = isValidS10TrackingNumber(number) ? countryCode(number.slice(-2)) : null;
  return country && country !== 'ES' ? country : null;
}

/**
 * The clock of a Correos scan of `number`, known by its code or, from a relay,
 * by its wording, when it is the origin post's on an item from abroad: the
 * zone of the country the S10 code's suffix names, or null when that country
 * keeps several clocks and the scan keeps its wall clock. Undefined for any
 * other scan, which is on Madrid's clock.
 */
export function correosOriginZone(number: string, scan: { code: string } | { wording: string }): string | null | undefined {
  const origin = 'code' in scan ? ORIGIN_CODE.test(scan.code) : ORIGIN_WORDING.test(scan.wording);
  const country = origin ? foreignOrigin(number) : null;
  return country ? countryTimeZone(country) : undefined;
}

/**
 * A unit code (`codired`) opens with its province's two digits, as the office
 * locator lists them: 35 (Las Palmas) and 38 (Santa Cruz de Tenerife) are the
 * Canary Islands, an hour behind Madrid.
 */
const CANARY_UNIT = /^3[58]\d{5}$/;

/**
 * The delivery unit's scans: its registration of the parcel (G), the rounds,
 * attempts and holds (H, not the collection from a sender's address,
 * HI10002V), the end of a hold (L0), its hold for a return (O13) and the
 * delivery.
 */
const DELIVERY_UNIT_CODE = /^(?:[GH]\d|L0|O13|I01H210V$|I010000V$)/;

/** Handed back to the sender, whose unit the envelope may name from then on. */
const BACK_TO_SENDER = new Set(['I020000V', 'I01H230V']);

/**
 * The clock of the delivery unit's scans when the unit holding the parcel is
 * on the Canary Islands, which stamp their own wall clock; undefined for any
 * other unit or scan, on Madrid's clock.
 */
export function correosUnitZone(unit: string, codes: readonly string[]): (code: string) => string | undefined {
  const canary = CANARY_UNIT.test(unit) && !codes.some((code) => BACK_TO_SENDER.has(code));
  return (code) => canary && DELIVERY_UNIT_CODE.test(code) ? 'Atlantic/Canary' : undefined;
}
