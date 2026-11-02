import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { GATI_MAX_BYTES, normalizeGatiNumber, parseGati, PROVIDER } from './parser.js';

/** The page token the tracking page on www.allcargologistics.com asks for when it loads. */
export const GATI_TOKEN_URL = 'https://admin.allcargologistics.com/api/frontend/token';
/** The lookup the tracking page makes for the docket number typed in. */
export const GATI_TRACKING_URL = 'https://admin.allcargologistics.com/api/track-shipment';
// The site answers the lookup only for its own pages.
const ORIGIN = 'https://www.allcargologistics.com';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|g-recaptcha|h-captcha/i;
// The token is a number, a bar and forty letters and digits.
const TOKEN = /^[\w|.~+/=-]{8,512}$/;

function json(bytes: Uint8Array): unknown {
  const body = decodeText(bytes);
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'AllcargoGATI answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'AllcargoGATI returned a reply that is not JSON', { cause });
  }
}

/**
 * The same failure without the request details fetchBounded attaches: they
 * hold the page token.
 */
function withoutToken(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class GatiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGatiNumber(raw);
    // One read with the whole budget: the site waits up to thirty seconds for
    // the tracking service behind it, which some dockets never answer.
    return runSteps({ carrier: 'gati', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, remainingMs) },
    ]);
  }

  private async read(number: string, signal: AbortSignal, budgetMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + budgetMs;
    const timeoutMs = () => Math.max(1, Math.floor(deadline - performance.now()));
    const userAgent = userAgentOf(this.options.userAgent);
    const token = await this.token(userAgent, signal, timeoutMs());
    signal.throwIfAborted();
    try {
      const { response, bytes } = await fetchBounded(GATI_TRACKING_URL, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: ORIGIN, 'User-Agent': userAgent,
      }, body: JSON.stringify({ docketNo: number }) }, { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: GATI_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 422] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'AllcargoGATI redirected its tracking lookup');
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'AllcargoGATI tracking lookup is unavailable');
      // The token was just issued and the origin is the site's own, so a refusal is a changed gate.
      if (response.status === 401 || response.status === 403) {
        throw new ChallengeError(PROVIDER, 'AllcargoGATI refused the tracking page token', { status: response.status });
      }
      // A refused number is HTTP 422 with the reasons, which the parser reads.
      return parseGati(json(bytes), number);
    } catch (error) {
      throw withoutToken(error);
    }
  }

  /** A page token, as the tracking page gets one on every visit; it lasts five minutes. */
  private async token(userAgent: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(GATI_TOKEN_URL, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Origin: ORIGIN, 'User-Agent': userAgent,
    }, body: '{}' }, { provider: PROVIDER, timeoutMs, maxBytes: 64_000, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
      throw new TransportError(PROVIDER, 'AllcargoGATI tracking page token is unavailable');
    }
    const grant = json(bytes);
    const token = isRecord(grant) && typeof grant.token === 'string' ? grant.token : '';
    if (!TOKEN.test(token) || !isRecord(grant) || String(grant.type).toLowerCase() !== 'bearer') {
      throw new SchemaError(PROVIDER, 'AllcargoGATI did not issue a tracking page token');
    }
    return token;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GatiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gati', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGatiNumber(number))),
  };
};
