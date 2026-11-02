import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

// Six letters, then four or five digits and seven more: the layout `upaya-1` claims, without its hyphen.
export const UPAYA_LAYOUT = /^[A-Z]{6}\d{11,12}$/;

/**
 * An Upaya tracking code as its tracker asks for it: in capitals, with the
 * hyphen before the last seven digits. The tracker finds nothing without it.
 */
export function normalizeUpayaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!UPAYA_LAYOUT.test(number)) {
    throw new InvalidInputError('Upaya', 'Upaya tracking codes are six letters, four or five digits, a hyphen and seven digits');
  }
  return `${number.slice(0, -7)}-${number.slice(-7)}`;
}
