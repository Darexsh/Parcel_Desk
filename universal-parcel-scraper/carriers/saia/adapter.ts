import { createCipheriv, randomBytes } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isSaiaNotFound, normalizeSaiaRecognitionNumber, parseSaia, PROVIDER, SAIA_MAX_BYTES, SAIA_ORIGIN, saiaPro } from './parser.js';

/** The tracking service of Saia's own tracker. */
export const SAIA_API = `${SAIA_ORIGIN}/api/v1/tracking`;
// The key and cipher key the tracker's script gives every visitor, the same for all.
export const SAIA_API_KEY = '78f81adca28e1fcbae96d3e75cecb645'; // gitleaks:allow
export const SAIA_CIPHER_KEY = 'Xn2r5u8x/A?D(G+KbPdSgVkYp3s6v9y$'; // gitleaks:allow
const XSRF_COOKIE = 'tracking-xsrf-token';
const REDIRECTS = [301, 302, 303, 307, 308];
// The service's refusal of a session, its answer for an unknown PRO, the
// firewall's block page and the CDN's failure to reach Saia's servers.
const REFUSED = 401;
const UNKNOWN = 422;
const BLOCKED = 403;
const ORIGIN_UNREACHABLE = 530;
// A challenge or block page, which can come instead of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;
const COOKIE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const COOKIE_VALUE = /^[^\s;,]{1,4096}$/;
const MAX_COOKIES = 20;

/**
 * The PRO as the tracker sends it: AES-256-CBC under the tracker's key with a
 * random IV, then `base64(encodeURIComponent(base64(ciphertext)) + ':' +
 * encodeURIComponent(base64(iv)))`.
 */
export function saiaEncryptedPro(pro: string, iv: Uint8Array = randomBytes(16)): string {
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(SAIA_CIPHER_KEY, 'utf8'), iv);
  const sealed = Buffer.concat([cipher.update(pro, 'utf8'), cipher.final()]);
  const pair = `${encodeURIComponent(sealed.toString('base64'))}:${encodeURIComponent(Buffer.from(iv).toString('base64'))}`;
  return Buffer.from(pair, 'latin1').toString('base64');
}

/** The cookies the session read sets: its XSRF token and the edge's and load balancer's cookies. */
function sessionCookies(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const header of response.headers.getSetCookie().slice(0, MAX_COOKIES)) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (separator > 0 && COOKIE_NAME.test(name) && COOKIE_VALUE.test(value)) jar.set(name, value);
  }
  return jar;
}

/**
 * The same failure without the request and response details fetchBounded
 * attaches: they hold the session's cookies and XSRF token.
 */
function withoutSession(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Saia answered with a browser challenge', { cause: error });
    throw new SchemaError(PROVIDER, 'Saia returned a reply that is not JSON', { cause: error });
  }
}

/** A failure the edge states whatever the body says. */
function edgeFailure(response: Response): Error | null {
  if (REDIRECTS.includes(response.status)) return new IndeterminateError(PROVIDER, 'Saia moved its tracking service');
  // Saia's firewall blocks clients it takes for scripts with a block page.
  if (response.status === BLOCKED) return new ChallengeError(PROVIDER, 'Saia’s firewall refused the request');
  // Cloudflare could not reach Saia's servers (error 1016): the request did not reach Saia.
  if (response.status === ORIGIN_UNREACHABLE) return new UpstreamNetworkError(PROVIDER, new Error('Cloudflare could not reach Saia'));
  return null;
}

export class SaiaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const pro = saiaPro(raw);
    // One attempt opens a tracking session, which sets the XSRF cookie the
    // service checks, and asks for the shipment's details with it.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json' };
      const read = (url: string, init: RequestInit) => fetchBounded(url, { ...init, method: 'GET', signal }, { provider: PROVIDER,
        timeoutMs: left(), maxBytes: SAIA_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, REFUSED, UNKNOWN, BLOCKED, ORIGIN_UNREACHABLE], fetcher: this.options.fetcher });
      try {
        const surf = await read(`${SAIA_API}/surf`, { headers });
        const failure = edgeFailure(surf.response);
        if (failure) throw failure;
        if (surf.response.status !== 200) throw new IndeterminateError(PROVIDER, 'Saia did not open a tracking session');
        const jar = sessionCookies(surf.response);
        const xsrf = jar.get(XSRF_COOKIE);
        if (!xsrf) throw new IndeterminateError(PROVIDER, 'Saia did not open a tracking session', { reason: 'session_rejected' });
        signal.throwIfAborted();
        const details = await read(`${SAIA_API}/find-full-details?proNumber=${saiaEncryptedPro(pro)}`, { headers: { ...headers,
          Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), 'XSRF-TOKEN': xsrf, 'X-API-KEY': SAIA_API_KEY } });
        const refused = edgeFailure(details.response);
        if (refused) throw refused;
        const body = decodeText(details.bytes);
        if (details.response.status === REFUSED) {
          throw new IndeterminateError(PROVIDER, 'Saia refused the tracking session', { reason: 'session_rejected' });
        }
        if (details.response.status === UNKNOWN) {
          if (isSaiaNotFound(json(body), pro)) throw new NotFoundError(PROVIDER);
          throw new IndeterminateError(PROVIDER, 'Saia did not complete the lookup');
        }
        return parseSaia(json(body), raw);
      } catch (error) {
        throw withoutSession(error);
      }
    };
    // An attempt that fails to reach Saia, or hangs, gets one more in a new
    // session: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'saia', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SaiaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'saia', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // A twelve-digit number is answered for its first eleven digits, which do not bind it.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSaiaRecognitionNumber(number))),
  };
};
