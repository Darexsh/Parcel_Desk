import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps, type StepContext } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeThailandPostNumber, parseThailandPostReply, PROVIDER, thailandPostRequestBody } from './parser.js';

// The site's build sends to one of these two hosts; both serve the same records.
export const THAILAND_POST_ENDPOINTS = [
  'https://trackweb.thailandpost.co.th/post/api/web/getMailing',
  'https://trackweb2.thailandpost.co.th/post/api/web/getMailing',
] as const;
const BUDGET_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Less than this left after a failure is no time for the other host. */
const MIN_RETRY_MS = 1_000;
const MAX_BYTES = 1_000_000;
// An interactive check. A rate limit's page can also say access is denied,
// so that wording is no challenge on an error status.
const CHALLENGE_PAGE = /captcha|turnstile|cf-chl|challenge-platform|just a moment|verify you are human/i;

function retryAfterMs(header: string | null): number | undefined {
  const value = header?.trim() ?? '';
  const ms = /^\d+$/.test(value) ? Number(value) * 1_000 : value ? Date.parse(value) - Date.now() : Number.NaN;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/**
 * A failure the site's other host may not share, as its own client retries:
 * the network, or HTTP 405, 408, 429 or 5xx. A requested pause applies to the
 * service, not only to one host, so it ends the lookup.
 */
function otherHostMayAnswer(error: unknown): boolean {
  if (error instanceof UpstreamNetworkError) return true;
  if (!(error instanceof RateLimitedError || error instanceof UpstreamHttpError) || error.retryAfterMs !== undefined) return false;
  const status = error.status ?? 0;
  return status === 405 || status === 408 || status === 429 || status >= 500;
}

async function ask(endpoint: string, number: string, options: {
  signal: AbortSignal; timeoutMs: number; userAgent: string; fetcher?: typeof fetch;
}): Promise<CarrierResult> {
  const { response, bytes } = await fetchBounded(endpoint, { method: 'POST', signal: options.signal, body: thailandPostRequestBody(number), headers: {
    // The body is the site's encoded string; the site labels it JSON.
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': options.userAgent,
  } }, { provider: PROVIDER, timeoutMs: options.timeoutMs, maxBytes: MAX_BYTES, allowHttpError: true, fetcher: options.fetcher });
  const status = response.status;
  if (response.ok) return parseThailandPostReply(decodeText(bytes), number);
  if (status === 401 || status === 403) throw new ChallengeError(PROVIDER, 'Thailand Post refused the tracking request');
  const wait = retryAfterMs(response.headers.get('retry-after'));
  if (status === 429) throw new RateLimitedError(PROVIDER, wait);
  if (!(status === 503 && wait !== undefined) && CHALLENGE_PAGE.test(decodeText(bytes.subarray(0, 8_192)))) {
    throw new ChallengeError(PROVIDER, 'Thailand Post refused the tracking request');
  }
  // The endpoint answers unknown numbers inside HTTP 200, so a missing one is an outage.
  if (status === 404 || status === 410) throw new TransportError(PROVIDER, 'Thailand Post tracking endpoint is unavailable', { status });
  throw new UpstreamHttpError(PROVIDER, status, wait);
}

export class ThailandPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeThailandPostNumber(raw);
    const userAgent = userAgentOf(this.options.userAgent);
    const budgetMs = context.budgetMs ?? BUDGET_MS;
    const deadline = performance.now() + budgetMs;
    const request = (endpoint: string) => ({ signal, remainingMs }: StepContext) => ask(endpoint, number, {
      signal, userAgent, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(Math.min(REQUEST_TIMEOUT_MS, remainingMs))),
    });
    return runSteps({ carrier: 'thailand-post', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: request(THAILAND_POST_ENDPOINTS[0]) },
      // One try on the other host, while the lookup still has time for it.
      { id: 'mirror', recovers: (error) => otherHostMayAnswer(error) && deadline - performance.now() >= MIN_RETRY_MS,
        run: request(THAILAND_POST_ENDPOINTS[1]) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ThailandPostTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'thailand-post', recordsSteps: true, steps: ['direct', 'mirror'], track: (input, context) => tracker.fetch(input.number, context) };
};
