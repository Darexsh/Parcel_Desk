import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

// The layouts Flip Post prints: three or four digits and four, two digits and seven, and two
// digits and two groups of three.
const DASHED = /^(?:\d{3,4}-\d{4}|\d{2}-\d{7}|\d{2}-\d{3}-\d{3})$/;
/** Seven or nine digits, which only one layout fits. */
export const FLIPPOST_ONE_LAYOUT = /^(?:\d{7}|\d{9})$/;

/**
 * The waybill as Flip Post's tracking API asks for it, with its dashes: the bare digits find
 * nothing. Seven digits are three and four, nine are two and seven, and eight are four and
 * four or two and three and three, so eight digits give both readings. A number that keeps
 * the dashes of one of those layouts is asked as it is.
 */
export function flippostWaybills(raw: string): string[] {
  const typed = typeof raw === 'string' && raw.length <= 64 ? raw.trim() : '';
  if (DASHED.test(typed)) return [typed];
  const digits = normalizeTrackingNumber(typed);
  if (/^\d{7}$/.test(digits)) return [`${digits.slice(0, 3)}-${digits.slice(3)}`];
  if (/^\d{9}$/.test(digits)) return [`${digits.slice(0, 2)}-${digits.slice(2)}`];
  if (/^\d{8}$/.test(digits)) return [`${digits.slice(0, 4)}-${digits.slice(4)}`, `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`];
  throw new InvalidInputError('Flip Post', 'Flip Post waybills are seven to nine digits in dashed groups');
}
