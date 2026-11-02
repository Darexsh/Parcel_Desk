import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSkykingNumber, parseSkyking, PROVIDER, SKYKING_MAX_BYTES } from './parser.js';

/** The key the tracking page asks for when it loads, before each lookup. */
export const SKYKING_KEY_URL = 'https://live.skyking.co/api/Track/GetAPIKeyValue';
/** The lookup the tracking page makes for one consignment number. */
export const SKYKING_TRACK_URL = 'https://live.skyking.co/api/Track/ConsignmentMTrack_WebSite_AuthNew';
// The account name and address the tracking page sends with every lookup, the same for every visitor.
export const SKYKING_PAGE_ACCOUNT = { key: 'skm', Email: 'skm@flyking.co.in' }; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_Incapsula_Resource|AwsWafIntegration|captcha/i;
// The key is a base64 string, 128 characters when seen.
const KEY = /^[A-Za-z0-9+/]{16,1024}={0,2}$/;

function json(bytes: Uint8Array): unknown {
  const body = decodeText(bytes);
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SkyKing answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'SkyKing returned a reply that is not JSON', { cause });
  }
}

/** The same failure without the request details fetchBounded attaches: they hold the page key. */
function withoutKey(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs, error.diagnostics);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class SkykingTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSkykingNumber(raw);
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'skyking', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  private async read(number: string, signal: AbortSignal, budgetMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + budgetMs;
    const timeoutMs = () => Math.max(1, Math.floor(deadline - performance.now()));
    const userAgent = userAgentOf(this.options.userAgent);
    // Without a key the lookup answers every number with an empty history, as for an
    // unknown one, so each lookup asks for a fresh key first.
    const key = await this.key(userAgent, signal, timeoutMs());
    signal.throwIfAborted();
    const query = new URLSearchParams({ cnote: number, ...SKYKING_PAGE_ACCOUNT });
    try {
      const { response, bytes } = await fetchBounded(`${SKYKING_TRACK_URL}?${query}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', KeyValue: key, 'User-Agent': userAgent,
      } }, { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: SKYKING_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'SkyKing moved its tracking service');
      // An unknown number is HTTP 200 with an empty list; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'SkyKing tracking service is unavailable');
      return parseSkyking(json(bytes), number);
    } catch (error) {
      throw withoutKey(error);
    }
  }

  /** A key, as the tracking page gets one on every visit. */
  private async key(userAgent: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(SKYKING_KEY_URL, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgent,
    } }, { provider: PROVIDER, timeoutMs, maxBytes: 16_000, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'SkyKing tracking page key is unavailable');
    }
    const key = json(bytes);
    if (typeof key !== 'string' || !KEY.test(key)) throw new SchemaError(PROVIDER, 'SkyKing did not issue a tracking page key');
    return key;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SkykingTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'skyking', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSkykingNumber(number))),
  };
};
