import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

/**
 * A Paperfly order number without its hyphens: the booking day, month and
 * two-digit year, a serial of four to six digits and two letter-digit pairs.
 * Some, as in Paperfly's webhook examples, start with `Z`.
 */
const ORDER = /^(Z?)((?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])\d{2})(\d{4,6})([A-Z]\d)([A-Z]\d)$/;
/** The reference Daraz gives a parcel it hands to Paperfly, without its hyphens: PFL, BD, two letters and ten digits. */
const DARAZ = /^PFLBD([A-Z]{2})(\d{10})$/;

/** An order number or a Daraz reference, without the hyphens Paperfly writes in them. */
export const PAPERFLY_LAYOUT = /^(?:Z?(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])\d{6,8}[A-Z]\d[A-Z]\d|PFLBD[A-Z]{2}\d{10})$/;

/**
 * The number as Paperfly's tracker finds it: in capitals, with the hyphens
 * Paperfly writes between its parts, which the tracker needs. Any other input
 * is not a number Paperfly issues. Shared by the adapter's requests and the
 * tracking links.
 */
export function paperflyRequestNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  const order = ORDER.exec(number);
  if (order) return [order[1] ? 'Z' : '', order[2], order[3], order[4], order[5]].filter(Boolean).join('-');
  const daraz = DARAZ.exec(number);
  if (daraz) return `PFL-BD-${daraz[1]}-${daraz[2]}`;
  throw new InvalidInputError('Paperfly', 'Paperfly numbers are a booking date, a serial and two letter-digit pairs, or a Daraz PFL-BD reference');
}
