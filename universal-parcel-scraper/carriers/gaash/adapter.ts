import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { GAASH_MAX_BYTES, normalizeGaashNumber, parseGaash, PROVIDER } from './parser.js';

const ORIGIN = 'https://gaashwd.com';
/** The tracking page, which gives every visitor the WordPress nonce its lookups send. */
export const GAASH_PAGE = `${ORIGIN}/track-parcel/`;
/** The tracking page's WordPress routes: `parcel-tracking-data` for the scans, `parcel-status-data` for the status. */
export const GAASH_API = `${ORIGIN}/wp-json/gaash-parcel-status-tracker/v1`;
const ROUTES = ['parcel-tracking-data', 'parcel-status-data'] as const;
// WordPress gives visitors without an account one nonce for at least twelve hours; it is read again after an hour.
const NONCE_KEPT_MS = 60 * 60_000;
const PAGE_MAX_BYTES = 1024 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker's settings in the page, up to their nonce.
const PAGE_NONCE = /parcelStatusTrackerData\s*=\s*\{[^<]{0,2000}?"nonce"\s*:\s*"([0-9a-f]{6,32})"/;
// WordPress's answers to a missing or expired nonce.
const REFUSED_NONCE = new Set(['rest_forbidden', 'rest_cookie_invalid_nonce']);
// What a route gives back for a nonce WordPress refuses.
const REFUSED = Symbol('refused nonce');
// Bot checks Cloudflare, in front of the site, could put in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GAASH answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'GAASH returned a reply that is not JSON', { cause });
  }
}

/** The JSON body of a reply, or undefined when it is not JSON. */
function jsonOrNothing(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** The `code` of a WordPress error reply. */
const errorCode = (body: string) => {
  const payload = jsonOrNothing(body);
  return isRecord(payload) && typeof payload.code === 'string' ? payload.code : undefined;
};

export class GaashTracker {
  #nonce: { value: string; readAt: number } | undefined;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGaashNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const kept = this.#keptNonce();
      const nonce = kept ?? await this.#pageNonce(signal, left());
      let replies = await this.#lookup(number, nonce, signal, left());
      if (!replies && kept) {
        // A kept nonce may have expired: the page gives the current one.
        const current = await this.#pageNonce(signal, left());
        if (current !== kept) replies = await this.#lookup(number, current, signal, left());
      }
      if (!replies) throw new SchemaError(PROVIDER, 'GAASH refused its tracking page\'s nonce');
      return parseGaash(replies.tracking, replies.status, number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'gaash', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  /** Both replies for the number, asked together as the page does, or null when the nonce is refused. */
  async #lookup(number: string, nonce: string, signal: AbortSignal, timeoutMs: number): Promise<{ tracking: unknown; status: unknown } | null> {
    const query = new URLSearchParams({ parcel_id: number, lang: 'en' });
    const [tracking, status] = await Promise.all(ROUTES.map((route) => this.#route(route, query, nonce, signal, timeoutMs)));
    return tracking === REFUSED || status === REFUSED ? null : { tracking, status };
  }

  async #route(route: string, query: URLSearchParams, nonce: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(`${GAASH_API}/${route}?${query}`, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'X-WP-Nonce': nonce, 'Cache-Control': 'no-cache', Pragma: 'no-cache',
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: GAASH_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'GAASH redirected its tracking lookup');
    const body = decodeText(bytes);
    if (response.status === 401 || response.status === 403) {
      if (REFUSED_NONCE.has(errorCode(body) ?? '')) return REFUSED;
      throw new ChallengeError(PROVIDER, 'GAASH refused the lookup', { status: response.status });
    }
    // An unknown number is the status route's HTTP 404 with `no_data`; another 404 is a moved route.
    if (response.status === 404 || response.status === 410) {
      if (response.status === 404 && errorCode(body) === 'no_data') return json(body);
      throw new TransportError(PROVIDER, 'GAASH tracking lookup is unavailable', { status: response.status });
    }
    return json(body);
  }

  #keptNonce(): string | undefined {
    const now = (this.options.now ?? Date.now)();
    return this.#nonce && now - this.#nonce.readAt < NONCE_KEPT_MS ? this.#nonce.value : undefined;
  }

  /** The nonce the tracking page gives now. */
  async #pageNonce(signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(GAASH_PAGE, { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: PAGE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'GAASH\'s tracking page is unavailable', { status: response.status });
    const page = decodeText(bytes);
    const nonce = PAGE_NONCE.exec(page)?.[1];
    if (nonce) {
      this.#nonce = { value: nonce, readAt: (this.options.now ?? Date.now)() };
      return nonce;
    }
    if (CHALLENGE.test(page.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GAASH answered its tracking page with a browser check');
    throw new SchemaError(PROVIDER, 'GAASH\'s tracking page no longer gives its nonce');
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GaashTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gaash', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGaashNumber(number))),
  };
};
