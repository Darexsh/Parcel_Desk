import { createCipheriv, createDecipheriv, createHash, pbkdf2, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { normalizeSkypostalNumber, PROVIDER, readSkypostal, SKYPOSTAL_MAX_BYTES, skypostalSummaryNames } from './parser.js';

/** The gateway the tracking page on tracking.skypostal.com sends its sealed lookups to. */
export const SKYPOSTAL_API = 'https://gtw.skypostal.com/api/secure';
// The passphrase the page's script seals every lookup and opens every reply with.
const PAYLOAD_PASSPHRASE = 'c5f033ba89ea2871ae61b2e72b7a4e3693a9080f0ae1b6bbc3c3a6ec3328cdf4'; // gitleaks:allow
// The guest account the page's script names in every lookup, the same for every visitor.
const USER_CODE = '1897';
const USER_KEY = 'aV9Oas6dQJ2PKZ0ROvg0jAEYFvtK65'; // gitleaks:allow
// The address the page reports when its server gave it none.
const CLIENT_ADDRESS = '127.0.0.1';
const PBKDF2_ROUNDS = 100_000;
const REDIRECTS = [301, 302, 303, 307, 308];
// The gateway's own refusal of a request it cannot read, as opposed to a firewall's page.
const GATEWAY_REFUSAL = /^\s*\{\s*"statusCode"\s*:\s*403\b/;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|captcha/i;
const SEALED = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/;

const derive = promisify(pbkdf2);

/** `work`, for as long as the lookup is live: key derivation runs off the event loop and cannot be stopped, so an ended lookup stops waiting for it. */
async function whileLive<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let leave!: () => void;
  const left = new Promise<never>((_resolve, reject) => { leave = () => reject(signal.reason); });
  signal.addEventListener('abort', leave, { once: true });
  try {
    return await Promise.race([work, left]);
  } finally {
    signal.removeEventListener('abort', leave);
  }
}

interface SealingKey { readonly salt: Buffer; readonly key: Buffer }

async function sealingKey(passphrase: string): Promise<SealingKey> {
  const salt = randomBytes(16);
  return { salt, key: await derive(passphrase, salt, PBKDF2_ROUNDS, 32, 'sha256') };
}

/** One text sealed under a key, with an IV of its own, as `salt.iv.ciphertext.tag` in unpadded base64url. */
function sealWith({ salt, key }: SealingKey, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [salt, iv, sealed, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
}

/** A text sealed as the page does: AES-256-GCM under a key PBKDF2 derives from the passphrase and a random salt. */
export async function sealSkypostalText(plain: string, passphrase = PAYLOAD_PASSPHRASE): Promise<string> {
  return sealWith(await sealingKey(passphrase), plain);
}

/** The text behind `sealSkypostalText`; throws on anything else. */
export async function openSkypostalText(sealed: string, passphrase = PAYLOAD_PASSPHRASE): Promise<string> {
  if (sealed.length > 4 * SKYPOSTAL_MAX_BYTES || !SEALED.test(sealed)) throw new TypeError('SkyPostal sealed text is four base64url parts');
  const [salt, iv, body, tag] = sealed.split('.').map((part) => Buffer.from(part, 'base64url')) as [Buffer, Buffer, Buffer, Buffer];
  if (salt.length < 8 || salt.length > 64 || iv.length !== 12 || tag.length !== 16) throw new TypeError('SkyPostal sealed text has invalid parts');
  const decipher = createDecipheriv('aes-256-gcm', await derive(passphrase, salt, PBKDF2_ROUNDS, 32, 'sha256'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * The headers and body the page sends for one action: a fresh visitor id,
 * the visitor's details and the guest account sealed under the first half of
 * the id's MD5, and the lookup sealed under the page's passphrase. The page
 * draws a salt for each sealed field; one salt per request, with an IV per
 * field, opens the same way and derives one key instead of five.
 */
export async function skypostalRequest(action: string, search: string | readonly string[], now = new Date()):
  Promise<{ headers: Record<string, string>; body: string }> {
  const guid = randomUUID();
  const visitor = await sealingKey(createHash('md5').update(guid).digest('hex').slice(0, 16));
  const lookup = { action, userInfo: { userCode: sealWith(visitor, USER_CODE), userKey: sealWith(visitor, USER_KEY), appKey: sealWith(visitor, USER_KEY) },
    trackingSearch: search, lngCode: 'ENG' };
  return {
    headers: { 'x-guid': guid, 'x-skpdata': sealWith(visitor, `${guid}|${now.toISOString()}|${CLIENT_ADDRESS}`), 'x-sdata': sealWith(visitor, CLIENT_ADDRESS) },
    body: JSON.stringify({ payload: await sealSkypostalText(JSON.stringify(lookup)) }),
  };
}

export class SkypostalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** One sealed action through the gateway, and its opened reply. */
  private async ask(action: string, search: string | readonly string[], signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { headers, body } = await whileLive(skypostalRequest(action, search), signal);
    const { response, bytes } = await fetchBounded(SKYPOSTAL_API, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent), ...headers,
    }, body }, { provider: PROVIDER, timeoutMs, maxBytes: SKYPOSTAL_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'SkyPostal redirected its tracking lookup');
    // The page reads a missing parcel from a 200 reply; a 404 is a moved route.
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'SkyPostal tracking lookup is unavailable');
    const text = decodeText(bytes);
    if (response.status === 403) {
      if (GATEWAY_REFUSAL.test(text.slice(0, 2_000))) {
        throw new SchemaError(PROVIDER, 'SkyPostal refused the lookup as no longer sealed the way its page seals it', { status: 403 });
      }
      throw new ChallengeError(PROVIDER, 'SkyPostal refused the lookup', { status: 403 });
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch (cause) {
      if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SkyPostal answered with a browser check', { cause });
      throw new SchemaError(PROVIDER, 'SkyPostal returned a reply that is not JSON', { cause });
    }
    const sealed = isRecord(envelope) ? envelope.payload : undefined;
    if (typeof sealed !== 'string') throw new SchemaError(PROVIDER, 'SkyPostal returned a reply without its sealed payload');
    const opened = await whileLive(openSkypostalText(sealed).catch((cause: unknown) => {
      throw new SchemaError(PROVIDER, 'SkyPostal returned a payload it did not seal as expected', { cause });
    }), signal);
    try {
      return JSON.parse(opened);
    } catch (cause) {
      throw new SchemaError(PROVIDER, 'SkyPostal sealed a reply that is not JSON', { cause });
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSkypostalNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - Date.now()));
      const reading = readSkypostal(await this.ask('asyncSingleTracking', number, signal, left()), number);
      if (reading.named) return reading.result;
      // Scans so far carry only SkyPostal's own label: the page's summary view
      // names the shipment's external number. It takes several seconds.
      if (skypostalSummaryNames(await this.ask('shipmentSearchMultipleSkp', [number], signal, left()), number, reading.waybill)) {
        return reading.result;
      }
      throw new IndeterminateError(PROVIDER, 'SkyPostal answered for another shipment');
    };
    return runSteps({ carrier: 'skypostal', budgetMs: context.budgetMs ?? 30_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SkypostalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'skypostal', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSkypostalNumber(number))),
  };
};
