import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { CarrierError, ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps, singleFlight, type StepContext } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { CHILEXPRESS_MAX_BYTES, normalizeChilexpressNumber, parseChilexpress, PROVIDER } from './parser.js';

/** The help centre, whose page signs every visitor in before it looks an order up. */
const ORIGIN = 'https://centrodeayuda.chilexpress.cl';
export const CHILEXPRESS_PAGE = `${ORIGIN}/`;
/** The help centre's API, behind Chilexpress's API gateway. */
const API = 'https://services.wschilexpress.com/centroayuda/api/v1/api/v1';
export const CHILEXPRESS_TOKEN_URL = `${API}/token`;
export const CHILEXPRESS_TRACKING_URL = `${API}/gettracking`;

/** How the help centre signs a visitor in: its gateway key and the app client it asks a token for. */
interface HelpCentreClient { key: string; clientId: string; scope: string; secret: string }

// The page's own script, by the name it serves; the name changes with every deploy.
const MAIN_SCRIPT = /<script\b[^>]*\bsrc="(\/?main\.[\w-]{4,64}\.js)"/;
// The script's settings for the help centre's API, the same for every visitor.
const setting = (name: string) => new RegExp(`\\b${name}"?:\\s*"([^"\\\\\\s]{1,256})"`);
const SCRIPT_KEY = setting('ocpApimSubscriptionKeyCDA');
const SCRIPT_CLIENT = setting('tokenCdaClient_id');
const SCRIPT_SCOPE = setting('tokenCdaScope');
const SCRIPT_SECRET = setting('tokenCdaClient_secret');
// How long values read from the page stand before a refused sign-in has them read again.
const CLIENT_CHECKED_MS = 60 * 60_000;
// The page is tens of kilobytes; its script is a few megabytes.
const PAGE_MAX_BYTES = 8 * 1024 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
// Tokens last an hour; one is renewed this long before it ends.
const RENEW_MS = 60_000;
const MAX_LIFETIME_S = 86_400;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|Incapsula|captcha/i;

class ChilexpressSessionExpiredError extends CarrierError {
  constructor() {
    super('indeterminate', PROVIDER, 'Chilexpress rejected the help centre session');
    this.name = 'ChilexpressSessionExpiredError';
  }
}

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the gateway key, the app client and the session's token.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

function json(bytes: Uint8Array, what: string): unknown {
  try {
    return parseJsonBytes(bytes, PROVIDER);
  } catch (cause) {
    if (CHALLENGE.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'Chilexpress answered with a browser check');
    throw new SchemaError(PROVIDER, `Chilexpress returned an invalid ${what}`, { cause });
  }
}

/** The sign-in values in the help centre's script; a script without them is a changed page. */
function scriptClient(script: string): HelpCentreClient {
  const key = SCRIPT_KEY.exec(script)?.[1];
  const clientId = SCRIPT_CLIENT.exec(script)?.[1];
  const secret = SCRIPT_SECRET.exec(script)?.[1];
  if (!key || !clientId || !secret) {
    if (/^\s*</.test(script) && CHALLENGE.test(script.slice(0, 64_000))) {
      throw new ChallengeError(PROVIDER, "Chilexpress answered the help centre's script with a browser check");
    }
    throw new SchemaError(PROVIDER, "Chilexpress's help centre script no longer shows how it signs a visitor in");
  }
  return { key, clientId, scope: SCRIPT_SCOPE.exec(script)?.[1] ?? `api://${clientId}/.default`, secret };
}

interface ReadClient { values: HelpCentreClient; readAt: number }
interface Session { token: string; key: string; expiresAt: number }

export class ChilexpressTracker {
  private client?: ReadClient;
  private session?: Session;
  private readonly serialize = singleFlight();

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeChilexpressNumber(raw);
    const budgetMs = context.budgetMs ?? 20_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Chilexpress budget must be a positive number of milliseconds');
    return runSteps({ carrier: 'chilexpress', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: step => this.lookup(number, step.signal, firstAttemptMs(step.remainingMs), false) },
      { id: 'refresh', recovers: error => error instanceof ChilexpressSessionExpiredError,
        run: step => this.lookup(number, step.signal, firstAttemptMs(step.remainingMs), true) },
      networkRetryStep((step: StepContext) => this.lookup(number, step.signal, step.remainingMs, false)),
    ]);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
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
        ({ bytes } = await fetchBounded(`${CHILEXPRESS_TRACKING_URL}?ot=${number}`, { method: 'GET', signal, headers: {
          Accept: 'application/json', Origin: ORIGIN, 'Ocp-Apim-Subscription-Key': session.key, Authorization: `Bearer ${session.token}`,
          'User-Agent': userAgent,
        } }, { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: CHILEXPRESS_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        if (error instanceof UpstreamHttpError && error.status === 401) {
          if (this.session === session) this.session = undefined;
          throw new ChilexpressSessionExpiredError();
        }
        // A missing route is not a missing order.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Chilexpress tracking service is unavailable', { status: error.status });
        }
        throw error;
      }
      return parseChilexpress(json(bytes, 'tracking reply'), number);
    } catch (error) {
      throw withoutSession(error);
    }
  }

  /** The help centre's session, opened once at a time and kept until shortly before it ends. */
  private openSession(userAgent: string, signal: AbortSignal, timeoutMs: () => number, renew: boolean): Promise<Session> {
    const stale = renew ? this.session : undefined;
    return this.serialize(async () => {
      const kept = this.session;
      if (kept && kept !== stale && kept.expiresAt - RENEW_MS > this.now()) return kept;
      this.session = undefined;
      let client = this.client ?? await this.readClient(userAgent, signal, timeoutMs);
      let grant = await this.signIn(client.values, userAgent, signal, timeoutMs);
      // The page may have moved on to new values since they were read.
      if (!grant && this.now() - client.readAt >= CLIENT_CHECKED_MS) {
        client = await this.readClient(userAgent, signal, timeoutMs);
        grant = await this.signIn(client.values, userAgent, signal, timeoutMs);
      }
      if (!grant) throw new ChallengeError(PROVIDER, "Chilexpress refused the help centre's sign-in");
      const token = isRecord(grant) && typeof grant.access_token === 'string' ? grant.access_token : '';
      if (!isRecord(grant) || !/^[\w.~+/=-]{8,16384}$/.test(token) || String(grant.token_type).toLowerCase() !== 'bearer') {
        throw new SchemaError(PROVIDER, 'Chilexpress did not open a help centre session');
      }
      const lifetime = Number(grant.expires_in);
      const seconds = Number.isFinite(lifetime) && lifetime > 0 ? Math.min(lifetime, MAX_LIFETIME_S) : 0;
      this.session = { token, key: client.values.key, expiresAt: this.now() + seconds * 1000 };
      return this.session;
    }, signal);
  }

  /** The token grant, or null when the gateway refuses the sign-in. */
  private async signIn(client: HelpCentreClient, userAgent: string, signal: AbortSignal, timeoutMs: () => number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(CHILEXPRESS_TOKEN_URL, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN,
      'Ocp-Apim-Subscription-Key': client.key, 'User-Agent': userAgent,
    }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client.clientId, scope: client.scope,
      client_secret: client.secret }).toString() },
    { provider: PROVIDER, timeoutMs: timeoutMs(), maxBytes: 64_000, allowHttpStatuses: [400, 401, 403], fetcher: this.options.fetcher });
    // The gateway answers 403 to a request it does not take from the page, 400 or 401 to a client it no longer knows.
    if ([400, 401, 403].includes(response.status)) return null;
    return json(bytes, 'help centre session');
  }

  /** The values the help centre's page signs a visitor in with, from its script. */
  private async readClient(userAgent: string, signal: AbortSignal, timeoutMs: () => number): Promise<ReadClient> {
    const page = await this.text(CHILEXPRESS_PAGE, userAgent, signal, timeoutMs());
    const path = MAIN_SCRIPT.exec(page)?.[1];
    if (!path) {
      if (CHALLENGE.test(page.slice(0, 64_000))) throw new ChallengeError(PROVIDER, "Chilexpress answered the help centre's page with a browser check");
      throw new SchemaError(PROVIDER, "Chilexpress's help centre page no longer names its script");
    }
    const values = scriptClient(await this.text(new URL(path, CHILEXPRESS_PAGE).href, userAgent, signal, timeoutMs()));
    this.client = { values, readAt: this.now() };
    return this.client;
  }

  private async text(url: string, userAgent: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: { 'User-Agent': userAgent } },
      { provider: PROVIDER, timeoutMs, maxBytes: PAGE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (response.status !== 200) throw new TransportError(PROVIDER, "Chilexpress's help centre page is unavailable", { status: response.status });
    return decodeText(bytes);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ChilexpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'chilexpress', recordsSteps: true, steps: ['direct', 'refresh', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeChilexpressNumber(number))) };
};
