import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BLUE_EXPRESS_MAX_BYTES, normalizeBlueExpressNumber, parseBlueExpress, PROVIDER } from './parser.js';

/** The lookup the tracking page on blue.cl makes for a service order's scans. */
export const BLUE_EXPRESS_API = 'https://www.blue.cl/api/tracking/microestado';
const REDIRECTS = [301, 302, 303, 307, 308];
// The lookup answers an unknown number with HTTP 404 and its own JSON.
const GONE = [404, 410];
// What Cloudflare answers, with HTTP 404, a client its firewall refuses, as it
// does outside a browser for the page's summary lookup.
const REFUSAL = /^\s*Not found\s*$/;
// Bot checks Cloudflare puts in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Blue Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Blue Express returned a reply that is not JSON', { cause });
  }
}

export class BlueExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBlueExpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(BLUE_EXPRESS_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ os: number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: BLUE_EXPRESS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Blue Express moved its tracking lookup');
      const body = decodeText(bytes);
      if (GONE.includes(response.status)) {
        if (REFUSAL.test(body)) throw new ChallengeError(PROVIDER, 'Blue Express’s firewall refused the lookup', { status: response.status });
        // A page instead of the lookup's JSON is a moved route.
        if (!body.trimStart().startsWith('{')) throw new TransportError(PROVIDER, 'Blue Express tracking lookup is unavailable');
      }
      return parseBlueExpress(json(body), number);
    };
    // A request that fails to reach Blue Express, or hangs, gets one more
    // try: the first gets half of the budget, so the retry fits in the rest.
    // An HTTP status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'blue-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BlueExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'blue-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBlueExpressNumber(number))),
  };
};
