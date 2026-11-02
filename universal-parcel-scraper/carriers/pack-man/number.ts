import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

// A letter and eight digits once the hyphen is dropped, as normalized numbers are.
const VOUCHER = /^([A-Z])(\d{8})$/;

/**
 * A Pack-Man voucher as its search page finds it: a letter, a hyphen and eight
 * digits. The hyphen may be left out, as normalized numbers drop it; the page
 * answers a voucher without it as unknown. Anything else is not one it issues.
 * Shared by the adapter's requests and the tracking links.
 */
export function normalizePackManNumber(raw: string): string {
  const match = VOUCHER.exec(raw.length <= 64 ? normalizeTrackingNumber(raw) : '');
  if (!match) throw new InvalidInputError('Pack-Man', 'Pack-Man vouchers are a letter, a hyphen and eight digits');
  return `${match[1]}-${match[2]}`;
}
