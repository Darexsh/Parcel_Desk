import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps, singleFlight, type StepContext } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeRedpackNumber, parseRedpack, PROVIDER, REDPACK_MAX_BYTES } from './parser.js';

export const REDPACK_TOKEN_URL = 'https://api.redpack.com.mx/oauth/token';
export const REDPACK_TRACKING_URL = 'https://api.redpack.com.mx:5400/redpack/trackingByNumber';

// Redpack's Android app (com.rpk.movil) ships this client and account, and
// signs every install in with them on its welcome screen, before its guest
// tracking opens. A customer's own login is a separate sign-in.
const APP_CLIENT = 'app-redpack-web:R3dPack&2020'; // gitleaks:allow
const APP_GRANT = 'grant_type=password&username=IKAMORA&password=amoral'; // gitleaks:allow
const APP_AUTHORIZATION = `Basic ${btoa(APP_CLIENT)}`;

// Tokens last twenty minutes; one is renewed this long before it ends.
const RENEW_MS = 60_000;
const MAX_LIFETIME_S = 86_400;

class RedpackSessionExpiredError extends CarrierError {
  constructor() {
    super('indeterminate', PROVIDER, 'Redpack rejected the app session');
    this.name = 'RedpackSessionExpiredError';
  }
}

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the app session's token.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

interface Session { token: string; expiresAt: number }

export class RedpackTracker {
  private session?: Session;
  private readonly serialize = singleFlight();

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRedpackNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Redpack budget must be a positive number of milliseconds');
    return runSteps({ carrier: 'redpack', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: step => this.lookup(number, step.signal, firstAttemptMs(step.remainingMs), false) },
      { id: 'refresh', recovers: error => error instanceof RedpackSessionExpiredError,
        run: step => this.lookup(number, step.signal, firstAttemptMs(step.remainingMs), true) },
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
      let bytes: Uint8Array;
      try {
        ({ bytes } = await fetchBounded(REDPACK_TRACKING_URL, { method: 'POST', signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}`, 'User-Agent': userAgent },
          // The service takes a list of guides; the app sends one.
          body: JSON.stringify([{ trackingNumber: number }]) },
        { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: REDPACK_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        if (error instanceof UpstreamHttpError && error.status === 401) {
          if (this.session === session) this.session = undefined;
          throw new RedpackSessionExpiredError();
        }
        // A missing route is not a missing guide.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Redpack tracking service is unavailable', { status: error.status });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) { throw new SchemaError(PROVIDER, 'Redpack returned invalid tracking JSON', { cause }); }
      return parseRedpack(payload, number);
    } catch (error) {
      throw withoutSession(error);
    }
  }

  /** The app's session, opened once at a time and kept until shortly before it ends. */
  private openSession(userAgent: string, signal: AbortSignal, timeoutMs: () => number, renew: boolean): Promise<Session> {
    const stale = renew ? this.session : undefined;
    return this.serialize(async () => {
      const kept = this.session;
      if (kept && kept !== stale && kept.expiresAt - RENEW_MS > Date.now()) return kept;
      this.session = undefined;
      const { response, bytes } = await fetchBounded(REDPACK_TOKEN_URL, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: APP_AUTHORIZATION, 'User-Agent': userAgent },
        body: APP_GRANT },
      { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: 64_000, allowHttpStatuses: [400, 401], fetcher: this.options.fetcher });
      if (response.status === 400 || response.status === 401) throw new ChallengeError(PROVIDER, "Redpack refused the app's sign-in");
      let grant: unknown;
      try { grant = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) { throw new SchemaError(PROVIDER, 'Redpack returned an invalid app session', { cause }); }
      // The reply also describes the app's account, which the adapter does not keep.
      const token = isRecord(grant) && typeof grant.access_token === 'string' ? grant.access_token : '';
      if (!isRecord(grant) || !/^[\w.~+/=-]{8,16384}$/.test(token) || String(grant.token_type).toLowerCase() !== 'bearer') {
        throw new SchemaError(PROVIDER, 'Redpack did not open an app session');
      }
      const lifetime = Number(grant.expires_in);
      const seconds = Number.isFinite(lifetime) && lifetime > 0 ? Math.min(lifetime, MAX_LIFETIME_S) : 0;
      this.session = { token, expiresAt: Date.now() + seconds * 1000 };
      return this.session;
    }, signal);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new RedpackTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'redpack', recordsSteps: true, steps: ['direct', 'refresh', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeRedpackNumber(number))) };
};
