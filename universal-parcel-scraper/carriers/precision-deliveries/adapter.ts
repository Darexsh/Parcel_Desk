import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps, singleFlight, type StepContext } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePrecisionNumber, parsePrecision, precisionMissing, PRECISION_MAX_BYTES, PROVIDER } from './parser.js';

/** The tracking page's sign-in: an empty POST that sets the session cookie its lookups need. */
export const PRECISION_SESSION_URL = 'https://track.precisiondeliveries.com/api/authentication';
/** The parcel lookup the tracking page makes for a parcel id, followed by the id. */
export const PRECISION_ITEM_URL = 'https://track.precisiondeliveries.com/api/shipment-itemId/';
const REDIRECTS = [301, 302, 303, 307, 308];
const TOKEN = /^token=([\w.~+/=-]{8,512})$/;
// Sessions last an hour; one is opened again this long before it ends.
const RENEW_MS = 60_000;
const MAX_LIFETIME_S = 3_600;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;

class PrecisionSessionExpiredError extends CarrierError {
  constructor() {
    super('indeterminate', PROVIDER, 'Precision Deliveries ended the tracking page\'s session');
    this.name = 'PrecisionSessionExpiredError';
  }
}

/** The same failure without the request details fetchBounded attaches: they hold the session cookie. */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

function json(body: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Precision Deliveries answered with a browser check', { cause });
    // A 404 that is not the service's JSON is a moved route.
    if (status === 404) return undefined;
    throw new SchemaError(PROVIDER, 'Precision Deliveries returned a reply that is not JSON', { cause });
  }
}

interface Session { cookie: string; expiresAt: number }

export class PrecisionTracker {
  private session?: Session;
  private readonly serialize = singleFlight();

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePrecisionNumber(raw);
    return runSteps({ carrier: 'precision-deliveries', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: (step) => this.lookup(number, step.signal, firstAttemptMs(step.remainingMs), false) },
      // A session the service ended is opened again once, as the page does.
      { id: 'refresh', recovers: (error) => error instanceof PrecisionSessionExpiredError,
        run: (step) => this.lookup(number, step.signal, firstAttemptMs(step.remainingMs), true) },
      networkRetryStep((step: StepContext) => this.lookup(number, step.signal, step.remainingMs, false)),
    ]);
  }

  private async lookup(number: string, signal: AbortSignal, budgetMs: number, renew: boolean): Promise<CarrierResult> {
    const deadline = performance.now() + budgetMs;
    const timeoutMs = () => Math.max(1, Math.floor(deadline - performance.now()));
    const userAgent = userAgentOf(this.options.userAgent);
    try {
      const session = await this.openSession(userAgent, signal, timeoutMs, renew);
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(`${PRECISION_ITEM_URL}${encodeURIComponent(number)}`, { method: 'GET', signal,
        headers: { Accept: 'application/json', Cookie: session.cookie, 'User-Agent': userAgent } },
      { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: PRECISION_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Precision Deliveries redirected its tracking lookup');
      if (response.status === 401) {
        if (this.session === session) this.session = undefined;
        // A session the service refuses as soon as it opened it is no expiry.
        if (renew) throw new ChallengeError(PROVIDER, 'Precision Deliveries refused the tracking page\'s session', { status: 401 });
        throw new PrecisionSessionExpiredError();
      }
      const body = decodeText(bytes);
      if (response.status === 403) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Precision Deliveries answered with a browser check', { status: 403 });
        throw new ChallengeError(PROVIDER, 'Precision Deliveries refused the lookup', { status: 403 });
      }
      if (response.status === 410) throw new TransportError(PROVIDER, 'Precision Deliveries tracking lookup is unavailable', { status: 410 });
      // An unknown parcel id is a 404 that names it; a bare 404 is a moved route.
      if (response.status === 404) return precisionMissing(json(body, 404), number);
      return parsePrecision(json(body, response.status), number);
    } catch (error) {
      throw withoutSession(error);
    }
  }

  /** The tracking page's session, opened once at a time and kept until shortly before it ends. */
  private openSession(userAgent: string, signal: AbortSignal, timeoutMs: () => number, renew: boolean): Promise<Session> {
    const stale = renew ? this.session : undefined;
    return this.serialize(async () => {
      const kept = this.session;
      if (kept && kept !== stale && kept.expiresAt - RENEW_MS > Date.now()) return kept;
      this.session = undefined;
      // The page posts an empty object; the service answers with the session cookie.
      const { response, bytes } = await fetchBounded(PRECISION_SESSION_URL, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent }, body: '{}' },
      { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: 64_000, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
      if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
        throw new TransportError(PROVIDER, 'Precision Deliveries\' tracking session is unavailable', { status: response.status });
      }
      if (response.status === 401 || response.status === 403) {
        throw new ChallengeError(PROVIDER, 'Precision Deliveries refused to open a tracking session', { status: response.status });
      }
      let cookie = '';
      let lifetime = Number.NaN;
      for (const header of response.headers.getSetCookie()) {
        const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
        if (!TOKEN.test(pair)) continue;
        cookie = pair;
        const age = attributes.map((attribute) => /^max-age=(\d+)$/i.exec(attribute)?.[1]).find(Boolean);
        lifetime = age === undefined ? Number.NaN : Number(age);
      }
      if (!cookie) {
        if (CHALLENGE.test(decodeText(bytes).slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Precision Deliveries answered with a browser check');
        throw new SchemaError(PROVIDER, 'Precision Deliveries did not open a tracking session');
      }
      // Without a lifetime the session serves this lookup only.
      const seconds = Number.isFinite(lifetime) ? Math.min(lifetime, MAX_LIFETIME_S) : 0;
      this.session = { cookie, expiresAt: Date.now() + seconds * 1000 };
      return this.session;
    }, signal);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PrecisionTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'precision-deliveries', recordsSteps: true, steps: ['direct', 'refresh', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePrecisionNumber(number))),
  };
};
