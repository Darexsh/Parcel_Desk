import { constants, createPublicKey, publicEncrypt } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ANJUN_MAX_BYTES, normalizeAnjunNumber, parseAnjun, PROVIDER } from './parser.js';

/** The lookup the tracking page on anjuntrack.com makes for each number it shows. */
export const ANJUN_API = 'https://trackserver.bailidaming.com/open/website/track';
/** The RSA public key in the page's script, the same for every visitor, that its `token` header is encrypted with. */
export const ANJUN_TOKEN_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDMpkV/EUX35Lp57YaAJ34DTc7nKfDjzCX/vjAdqI57CQadoMDBzn+BbKkLEbG45D52I1ko2gLMEA/rpY/qQw1+4mvivBAl68q3SUd/c9HnqhZjKGd/fcsLnebMDns0ZeG331q0rNEmwhZB4gGwjzNMLQ1nVt1YSQLosgV4t08P0wIDAQAB'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Bot checks the SafeLine firewall in front of the service, or a CDN, could put in place of the reply.
const CHALLENGE = /safeline|已被拦截|_cf_chl_opt|cf-turnstile|<title>\s*Just a moment/i;
const BEIJING_MS = 8 * 60 * 60_000;

const tokenKey = createPublicKey({ key: Buffer.from(ANJUN_TOKEN_KEY, 'base64'), format: 'der', type: 'spki' });

/** The time in Beijing, as the token carries it: `yyyy-MM-dd HH:mm:ss`. */
export function anjunClock(now: number): string {
  return new Date(now + BEIJING_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The page's `token` header: the time in Beijing, encrypted with the page's
 * key and padding in base64. The service refuses a token more than a few
 * minutes off its own clock.
 */
export function anjunToken(now = Date.now()): string {
  return publicEncrypt({ key: tokenKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(anjunClock(now))).toString('base64');
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Anjun answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Anjun returned a reply that is not JSON', { cause });
  }
}

export class AnjunTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAnjunNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${ANJUN_API}?trackNo=${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', token: anjunToken(this.options.now?.()), 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ANJUN_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Anjun tracking lookup is unavailable', { status: response.status });
      }
      // An empty 403 refuses the token: a host clock minutes off, or a key the page no longer uses.
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Anjun refused the lookup', { status: 403 });
      return parseAnjun(json(decodeText(bytes)), number);
    };
    // A lookup that fails to reach Anjun, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: 'anjun', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AnjunTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'anjun', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAnjunNumber(number))),
  };
};
