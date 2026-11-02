import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isTwsWaybill, normalizeTwsNumber, parseTws, PROVIDER, TWS_MAX_BYTES } from './parser.js';

/** The lookup the tracking page on mytws.it makes for the waybill in its address. */
export const TWS_API = 'https://tsmbe.it/extracking/trackingStatusLdv';
const REDIRECTS = [301, 302, 303, 307, 308];
// The service answers an unknown waybill itself: a missing route is a moved lookup, not a missing parcel.
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|<title>\s*Access Denied|Request Rejected/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TWS answered with a page instead of its reply', { cause });
    throw new SchemaError(PROVIDER, 'TWS returned a reply that is not JSON', { cause });
  }
}

export class TwsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTwsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page posts the bare waybill as the body.
      const { response, bytes } = await fetchBounded(TWS_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'text/plain', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: number }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TWS_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'TWS redirected its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'TWS tracking lookup is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'TWS refused the lookup', { status: 403 });
      return parseTws(json(decodeText(bytes)), number);
    };
    // A lookup that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'tws-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TwsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tws-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // Only TWS's own waybills: Poste Delivery Business waybills stay with Poste Italiane.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTwsNumber(number)) && isTwsWaybill(normalizeTwsNumber(number))),
  };
};
