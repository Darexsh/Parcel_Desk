import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeStarkenNumber, parseStarken, PROVIDER, STARKEN_MAX_BYTES, starkenMissing } from './parser.js';

/** The tracking service the tracking page on starken.cl calls. */
export const STARKEN_API = 'https://seguimientoof.starken.cl/seguimientoOf/statusOf';
const ORIGIN = 'https://www.starken.cl';
// The source name, key and passphrases the tracking page's script gives every visitor, the same for all.
const SOURCE = 'STARKENCL';
const API_KEY = 'pgkTGxq3uy3Y6c@JfXRvk1kTfVMBaRlu'; // gitleaks:allow
export const STARKEN_TOKEN_PASSPHRASE = 'ZzOCt5kQ@m'; // gitleaks:allow
export const STARKEN_REPLY_PASSPHRASE = 'J@fbP&Z+Vk1n'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
const REFUSED = 401;
const MISSING = 404;
// The service's servers disagree on the time, so one can refuse a key another
// minted a moment before as expired. A refused key is asked with once more,
// then a new key twice.
const KEYS = 2;
const ASKS_PER_KEY = 2;
const KEY_MAX_BYTES = 16 * 1024;
// A sealed text: OpenSSL's salted format, in base64.
const SEALED = /^U2FsdGVkX1[A-Za-z0-9+/]+={0,2}$/;
// Bot checks and block pages a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|_Incapsula_Resource|AwsWafIntegration|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;

/** The key and IV OpenSSL's `EVP_BytesToKey` derives from a passphrase with MD5, as CryptoJS does. */
function derive(passphrase: string, salt: Uint8Array): { key: Buffer; iv: Buffer } {
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  while (blocks.length < 3) {
    previous = createHash('md5').update(Buffer.concat([previous, Buffer.from(passphrase, 'utf8'), salt])).digest();
    blocks.push(previous);
  }
  const material = Buffer.concat(blocks);
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

/** `CryptoJS.AES.encrypt(text, passphrase)`: AES-256-CBC under a salted passphrase, as `Salted__`, the salt and the ciphertext in base64. */
export function starkenSeal(text: string, passphrase: string, salt: Uint8Array = randomBytes(8)): string {
  const { key, iv } = derive(passphrase, salt);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

/** The text a sealed reply holds; a reply that does not open is a changed reply. */
export function starkenOpen(sealed: string, passphrase: string): string {
  const bytes = Buffer.from(sealed, 'base64');
  try {
    const { key, iv } = derive(passphrase, bytes.subarray(8, 16));
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8');
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Starken returned a reply that does not open', { cause });
  }
}

/**
 * The token the page asks a key with: its source, the clock, the shared key
 * and the order, sealed. The page sends the visitor's wall clock; the service
 * takes any zone's, and this sends UTC.
 */
export function starkenToken(number: string, now = new Date()): string {
  const clock = now.toISOString().slice(0, 19).replace('T', ' ');
  return starkenSeal(`${SOURCE}|${clock}|${API_KEY}|${number}`, STARKEN_TOKEN_PASSPHRASE);
}

function json(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Starken answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, `Starken returned a ${what} that is not JSON`, { cause });
  }
}

export class StarkenTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private headers(apiKey: string): Record<string, string> {
    // The service refuses a key asked for or used without the page's origin.
    return { Accept: 'application/json, text/plain, */*', Apikey: apiKey, Origen: 'CL', Origin: ORIGIN,
      'User-Agent': userAgentOf(this.options.userAgent) };
  }

  /** A key for one order, which the service mints for the page's sealed token. */
  private async key(number: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const token = starkenToken(number);
    const { response, bytes } = await fetchBounded(`${STARKEN_API}/gettoken`, { method: 'POST', signal,
      headers: { ...this.headers(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) },
    { provider: PROVIDER, timeoutMs, maxBytes: KEY_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, REFUSED, MISSING] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Starken moved its tracking service');
    if (response.status === MISSING) throw new TransportError(PROVIDER, 'Starken tracking service is unavailable');
    if (response.status === REFUSED) {
      throw new IndeterminateError(PROVIDER, 'Starken refused the tracking page\'s token', { reason: 'session_rejected' });
    }
    const reply = json(decodeText(bytes), 'key');
    const key = isRecord(reply) ? reply.payload : undefined;
    if (typeof key !== 'string' || !SEALED.test(key)) throw new SchemaError(PROVIDER, 'Starken returned no tracking key');
    return key;
  }

  /** The order's history under a key, or the service's refusal of the key. */
  private async history(number: string, key: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult | typeof REFUSED> {
    const { response, bytes } = await fetchBounded(`${STARKEN_API}/historialClOfs/${number}`, { method: 'GET', signal,
      headers: this.headers(key) }, { provider: PROVIDER, timeoutMs, maxBytes: STARKEN_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, REFUSED, MISSING] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Starken moved its tracking service');
    if (response.status === REFUSED) return REFUSED;
    const body = decodeText(bytes).trim();
    if (response.status === MISSING) {
      if (!body.startsWith('{')) throw new TransportError(PROVIDER, 'Starken tracking service is unavailable');
      return starkenMissing(json(body, 'missing-order reply'));
    }
    // The history comes sealed, as text; anything else is a block page or a changed reply.
    if (!SEALED.test(body)) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Starken answered with a browser check');
      throw new SchemaError(PROVIDER, 'Starken returned a history that is not sealed');
    }
    return parseStarken(json(starkenOpen(body, STARKEN_REPLY_PASSPHRASE), 'history'), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeStarkenNumber(raw);
    const read = async (signal: AbortSignal, remainingMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + remainingMs;
      const left = () => Math.max(1, Math.floor(deadline - Date.now()));
      for (let round = 0; round < KEYS; round += 1) {
        const key = await this.key(number, signal, left());
        for (let ask = 0; ask < ASKS_PER_KEY; ask += 1) {
          const answer = await this.history(number, key, signal, left());
          if (answer !== REFUSED) return answer;
        }
      }
      throw new IndeterminateError(PROVIDER, 'Starken refused its own tracking keys', { reason: 'session_rejected' });
    };
    return runSteps({ carrier: 'starken', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new StarkenTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // No recognition: Starken numbers its orders in sequence, so nearly any nine digits are some order of its.
  return {
    id: 'starken', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
