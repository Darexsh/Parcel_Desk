import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, EUROEXPRESS_MAX_BYTES, isEuroexpressMissing, normalizeEuroexpressNumber, parseEuroexpress, PROVIDER } from './parser.js';

/** The lookup EuroExpress's tracking page on euroexpress.ba makes for a code. */
export const EUROEXPRESS_API = 'https://app-api.euroexpress.ba/api/v1/pub/track';
const ORIGIN = new URL(EUROEXPRESS_API).origin;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|captcha/i;

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

/** The address a redirect sends the lookup to, when it is the same lookup for the same code on the same host. */
function sameLookup(location: string | null, from: string, number: string): string | null {
  if (!location) return null;
  try {
    const next = new URL(location, from);
    const keys = [...next.searchParams.keys()];
    return next.origin === ORIGIN && keys.length === 1 && next.searchParams.get('trackingNumber') === number ? next.href : null;
  } catch {
    return null;
  }
}

function json(body: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'EuroExpress answered with a browser check', { cause, status });
    if (status === 404) throw new TransportError(PROVIDER, 'EuroExpress tracking lookup is unavailable', { cause, status });
    throw new SchemaError(PROVIDER, 'EuroExpress returned a reply that is not JSON', { cause });
  }
}

export class EuroexpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEuroexpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      let url = `${EUROEXPRESS_API}?${new URLSearchParams({ trackingNumber: number })}`;
      // The lookup redirects once to the route that answers; any other redirect is a moved lookup.
      for (let hop = 0; ; hop += 1) {
        // Every status is read here, so no error body is kept in a diagnostic.
        const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
          Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - Date.now())), maxBytes: EUROEXPRESS_MAX_BYTES,
          redirect: 'manual', fetcher: this.options.fetcher, allowHttpError: true });
        const status = response.status;
        if (REDIRECTS.includes(status)) {
          const next = hop === 0 ? sameLookup(response.headers.get('location'), url, number) : null;
          if (!next) throw new TransportError(PROVIDER, 'EuroExpress redirected its tracking lookup', { status });
          url = next;
          continue;
        }
        if (status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response), 'EuroExpress limited the lookups', { status });
        if (status === 401 || status === 403) throw new ChallengeError(PROVIDER, 'EuroExpress refused the lookup', { status });
        if (status === 503) throw new MaintenanceError(PROVIDER, undefined, { status });
        if (status >= 500) throw new IndeterminateError(PROVIDER, `EuroExpress returned HTTP ${status}`, { status });
        if (status === 404) {
          if (isEuroexpressMissing(json(decodeText(bytes), status), number)) throw new NotFoundError(PROVIDER);
          throw new TransportError(PROVIDER, 'EuroExpress tracking lookup is unavailable', { status });
        }
        if (status !== 200) throw new TransportError(PROVIDER, `EuroExpress returned HTTP ${status}`, { status });
        return parseEuroexpress(json(decodeText(bytes), status), number);
      }
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EuroexpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEuroexpressNumber(number))),
  };
};
