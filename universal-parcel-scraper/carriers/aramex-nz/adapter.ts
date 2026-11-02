import { accepted, recognizeFromLookup, type AdapterFactory } from '../../core/adapter/index.js';
import { AramexRegionalTracker, aramexTrackingUrl, type AramexSite } from '../aramex-au/adapter.js';
import { normalizeAramexNzNumber, parseAramexNz, PROVIDER } from './parser.js';

export const ARAMEX_NZ_ORIGIN = 'https://www.aramex.co.nz';
// The service aramex.co.nz/tools/track asks: Aramex Australia's, on New Zealand's host and database.
const NEW_ZEALAND: AramexSite = {
  carrier: 'aramex-nz', provider: PROVIDER, origin: ARAMEX_NZ_ORIGIN, language: 'en-NZ,en;q=0.8',
  normalize: normalizeAramexNzNumber, parse: parseAramexNz,
};

/** The address the tracking page asks for one number. */
export function aramexNzUrl(raw: string): string {
  return aramexTrackingUrl(NEW_ZEALAND, raw);
}

export class AramexNzTracker extends AramexRegionalTracker {
  constructor(options: ConstructorParameters<typeof AramexRegionalTracker>[1] = {}) { super(NEW_ZEALAND, options); }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AramexNzTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'aramex-nz', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAramexNzNumber(number))),
  };
};
