import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePdnExpressNumber, parsePdnExpress, PDN_EXPRESS_MAX_BYTES, PROVIDER } from './parser.js';

/** The lookup the tracking page on pdn.express makes for the number typed in. */
export const PDN_EXPRESS_API = 'https://pdn.express/api/track';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: an unknown number gets the tracker's notice with HTTP 200.
const GONE = [404, 410];
// Cloudflare's bot checks, which could take the reply's place.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'PDN Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'PDN Express returned a reply that is not JSON', { cause });
  }
}

export class PdnExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePdnExpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(PDN_EXPRESS_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ action: 'search', orderNos: number, locale: 'en' }) }, { provider: PROVIDER,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PDN_EXPRESS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 400] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'PDN Express redirected its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'PDN Express tracking lookup is unavailable', { status: response.status });
      // A refused request (400) carries the page's error code, which the parser reads.
      return parsePdnExpress(json(decodeText(bytes)), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'pdn-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PdnExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pdn-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePdnExpressNumber(number))),
  };
};
