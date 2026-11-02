import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

// A plain eight-digit consignment, or a four-letter sender prefix and its range.
const CONSIGNMENT = /^(?:\d{8}|[A-Z]{4}\d{5,8})$/;
// A unit's label: the prefix, `BX`, the range zero-padded to eleven digits and a three-digit unit number.
export const BORDER_EXPRESS_BARCODE = /^([A-Z]{4})BX(\d{11})\d{3}$/;

/** The consignment to ask for, and the unit barcode it was read from, if any. */
export interface BorderExpressNumber {
  consignment: string;
  barcode?: string;
}

/**
 * The consignment a unit's barcode is read back into by the label
 * specification's formula: the range is the barcode's digits without its
 * padding, and six digits long when shorter, as ranges are documented. Null
 * for anything else, or a range too long to read.
 */
export function borderExpressBarcodeConsignment(number: string): string | null {
  const label = BORDER_EXPRESS_BARCODE.exec(number);
  const consignment = label ? `${label[1]}${label[2]!.replace(/^0+/, '').padStart(6, '0')}` : '';
  return CONSIGNMENT.test(consignment) ? consignment : null;
}

/**
 * A number for Border Express's tracker; anything else is not one it issues.
 * The tracker does not take a unit's barcode, so the barcode is read back into
 * its consignment. Shared by the adapter's requests and the tracking links.
 */
export function borderExpressNumber(raw: string): BorderExpressNumber {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONSIGNMENT.test(number)) return { consignment: number };
  const consignment = borderExpressBarcodeConsignment(number);
  if (!consignment) {
    throw new InvalidInputError('Border Express', 'Border Express numbers are eight digits, a sender prefix and its range, or a unit barcode');
  }
  return { consignment, barcode: number };
}
