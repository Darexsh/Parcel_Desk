import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import { OLVA_MAX_BYTES, olvaQueries, parseOlvaPage, PROVIDER, type OlvaQuery } from './parser.js';

/** The tracking page, which renders the shipment for the number its search field sends as `q`. */
export const OLVA_TRACKER = 'https://tracking.olvacourier.com/';
// The host refuses a crawler's `Mozilla/5.0 (compatible; …)` User-Agent, the package's default among them.
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers an unknown number itself: a missing route is not a missing parcel.
const GONE = [404, 410];

export class OlvaCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; now?: () => number } = {}) {}

  private async ask(query: OlvaQuery, raw: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${OLVA_TRACKER}?q=${encodeURIComponent(query.q)}`, { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'User-Agent': BROWSER_USER_AGENT,
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: OLVA_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    if (REDIRECTS.includes(response.status)) {
      if (/captcha/i.test(response.headers.get('location') ?? '')) throw new ChallengeError(PROVIDER, 'Olva Courier sent the lookup to a browser check');
      throw new TransportError(PROVIDER, 'Olva Courier redirected its tracking page', { status: response.status });
    }
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Olva Courier tracking page is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Olva Courier refused the lookup', { status: 403 });
    return parseOlvaPage(decodeText(bytes), query, raw);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const queries = olvaQueries(raw, this.options.now?.());
    // A number without its hyphen can read two ways: the next reading is asked only when
    // the tracker says it has no shipment for this one. Any other answer stands.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      for (const [index, query] of queries.entries()) {
        try {
          return await this.ask(query, raw, signal, deadline - Date.now());
        } catch (error) {
          if (index === queries.length - 1 || carrierErrorKind(error) !== 'not_found') throw error;
        }
      }
      throw new TypeError('Olva Courier has no lookup for this number');
    };
    // A lookup that fails to reach Olva, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'olva-courier', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new OlvaCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder });
  return {
    id: 'olva-courier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => olvaQueries(number))),
  };
};
