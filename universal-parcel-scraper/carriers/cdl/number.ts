import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

// A CDL label number: CDL and eleven digits.
const LABEL = /^CDL\d{11}$/;
// A CDL order number, nine digits, a hyphen and a digit, once normalization has dropped the hyphen.
const ORDER = /^(\d{9})(\d)$/;

/**
 * A number as CDL's tracking service and page match it: a CDL label number,
 * or an order number with the hyphen before its last digit put back. The
 * service matches an order number only with its hyphen. Shared by the
 * adapter's requests and the tracking links.
 */
export function cdlRequestNumber(raw: string): string {
  if (raw.length > 64) throw new InvalidInputError('CDL Last Mile', 'CDL tracking number is too long');
  const number = normalizeTrackingNumber(raw);
  if (LABEL.test(number)) return number;
  const order = ORDER.exec(number);
  if (order) return `${order[1]}-${order[2]}`;
  throw new InvalidInputError('CDL Last Mile', 'CDL tracks CDL label numbers and nine-digit order numbers with a hyphen and a digit');
}
