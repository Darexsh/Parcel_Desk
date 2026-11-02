import type { FreightwaysNetwork } from '../nz-couriers/freightways.js';

export const PROVIDER = 'Castle Parcels';
// A courier ticket: a product code of up to four characters, then the
// eight-digit ticket number. A code of two to four letters, as on today's Post
// Haste tickets, may come without the number's leading zeros. A code with
// digits (N3, N10, NI25, N10W, as on the older area guides) needs all eight,
// so that the code and the number stay apart.
const TICKET = /^([A-Z]{2,4}|(?:[A-Z]\d{1,2}[A-Z]?|[A-Z]{2}\d{2})(?=\d{8}$))(\d{5,8})$/;
// Charge labels have eight digits.
const LABEL = /^\d{8}$/;

/** Castle Parcels on the Freightways group's tracking lookup. */
export const CASTLE_PARCELS: FreightwaysNetwork = {
  carrier: 'castle-parcels', provider: PROVIDER, path: 'CastleParcels', ticket: TICKET, label: LABEL,
  numbers: 'a ticket, an eight-digit charge label, an SSCC or a customer printed label',
};
