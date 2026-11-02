import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

/** The forwarding references confirmed by PFL Australia's parcel tracker. */
export function pflogisticsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^NEXAU\d{10}YQ$/.test(number)) {
    throw new InvalidInputError('Parcel Freight Logistics', 'PFL tracking requires a supported parcel reference');
  }
  return number;
}
