import { postlogisticsIdentifier } from '../../carriers/postlogistics/number.js';
import { noLimitShipmentNumber } from './noLimit.js';
import { hasS10CheckDigit } from './s10CheckDigit.js';

/**
 * Tracking-number normalization and display formatting.
 *
 * What it is: the one place that decides what "the same number" means, plus
 * the printed grouping carriers use on their labels.
 * What it is not: no carrier lookup and no provider I/O. The only check digit
 * it reads is an S10 serial's, to tell a typed letter O from a zero.
 */

/**
 * Uppercase and strip spaces, dots and dashes (Swiss Post prints 99.34.…).
 * A label prints its SSCC behind the bracketed GS1 identifier, "(00) 3 7012345
 * 678901234 7", and carriers track it as the twenty digits without brackets.
 * A label can also print a number's last digit in brackets, as PIN AG's FAQ
 * shows its registered letters, "000000000000(0)": the number reads without them.
 * Other bracketed identifiers stay as typed: (420), for one, carries a ZIP.
 * An S10 serial holds only digits, so a letter O in it ("CIO…NL") is a zero
 * typed as a letter when the check digit then holds. No carrier issues "JDO1"
 * and sixteen digits either: it is a DHL Express piece, JD01, with its zero
 * typed as a letter. A NO LIMIT shipment number, P/1234/LABC/2026, reads the
 * same without its slashes, which are dropped.
 */
export function normalizeTrackingNumber(raw: string): string {
  const value = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (/^\(00\)\d{18}$/.test(value)) return `00${value.slice(4)}`;
  const lastDigit = /^(\d{12,})\((\d)\)$/.exec(value);
  if (lastDigit) return `${lastDigit[1]}${lastDigit[2]}`;
  const shipment = value.includes('/') ? noLimitShipmentNumber(value) : undefined;
  if (shipment) return shipment;
  const piece = /^(J?JD)O(1\d{16}J?)$/.exec(value);
  if (piece) return `${piece[1]}0${piece[2]}`;
  const serial = /^([A-Z]{2})([\dO]{9})([A-Z]{2})$/.exec(value);
  if (!serial?.[2]!.includes('O')) return value;
  const digits = serial[2]!.replace(/O/g, '0');
  return hasS10CheckDigit(digits) ? `${serial[1]}${digits}${serial[3]}` : value;
}

/** Capability-link shipment numbers look like 999.90.########. */
export function isPlanzerSharedTrackingNumber(raw: string): boolean {
  return /^99990\d{8}$/.test(normalizeTrackingNumber(raw));
}

/** Swiss carriers show 18-digit barcodes as 99.34.123456.12345678. */
export function formatTrackingNumber(raw: string, carrier?: string): string {
  if (carrier === 'postlogistics') return postlogisticsIdentifier(raw);
  const value = normalizeTrackingNumber(raw);
  if (isPlanzerSharedTrackingNumber(value)) {
    return `${value.slice(0, 3)}.${value.slice(3, 5)}.${value.slice(5)}`;
  }
  if (/^\d{18}$/.test(value)) {
    return `${value.slice(0, 2)}.${value.slice(2, 4)}.${value.slice(4, 10)}.${value.slice(10)}`;
  }
  return value;
}
