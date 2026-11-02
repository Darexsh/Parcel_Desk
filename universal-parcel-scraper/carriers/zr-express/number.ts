import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

/**
 * Two digits, six, seven or ten letters and digits, and ZR, as the tracker
 * checks the three blocks; the middle block's length is the compact length's.
 */
export const ZR_EXPRESS_LAYOUT = /^(\d{2})([A-Z0-9]{6}|[A-Z0-9]{7}|[A-Z0-9]{10})ZR$/;

/**
 * The number as the tracker needs it: in capitals, with a dash between its
 * blocks. Any other input is not a number ZR Express issues. Shared by the
 * adapter's requests and the tracking links.
 */
export function zrExpressRequestNumber(raw: string): string {
  const parts = ZR_EXPRESS_LAYOUT.exec(typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '');
  if (!parts) throw new InvalidInputError('ZR Express', 'ZR Express numbers are two digits, six, seven or ten letters and digits, and ZR');
  return `${parts[1]}-${parts[2]}-ZR`;
}
