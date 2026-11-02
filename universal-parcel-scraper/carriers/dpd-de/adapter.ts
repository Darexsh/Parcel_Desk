import type { AdapterEnvironment, AdapterFactory } from '../../core/adapter/index.js';
import { carrierErrorKind, IndeterminateError, NotFoundError } from '../../core/errors/index.js';
import { fillPartialAnswer } from '../../core/result/partial.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { DPDTracker, type DPDAbroad } from '../dpd/adapter.js';
import { adapter as dpdAt } from '../dpd-at/adapter.js';
import { DPDFranceTracker } from '../dpd-fr/adapter.js';
import { adapter as dpdIe, type DpdGroupLookup } from '../dpd-ie/adapter.js';
import { adapter as dpdPl } from '../dpd-pl/adapter.js';
import { DpdPtTracker } from '../dpd-pt/adapter.js';
import { adapter as dpdUk } from '../dpd-uk/adapter.js';
import { DpdDeAppClient } from './app.js';
import { DpdOtherCountryError, sharedDpdAppService } from './service.js';

/** Left to the guest API when the app's session is still opening ahead of it. */
const GUEST_RESERVE_MS = 20_000;

/** A unit's lookup, made from the environment. None opens a browser, so a lookup here never does. */
type Unit = (environment: AdapterEnvironment) => DpdGroupLookup;

// A unit's wall clocks are dated as its own lookup dates them, not on Germany's clock.
const adapterUnit = (factory: AdapterFactory): Unit => (environment) => {
  const unit = factory({ ...environment, recorder: NOOP_RECORDER });
  return async (number, context) => dateLocalClocks(unit.id, await unit.track({ number }, context));
};

/**
 * DPD's other units with a source of their own that takes DPD parcel numbers, by the country code
 * DPD gives. Belgium's, the Netherlands' and Switzerland's read the group's guest service.
 */
const UNITS: Readonly<Record<string, Unit>> = {
  AT: adapterUnit(dpdAt), GB: adapterUnit(dpdUk), IE: adapterUnit(dpdIe), PL: adapterUnit(dpdPl),
  // Keep the foreign-unit handoff HTTP-only even when Portugal's adapter can recover in a browser.
  PT: ({ fetcher, userAgent }) => {
    const tracker = new DpdPtTracker({ fetcher, userAgent });
    return async (number, context) => dateLocalClocks('dpd-pt', await tracker.fetch(number, context));
  },
  // DPD France's page by a direct request, without the browser service its adapter can use.
  FR: ({ fetcher }) => {
    const tracker = new DPDFranceTracker({ fetcher });
    return (number, context) => tracker.fetch(number, context);
  },
};

/**
 * A parcel the German tiers place in another country, from DPD's group-wide
 * guest service and, when the country's unit has a source of its own, that
 * unit, asked together: the unit's history when it holds more scans and is not behind the
 * group's milestones, else those. Either answers when the other fails. The
 * German tiers know the parcel, so neither finding it is inconclusive.
 */
export function trackAbroad(group: DpdGroupLookup, units: Readonly<Record<string, DpdGroupLookup>>): DPDAbroad {
  return async (number, country, context) => {
    const unit = Object.hasOwn(units, country) ? units[country] : undefined;
    const [shared, own] = await Promise.allSettled([group(number, context), ...(unit ? [unit(number, context)] : [])]);
    if (shared.status === 'fulfilled') {
      return own?.status === 'fulfilled' ? fillPartialAnswer('dpd-de', number, shared.value, own.value) ?? shared.value : shared.value;
    }
    if (own?.status === 'fulfilled') return own.value;
    throw [shared.reason, own?.reason].find((error: unknown) => error !== undefined && !(error instanceof NotFoundError))
      ?? new IndeterminateError('DPD Germany', 'DPD did not find the parcel it places in another country');
  };
}

/** Germany reads the German app's service, then the guest protocol with its own business-unit selector. */
export const adapter: AdapterFactory = (environment) => {
  // The process's session, which DPD Switzerland shares.
  const service = sharedDpdAppService(environment);
  const app = new DpdDeAppClient({ service });
  // DPD's guest service answers for the whole group; Belgium's unit asks it alone, as for DPD Ireland.
  const group = new DPDTracker({ country: 'BE', fetcher: environment.fetcher, userAgent: environment.userAgent });
  const units = Object.fromEntries(Object.entries(UNITS).map(([country, unit]) => [country, unit(environment)]));
  const tracker = new DPDTracker({
    country: 'DE',
    fetcher: environment.fetcher,
    recorder: environment.recorder,
    userAgent: environment.userAgent,
    app: {
      run: (number, { signal, stop, timeoutMs, leads, postcode, waiting }) => app.track(number, {
        signal, stop, timeoutMs, postcode, waiting, sessionWaitMs: leads ? Math.max(0, timeoutMs - GUEST_RESERVE_MS) : timeoutMs,
      }),
      // Each service has its own host, limits and outages, so either answers when
      // the other fails. Both read the same parcel: neither can place another
      // country's delivery in Germany, nor find a parcel the guest API does not know.
      recovers: error => carrierErrorKind(error) !== 'not_found' && !(error instanceof DpdOtherCountryError),
    },
    abroad: trackAbroad((number, context) => group.fetch(number, '', context), units),
  });
  return {
    id: 'dpd-de', recordsSteps: true, steps: ['app', 'direct', 'abroad'],
    track: (input, context) => tracker.fetch(input.number, input.postcode ?? '', context),
    // The guest API's current country, as for Switzerland: the app's session takes too long to open.
    recognize: async (number, context) => ({ known: await tracker.recognizes(number, context) }),
  };
};
