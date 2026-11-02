import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { LABAIH_MAX_BYTES, normalizeLabaihNumber, parseLabaih, PROVIDER } from './parser.js';

/** The tracker's English page; the Arabic one that links open leaves some scans out. */
export const LABAIH_TRACKING = 'https://track.mylabaih.com/track/en/?cn=';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The tracker's redirect for a number it does not have, to its "Shipment(s) Not Found" page. */
function missing(response: Response, url: string): boolean {
  const location = response.headers.get('location');
  if (!location) return false;
  try {
    const target = new URL(location, url);
    return target.hostname === 'track.mylabaih.com' && /^\/errors?\/404\/?$/.test(target.pathname);
  } catch {
    return false;
  }
}

export class LabaihTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLabaihNumber(raw);
    const url = `${LABAIH_TRACKING}${number}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LABAIH_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status) && missing(response, url)) throw new NotFoundError(PROVIDER);
      // Any other redirect, or a 404, is a moved page.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'LaBaih tracking page moved', { status: response.status });
      return parseLabaih(decodeText(bytes), number);
    };
    // A read that fails to reach the site, or hangs, gets one more: the first gets half of the budget.
    return runSteps({ carrier: 'labaih', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LabaihTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'labaih', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLabaihNumber(number))),
  };
};
