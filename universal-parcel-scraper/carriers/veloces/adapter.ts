import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeVelocesNumber, parseVeloces, PROVIDER, VELOCES_MAX_BYTES } from './parser.js';

/** The lookup tracking.veloces.app makes for the guide in its address. */
export const VELOCES_API = 'https://tracking.veloces.app/veloces/shipments/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|Vercel Security Checkpoint|awswaf\.com/i;
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * When the lookup's window opens again: `X-RateLimit-Reset` is that moment in
 * epoch seconds, read against the reply's own `Date` so the host's clock does
 * not matter.
 */
function retryAfterMs(response: Response): number | undefined {
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  const now = Date.parse(response.headers.get('date') ?? '');
  if (!Number.isSafeInteger(reset) || !Number.isFinite(now)) return undefined;
  const delay = reset * 1000 - now;
  return delay >= 0 && delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
}

export class VelocesTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeVelocesNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${VELOCES_API}${number}/tracking`, { method: 'GET', signal, headers: {
        // The tracker's client sends both headers with every lookup.
        Accept: 'application/json', 'X-White-Label': 'false', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: VELOCES_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410, 429] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Veloces redirected its tracking lookup');
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Veloces answered with a browser check', { cause, status: response.status });
        if (response.ok) throw new SchemaError(PROVIDER, 'Veloces returned a reply that is not JSON', { cause });
      }
      // Ten lookups per address every ten seconds; the eleventh gets HTTP 429.
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response), 'Veloces limited the lookups', { status: 429 });
      // An unknown guide is HTTP 404 with the service's own error; any other 404 is a moved route.
      if (response.status === 404 && isRecord(payload) && payload.error_code === 404) return parseVeloces(payload, number);
      if (!response.ok) throw new TransportError(PROVIDER, 'Veloces tracking lookup is unavailable', { status: response.status });
      return parseVeloces(payload, number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'veloces', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new VelocesTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'veloces', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
