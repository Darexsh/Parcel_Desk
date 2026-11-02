import type { AdapterFactory } from '../../core/adapter/index.js';
import { DPD_DELIVERY_UNITS, DPDTracker } from '../dpd/adapter.js';

/** The Netherlands reads the myDPD guest protocol with its own business-unit selector. */
export const adapter: AdapterFactory = (environment) => {
  const tracker = new DPDTracker({
    country: 'NL',
    fetcher: environment.fetcher,
    recorder: environment.recorder,
    userAgent: environment.userAgent,
    // The unit of the country DPD delivers in reads the same parcel with its own scans and places.
    handsTo: DPD_DELIVERY_UNITS,
  });
  return {
    id: 'dpd-nl', recordsSteps: true, steps: ['direct'],
    // The catalog asks for no postcode, so DPD answers without verifying the recipient.
    track: (input, context) => tracker.fetch(input.number, '', context),
    // The guest API's current country, as for Belgium, Switzerland and Germany.
    recognize: async (number, context) => ({ known: await tracker.recognizes(number, context) }),
  };
};
