import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError } from '../../core/errors/index.js';

// A national waybill: the branch's two letters and eight digits. A label prints a single check
// digit after a dash, which tnt.it's tracking guide says to leave out; normalization has dropped the dash.
const WAYBILL = /^([A-Z]{2}\d{8})\d?$/;

/**
 * A national waybill as tnt.it's tracker finds it, without the check digit
 * its label prints. Shared by the adapter's requests and the tracking links.
 */
export function normalizeTntItalyNumber(raw: string): string {
  const waybill = raw.length <= 64 ? WAYBILL.exec(normalizeTrackingNumber(raw))?.[1] : undefined;
  if (!waybill) throw new InvalidInputError('TNT Italy', 'TNT Italy national waybills are two letters and eight digits');
  return waybill;
}
