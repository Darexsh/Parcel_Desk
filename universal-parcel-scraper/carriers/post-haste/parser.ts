import type { CarrierResult } from '../../core/result/index.js';
import { freightwaysQuery, parseFreightways, type FreightwaysNetwork, type FreightwaysQuery } from '../nz-couriers/freightways.js';

export const PROVIDER = 'Post Haste';
// A courier ticket or Express Pack: a product code of two to four letters,
// then the eight-digit ticket number, which may come without its leading
// zeros. The tracker takes them as two fields; the number reaches the adapter
// without a space.
const TICKET = /^([A-Z]{2,4})(\d{5,8})$/;
// Charge labels have eight digits.
const LABEL = /^\d{8}$/;

/** Post Haste on the Freightways group's tracking lookup. */
export const POST_HASTE: FreightwaysNetwork = {
  carrier: 'post-haste', provider: PROVIDER, path: 'PostHaste', ticket: TICKET, label: LABEL,
  numbers: 'a ticket, an eight-digit charge label, an SSCC or a customer printed label',
};

/** A ticket, charge label, SSCC or customer printed label as the lookup takes it. Anything else is invalid input. */
export function postHasteQuery(raw: string): FreightwaysQuery {
  return freightwaysQuery(POST_HASTE, raw);
}

/**
 * The lookup's reply for one number, read as New Zealand Couriers' is: the
 * consignment must name the whole number asked, its parcels' scans are kept
 * together, newest first, and another catalog network that made the newest
 * scan becomes the delivery carrier.
 */
export function parsePostHaste(payload: unknown, raw: string): CarrierResult {
  return parseFreightways(POST_HASTE, payload, raw);
}
