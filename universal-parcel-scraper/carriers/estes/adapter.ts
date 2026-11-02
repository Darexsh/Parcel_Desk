import { recognizeFromLookup, accepted, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ESTES_MAX_BYTES, INVALID_CODE, normalizeEstesNumber, NOT_FOUND_CODE, parseEstes, PROVIDER } from './parser.js';

// The service the MyEstes shipment tracking page asks, without an account,
// key, cookie or CAPTCHA token. Its interceptor adds a token only after a login.
export const ESTES_ENDPOINT = 'https://myestes-api.estes-express.com/shipmenttracking/history';
// A firewall's or CDN's page instead of the service's JSON.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access denied|Request Rejected|403 Forbidden)|cf-turnstile|_cf_chl_opt|The requested URL was rejected|captcha/i;

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

/** The address the tracking page asks for one PRO number. */
export function estesTrackingUrl(raw: string): string {
  const url = new URL(ESTES_ENDPOINT);
  url.searchParams.set('pro', normalizeEstesNumber(raw));
  return url.href;
}

export class EstesTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = estesTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ESTES_MAX_BYTES,
        fetcher: this.options.fetcher, allowHttpStatuses: [400, 404, 410, 429] });
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response));
      // A 404 or 410 without the service's not-found code is a missing route, not a missing shipment.
      const gone = response.status === 404 || response.status === 410;
      const text = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Estes answered with a block page', { cause });
        if (gone) throw new TransportError(PROVIDER, 'Estes tracking service is unavailable', { cause });
        throw new SchemaError(PROVIDER, 'Estes returned a reply that is not JSON', { cause });
      }
      // Only the service's own not-found code on a 404, and its refusal on a
      // 400, say something about the number; the parser reads both.
      const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
      if (gone && (response.status === 410 || code !== NOT_FOUND_CODE)) throw new TransportError(PROVIDER, 'Estes tracking service is unavailable');
      if (response.status === 400 && code !== INVALID_CODE) throw new SchemaError(PROVIDER, 'Estes refused the request without its reason');
      return parseEstes(payload, raw);
    };
    // A request that fails to reach Estes, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'estes', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EstesTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'estes', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEstesNumber(number))),
  };
};
