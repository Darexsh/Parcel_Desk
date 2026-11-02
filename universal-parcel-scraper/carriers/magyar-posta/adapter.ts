import { type AdapterFactory, recognizeFromBrowserLookup, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { MAGYAR_POSTA_APP_PAGE, MAGYAR_POSTA_APP_TRACKING, magyarPostaAppFailure, magyarPostaAppJson, magyarPostaApplicationId,
  magyarPostaAppTrackingUrl, readMagyarPostaApp } from './app.js';
import { MAGYAR_POSTA_MAX_BYTES, magyarPostaAppMiss, magyarPostaTrackingUrl, normalizeMagyarPostaNumber, parseMagyarPosta, parseMagyarPostaApp,
  PROVIDER } from './parser.js';

export { MAGYAR_POSTA_APP_PAGE, MAGYAR_POSTA_APP_TRACKING, magyarPostaAppTrackingUrl } from './app.js';
export { magyarPostaTrackingUrl, normalizeMagyarPostaNumber, parseMagyarPosta, parseMagyarPostaApp } from './parser.js';

/** The tracker page, its search form's endpoint, and the result page the search redirects to. */
export const MAGYAR_POSTA_TRACKER = 'https://www.posta.hu/ikrnyomkovproxy/';
export const MAGYAR_POSTA_SEARCH = 'https://www.posta.hu/ikrnyomkovproxy/Search/Search';
export const MAGYAR_POSTA_RESULT = 'https://www.posta.hu/ikrnyomkovproxy/Result/Index';
/** The browser helpers' record on the tracker or widget page when Google refuses the audio challenge. */
const REFUSED = 'Google refused the audio challenge';
/** How long a refusal holds for this address, during which lookups do not open the browser. */
const REFUSAL_MEMORY_MS = 10 * 60_000;
/** The app's reply when, after a valid token, it does not add the number, as for one it does not know. */
const UNADDED = 'Unsuccessful Action!';
/** How long the app is not asked again to add such a number. */
const UNADDED_MEMORY_MS = 30 * 60_000;
/** Numbers one application id takes before new ones go to a fresh id. */
const NUMBERS_PER_APPLICATION = 50;
/** Added numbers remembered, oldest forgotten first; a forgotten one is added again. */
const MAX_REMEMBERED = 5_000;

/** The app answered a valid token without adding the number. */
class UnaddedError extends IndeterminateError {}

/** A refused or failed page; a missing route is not a missing item. */
function httpFailure(status: number, retryAfter?: string): Error | null {
  if (status === 429) return new RateLimitedError(PROVIDER, retryAfter && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined);
  if (status === 401 || status === 403) return new ChallengeError(PROVIDER);
  if (status === 404 || status === 410) return new TransportError(PROVIDER, 'Magyar Posta tracker is unavailable');
  return status >= 400 ? new UpstreamHttpError(PROVIDER, status) : null;
}

/**
 * One search through the browser service: its helper solves the tracker's
 * reCAPTCHA checkbox, searches the number and returns the result page its
 * search redirected to, bound to the whole number.
 */
export async function magyarPostaBrowser(trawl: TrawlClient, raw: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
  const number = normalizeMagyarPostaNumber(raw);
  const timeoutMs = Math.floor(remainingMs - 2000);
  if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
  const page = await trawl.scrape({ url: magyarPostaTrackingUrl(number), skipHttp: true, maxTier: 3,
    captureResponses: [MAGYAR_POSTA_RESULT], maxTimeout: timeoutMs, settleTimeout: timeoutMs },
  { provider: PROVIDER, timeoutMs, signal, requireSolved: false, captureWindow: 'last', maxBytes: 6 * MAGYAR_POSTA_MAX_BYTES });
  signal.throwIfAborted();
  if (page.capturedResponses.length > 10) throw new ChallengeError(PROVIDER, 'Magyar Posta returned no matching verified search');
  if (page.capturedResponses.some(row => row.url === MAGYAR_POSTA_TRACKER && row.error === REFUSED)) {
    throw new ChallengeError(PROVIDER, 'Google refused Magyar Posta\'s audio challenge', { reason: 'verification_refused' });
  }
  const result = page.capturedResponses.filter(row => row.url === MAGYAR_POSTA_RESULT && row.trackingNumberSubmitted === number).at(-1);
  const search = page.capturedResponses.filter(row => row.url === MAGYAR_POSTA_SEARCH).at(-1);
  const response = result ?? search;
  if (!response) {
    // No search left the tracker: its own page failed, or the checkbox was not solved.
    throw httpFailure(page.statusCode) ?? new ChallengeError(PROVIDER, 'Magyar Posta returned no verified search');
  }
  const failure = httpFailure(response.status, response.headers['retry-after']);
  if (failure) throw failure;
  if (!result) {
    // The search form back without a redirect is a refused verification.
    if (response.status === 200) throw new ChallengeError(PROVIDER, 'Magyar Posta refused the reCAPTCHA answer');
    throw new TransportError(PROVIDER, 'Magyar Posta did not return the search result');
  }
  if (result.status !== 200 || result.error || result.truncated || result.base64Encoded || !result.body) {
    throw new TransportError(PROVIDER, 'Magyar Posta returned an incomplete browser response');
  }
  if (Buffer.byteLength(result.body) > MAGYAR_POSTA_MAX_BYTES) throw new SchemaError(PROVIDER, 'Magyar Posta returned excessive browser data');
  return parseMagyarPosta(result.body, number);
}

/**
 * Adds one number to the app's guest list under an application id through the
 * browser service, whose helper answers the app's invisible reCAPTCHA and posts
 * the number, bound to the whole number. The reply is the item, as later reads
 * of the id return it.
 */
export async function magyarPostaAppBrowser(trawl: TrawlClient, raw: string, applicationId: string, signal: AbortSignal,
  remainingMs: number, rememberApplication?: () => void, supportsRegistrationCache?: () => void): Promise<CarrierResult> {
  const number = normalizeMagyarPostaNumber(raw);
  const timeoutMs = Math.floor(remainingMs - 2000);
  if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
  const page = await trawl.scrape({ url: magyarPostaAppTrackingUrl(applicationId, number), skipHttp: true, maxTier: 3,
    captureResponses: [MAGYAR_POSTA_APP_TRACKING], maxTimeout: timeoutMs, settleTimeout: timeoutMs },
  { provider: PROVIDER, timeoutMs, signal, requireSolved: false, captureWindow: 'last', maxBytes: 2 * MAGYAR_POSTA_MAX_BYTES });
  signal.throwIfAborted();
  if (page.capturedResponses.some(row => row.headers['x-magyar-posta-registration-cache'] === 'memory'
    && ((row.url === MAGYAR_POSTA_APP_PAGE && row.error === REFUSED)
      || (row.url === MAGYAR_POSTA_APP_TRACKING && row.trackingNumberSubmitted === number)))) supportsRegistrationCache?.();
  if (page.capturedResponses.some(row => row.url === MAGYAR_POSTA_APP_PAGE && row.error === REFUSED)) {
    throw new ChallengeError(PROVIDER, 'Google refused Magyar Posta\'s audio challenge', { reason: 'verification_refused' });
  }
  const rows = page.capturedResponses.filter(row => row.url === MAGYAR_POSTA_APP_TRACKING && row.trackingNumberSubmitted === number);
  const reply = rows.at(-1);
  if (rows.length > 1) throw new ChallengeError(PROVIDER, 'Magyar Posta\'s app returned no single bound addition');
  // No addition left the widget page: its page failed, or the widget issued no token.
  if (!reply) throw httpFailure(page.statusCode) ?? new ChallengeError(PROVIDER, 'Magyar Posta\'s app widget issued no token');
  if (reply.error === 'Magyar Posta returned no bound cached history') throw new SchemaError(PROVIDER, 'Magyar Posta returned unbound cached history');
  if (reply.error || reply.truncated || reply.base64Encoded) throw new TransportError(PROVIDER, 'Magyar Posta returned an incomplete app reply');
  const payload = reply.body === null ? null : magyarPostaAppJson(reply.body);
  if (reply.headers['x-magyar-posta-registration'] !== 'retained' && reply.status === 502
    && typeof payload === 'object' && payload !== null && (payload as { message?: unknown }).message === UNADDED) {
    throw new UnaddedError(PROVIDER, 'Magyar Posta\'s app did not add the number');
  }
  const failure = magyarPostaAppFailure(reply.status, reply.headers['retry-after']);
  if (failure) throw failure;
  const result = parseMagyarPostaApp(payload, number);
  if (!result) throw new SchemaError(PROVIDER, magyarPostaAppMiss(payload, number));
  // A retained registration belongs to the helper, not to this new app id.
  // Its capability stays in the helper's memory rather than entering results.
  if (reply.headers['x-magyar-posta-registration'] !== 'retained') rememberApplication?.();
  return result;
}

export class MagyarPostaTracker {
  /** Until when Google's refusal holds, for the app's widget and for the tracker's checkbox, which have their own keys. */
  #refusedUntil = { app: 0, web: 0 };
  /** A helper with retained registrations checks those before its own widget cooldown. */
  #registrationCache = false;
  /** The application id each added number is read under, oldest first. */
  #added = new Map<string, string>();
  /** The id new numbers go to, generated when first needed, and how many it took. */
  #current: { id: Promise<string>; count: number } | null = null;
  /** Numbers the app would not add, until they are asked again. */
  #unadded = new Map<string, number>();

  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  /** The id to add a number under, or null when the app's API refuses its key or is gone. */
  async #applicationId(signal: AbortSignal, remainingMs: number): Promise<string | null> {
    if (!this.#current || this.#current.count >= NUMBERS_PER_APPLICATION) {
      const id = magyarPostaApplicationId({ fetcher: this.options.fetcher, userAgent: this.options.userAgent, signal,
        timeoutMs: Math.max(1, Math.min(10_000, Math.floor(remainingMs / 4))) });
      const current = { id, count: 0 };
      this.#current = current;
      // A failed request is not kept: the next lookup asks again.
      id.catch(() => { if (this.#current === current) this.#current = null; });
    }
    try { return await this.#current.id; } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ChallengeError || (error instanceof TransportError && (error.status === 404 || error.status === 410))) return null;
      throw error;
    }
  }

  #remember(number: string, id: string): void {
    this.#added.delete(number);
    this.#added.set(number, id);
    while (this.#added.size > MAX_REMEMBERED) this.#added.delete(this.#added.keys().next().value!);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMagyarPostaNumber(raw);
    const trawl = this.options.trawl;
    // Adding a number needs a solved widget, which only the browser service provides.
    if (!trawl) throw new ChallengeError(PROVIDER, 'Magyar Posta requires the browser tracking service');
    const held = this.#added.get(number);
    return runSteps({ carrier: 'magyar-posta', budgetMs: context.budgetMs ?? 45_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      // A number added before is read again without a token.
      { id: 'app', enabled: held !== undefined, run: async ({ signal, remainingMs }) => {
        const result = await readMagyarPostaApp(number, held!, { fetcher: this.options.fetcher, userAgent: this.options.userAgent,
          signal, timeoutMs: Math.max(1, Math.min(10_000, Math.floor(remainingMs / 4))) });
        if (result) return result;
        this.#added.delete(number);
        throw new ChallengeError(PROVIDER, 'Magyar Posta\'s app no longer holds the number');
      } },
      { id: 'trawl', run: async ({ signal, remainingMs }) => {
        const started = Date.now();
        // The app's widget adds the number; the tracker's checkbox serves while the app's API refuses its key.
        const id = await this.#applicationId(signal, remainingMs);
        const route = id ? 'app' : 'web';
        // Another solve soon after a refusal would hold a browser for the same answer.
        if (Date.now() < this.#refusedUntil[route] && !(route === 'app' && this.#registrationCache)) {
          throw new ChallengeError(PROVIDER, 'Google refused Magyar Posta\'s audio challenge recently', { reason: 'verification_refused' });
        }
        if (id && (this.#unadded.get(number) ?? 0) > Date.now()) {
          throw new IndeterminateError(PROVIDER, 'Magyar Posta\'s app did not add the number recently');
        }
        this.#unadded.delete(number);
        const left = remainingMs - (Date.now() - started);
        try {
          if (!id) return await magyarPostaBrowser(trawl, number, signal, left);
          const current = this.#current;
          let added = false;
          const result = await magyarPostaAppBrowser(trawl, number, id, signal, left,
            () => { added = true; }, () => { this.#registrationCache = true; });
          if (added) {
            if (current && this.#current === current) current.count++;
            this.#remember(number, id);
          }
          return result;
        } catch (error) {
          if (error instanceof ChallengeError && error.reason === 'verification_refused') this.#refusedUntil[route] = Date.now() + REFUSAL_MEMORY_MS;
          if (error instanceof UnaddedError) {
            this.#unadded.set(number, Date.now() + UNADDED_MEMORY_MS);
            while (this.#unadded.size > MAX_REMEMBERED) this.#unadded.delete(this.#unadded.keys().next().value!);
          }
          throw error;
        }
      } },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MagyarPostaTracker({ trawl: environment.trawl, fetcher: environment.fetcher, userAgent: environment.userAgent,
    recorder: environment.recorder });
  return { id: 'magyar-posta', recordsSteps: true, steps: ['app', 'trawl'], track: (input, context) => tracker.fetch(input.number, context),
    recognizeWithBrowser: (number, context) => recognizeFromBrowserLookup(() => tracker.fetch(number, context)) };
};
