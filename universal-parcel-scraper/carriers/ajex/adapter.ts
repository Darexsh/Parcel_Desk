import { createCipheriv, createDecipheriv } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { AJEX_MAX_BYTES, normalizeAjexNumber, parseAjex, PROVIDER } from './parser.js';

const API = 'https://apps.aj-ex.com/customer-portal/api/v1/';
/** Where the site exchanges its visitor key for a short-lived bearer token. */
export const AJEX_LOGIN_API = `${API}ajex/login`;
/** The lookup the shipment-status page on aj-ex.com makes for the number in its address. */
export const AJEX_TRACK_API = `${API}shipments/trackAjexShipments`;
/**
 * The visitor key the site's script sends every visitor's browser to log in
 * with: the word `ajexsitevisitor`, encrypted with a key in the script.
 */
export const AJEX_VISITOR_KEY = 'n/Lp2Q89JLlMl9Wi85BpQQ=='; // gitleaks:allow
// The AES key and IV in the site's script that encrypt the number asked and decrypt the reply.
const CIPHER_KEY = Buffer.from('o8HouGu8excfM5S5', 'utf8'); // gitleaks:allow
const CIPHER_IV = Buffer.from('gxNG083m7XvV3ael', 'utf8'); // gitleaks:allow
// The account the page names in every lookup.
const ACCOUNT = 'AJ47';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const MAX_TOKEN_LENGTH = 4096;
// A token is reused until a minute before it expires.
const TOKEN_MARGIN_MS = 60_000;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|captcha|<title>\s*Access Denied/i;
const CIPHERTEXT = /^[A-Za-z0-9_-]+={0,2}$/;

/** A text encrypted as the page does: AES-128-CBC with its key and IV, in unpadded base64url. */
export function encryptAjexText(plain: string): string {
  const cipher = createCipheriv('aes-128-cbc', CIPHER_KEY, CIPHER_IV);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64url');
}

/** The text behind `encryptAjexText`; throws on anything else. */
export function decryptAjexText(sealed: string): string {
  if (!CIPHERTEXT.test(sealed)) throw new TypeError('AJEX ciphertext is base64url');
  const decipher = createDecipheriv('aes-128-cbc', CIPHER_KEY, CIPHER_IV);
  return Buffer.concat([decipher.update(Buffer.from(sealed, 'base64url')), decipher.final()]).toString('utf8');
}

/** The reply's JSON, which the service sends encrypted as base64url text. */
export function decryptAjexReply(body: string): unknown {
  try {
    return JSON.parse(decryptAjexText(body.trim()));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'AJEX answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'AJEX returned a reply it did not encrypt as expected', { cause });
  }
}

/** When a JWT expires, from its `exp` claim; null when it names none. */
function expiresAt(token: string): number | null {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    const exp = isRecord(claims) ? claims.exp : undefined;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

interface Token {
  readonly value: string;
  readonly reusableUntil: number;
}

export class AjexTracker {
  private token: Token | undefined;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private headers(): Record<string, string> {
    return { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) };
  }

  /** The site's visitor login: a bearer token for twenty minutes, the same for anyone who asks. */
  private async login(signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(AJEX_LOGIN_API, { method: 'POST', signal, headers: this.headers(),
      body: JSON.stringify({ token: AJEX_VISITOR_KEY }) }, { provider: PROVIDER, timeoutMs, maxBytes: 16 * 1024, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'AJEX visitor login is unavailable', { status: response.status });
    }
    const body = decodeText(bytes);
    let reply: unknown;
    try {
      reply = JSON.parse(body);
    } catch (cause) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'AJEX answered with a browser check', { cause });
      throw new SchemaError(PROVIDER, 'AJEX visitor login returned a reply that is not JSON', { cause });
    }
    // A key the service no longer takes gets HTTP 200 without a token.
    const value = isRecord(reply) ? reply.accessToken : undefined;
    if (typeof value !== 'string' || !value || value.length > MAX_TOKEN_LENGTH || /\s/.test(value)) {
      throw new SchemaError(PROVIDER, 'AJEX visitor login gave no token');
    }
    const expires = expiresAt(value);
    this.token = expires === null ? undefined : { value, reusableUntil: expires - TOKEN_MARGIN_MS };
    return value;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAjexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - Date.now()));
      const lookup = async (token: string) => fetchBounded(AJEX_TRACK_API, { method: 'POST', signal,
        headers: { ...this.headers(), Authorization: `Bearer ${token}` },
        body: JSON.stringify({ customerAccount: ACCOUNT, waybillList: [encryptAjexText(number)], pageNumber: 1, lang: 'en' }) },
      { provider: PROVIDER, timeoutMs: left(), maxBytes: AJEX_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, ...GONE, 401] });
      const cached = this.token && this.token.reusableUntil > this.now() ? this.token.value : undefined;
      let reply = await lookup(cached ?? await this.login(signal, left()));
      // A reused token the service has dropped is replaced once.
      if (reply.response.status === 401 && cached) {
        this.token = undefined;
        reply = await lookup(await this.login(signal, left()));
      }
      const { response, bytes } = reply;
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'AJEX tracking lookup is unavailable', { status: response.status });
      }
      if (response.status === 401) {
        this.token = undefined;
        throw new ChallengeError(PROVIDER, 'AJEX refused its own visitor token', { status: 401 });
      }
      return parseAjex(decryptAjexReply(decodeText(bytes)), number);
    };
    // A lookup that fails to reach AJEX, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: 'ajex', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AjexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ajex', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAjexNumber(number))),
  };
};
