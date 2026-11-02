import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

// Twelve letters and digits, at least one of them a letter.
const NUMBER = /^(?=\d*[A-Z])[A-Z0-9]{12}$/;

/**
 * A GoGo Xpress number as its tracker asks for it: in capitals, in three
 * groups of four joined by hyphens. The tracker finds nothing without them.
 * Shared by the adapter's requests and the tracking links.
 */
export function normalizeGogoXpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError('GoGo Xpress', 'GoGo Xpress numbers are twelve letters and digits');
  return `${number.slice(0, 4)}-${number.slice(4, 8)}-${number.slice(8)}`;
}
