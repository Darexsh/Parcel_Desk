import { freightwaysAdapter, freightwaysApi, freightwaysLookupUrl, FreightwaysTracker } from './freightways.js';
import { NEW_ZEALAND_COURIERS, type NzCouriersQuery } from './parser.js';

/** The lookup the tracking page on nzcouriers.co.nz makes for the number in its address. */
export const NZ_COURIERS_API = freightwaysApi(NEW_ZEALAND_COURIERS);

/** The address of New Zealand Couriers' lookup for one number. */
export function nzCouriersLookupUrl(asked: NzCouriersQuery): string {
  return freightwaysLookupUrl(NEW_ZEALAND_COURIERS, asked);
}

export class NzCouriersTracker extends FreightwaysTracker {
  constructor(options: ConstructorParameters<typeof FreightwaysTracker>[1] = {}) { super(NEW_ZEALAND_COURIERS, options); }
}

export const adapter = freightwaysAdapter(NEW_ZEALAND_COURIERS);
