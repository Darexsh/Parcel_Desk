import type { FreightwaysNetwork } from '../nz-couriers/freightways.js';

export const PROVIDER = 'Now Couriers';
// A courier ticket: a product code of two letters, or three for an add-on
// (SAT, RES), then the eight-digit ticket number, which may come without its
// leading zeros.
const TICKET = /^([A-Z]{2,3})(\d{5,8})$/;
// Charge labels have eight digits.
const LABEL = /^\d{8}$/;

/** Now Couriers on the Freightways group's tracking lookup. */
export const NOW_COURIERS: FreightwaysNetwork = {
  carrier: 'now-couriers', provider: PROVIDER, path: 'NowCouriers', ticket: TICKET, label: LABEL,
  numbers: 'a ticket, an eight-digit charge label, an SSCC or a customer printed label',
};
