import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeShipaNumber, ORDER_NOT_FOUND, parseShipa, PROVIDER, SHIPA_MAX_BYTES } from './parser.js';

/**
 * The lookup tracking.shipadelivery.com makes for a number. The path holds the
 * application id and key the page's script gives every visitor.
 */
export const SHIPA_API = 'https://apiv2.shipadelivery.com/7151BFA4-D6DB-66EE-FFFF-2579E2541200/E53D8B22-9B05-48D1-8C1C-D126EF68296F/services/whl/v2/my-packages/'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// The service's answer when it no longer knows the page's application id and key.
const UNKNOWN_APPLICATION = 2002;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|awswaf\.com/i;
const MAX_RETRY_AFTER_MS = 60_000;

/** `Retry-After` in seconds, when the service gives one within a minute. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 && seconds * 1000 <= MAX_RETRY_AFTER_MS ? seconds * 1000 : undefined;
}

export class ShipaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeShipaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${SHIPA_API}${number}`, { method: 'GET', signal, headers: {
        // The page asks for the story with its status codes.
        Accept: 'application/json', 'X-Order-Story-Version': 'v2', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SHIPA_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 404, 410, 429] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Shipa redirected its tracking lookup');
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Shipa answered with a browser check', { cause, status: response.status });
        if (response.ok) throw new SchemaError(PROVIDER, 'Shipa returned a reply that is not JSON', { cause });
      }
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response), 'Shipa limited the lookups', { status: 429 });
      // An unknown order is HTTP 404 with the service's own code; any other 404 is a moved route.
      if (response.status === 404 && isRecord(payload) && payload.code === ORDER_NOT_FOUND) return parseShipa(payload, number);
      if (response.status === 401 && isRecord(payload) && payload.code === UNKNOWN_APPLICATION) {
        throw new SchemaError(PROVIDER, 'Shipa no longer accepts its tracking page\'s application key', { status: 401 });
      }
      if (!response.ok) throw new TransportError(PROVIDER, 'Shipa tracking lookup is unavailable', { status: response.status });
      return parseShipa(payload, number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'shipa', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ShipaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'shipa', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
