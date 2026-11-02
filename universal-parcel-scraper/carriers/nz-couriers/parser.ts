import type { CarrierResult } from '../../core/result/index.js';
import { freightwaysQuery, parseFreightways, type FreightwaysNetwork, type FreightwaysQuery } from './freightways.js';

export const PROVIDER = 'New Zealand Couriers';
// A courier ticket: a product code of two or three letters, or a letter and two
// digits, then the ticket number. The search box takes it with a space or a
// hyphen between them; the number reaches the adapter without one.
const TICKET = /^([A-Z]{2,3}|[A-Z]\d{2})(\d{5,8})$/;
// Charge labels have eight digits, international consignments nine.
const LABEL = /^\d{8,9}$/;

/** New Zealand Couriers on the Freightways group's tracking lookup. */
export const NEW_ZEALAND_COURIERS: FreightwaysNetwork = {
  carrier: 'nz-couriers', provider: PROVIDER, path: 'NZCouriers', ticket: TICKET, label: LABEL,
  numbers: 'a ticket, an eight- or nine-digit label, an SSCC or a customer printed label',
};

export type NzCouriersQuery = FreightwaysQuery;

/** The first lookup for a New Zealand Couriers ticket, charge label, international consignment, SSCC or customer printed label. */
export function nzCouriersQuery(raw: string): NzCouriersQuery {
  return freightwaysQuery(NEW_ZEALAND_COURIERS, raw);
}

/** A New Zealand Couriers reply for one number. */
export function parseNzCouriers(payload: unknown, raw: string): CarrierResult {
  return parseFreightways(NEW_ZEALAND_COURIERS, payload, raw);
}
