import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

/** Three letters, three letters or digits and eight digits, without the hyphens between them. */
export const NOEST_LAYOUT = /^([A-Z]{3})([A-Z0-9]{3})(\d{8})$/;

/**
 * The number as NOEST's tracker needs it: in capitals, with a hyphen between
 * its three blocks. Any other input is not a number NOEST issues. Shared by
 * the adapter's requests and the tracking links.
 */
export function noestRequestNumber(raw: string): string {
  const parts = NOEST_LAYOUT.exec(typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '');
  if (!parts) throw new InvalidInputError('NOEST Express', 'NOEST numbers are three letters, three letters or digits and eight digits');
  return `${parts[1]}-${parts[2]}-${parts[3]}`;
}
