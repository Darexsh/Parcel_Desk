import { constants, createHash, createPublicKey, publicEncrypt, type KeyObject } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { errorTypeOf, NOOP_RECORDER, outcomeOf, safeRecorder, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CainiaoTracker } from '../aliexpress/adapter.js';
import { CAINIAO, cainiaoScans, withCainiaoLeg } from './cainiao.js';
import { IMILE_MAX_BYTES, normalizeImileNumber, parseImile, PROVIDER } from './parser.js';

const ORIGIN = 'https://www.imile.com';
/** The lookup the tracking page on www.imile.com makes for the number in its address. */
export const IMILE_API = `${ORIGIN}/saastms/mobileWeb/track/query`;
/** The tracking page, whose script holds the values it signs a lookup with. */
export const IMILE_PAGE = `${ORIGIN}/AE-en/track`;

/** How the page signs a lookup: the RSA public key the `sign` header encrypts the number with, and the salt of the MD5 `code`. */
export interface ImileSigning {
  key: string;
  salt: string;
}

/** The values in the page's script, the same for every visitor. */
export const IMILE_SIGNING: Readonly<ImileSigning> = {
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3dFPiKNZwt+HoBbPAG/t7kZC2k3pBX2eCl5LeyeW8woNuEV5bA5kB9Y9KKTOQng62ERGPLwi84CdIB8s265ljQUib//iO3jVrZesJueO5Xu+s80s3Z/89jgJleT1XawN1GubgkGXOoT1a7tvX8+aItkGgR//48ELqJVVUL+yGsBtXxFjNmOEWxBJNQuwAf9yWcCIl1enD60GjZjPWrsfw8QUqam7K5e45ealcPEYGenNePwuPpCq6twdD0YYYzKdRN0dZP1uTviFpNfph90c9YgQ8kgDkRMcpjVv6KZ+bg5JZ4sK6LkV4vwOjPijisthHBvUXhu3fyhMgvoDO/j5gwIDAQAB', // gitleaks:allow
  salt: 'imileTrackQuery2024', // gitleaks:allow
};

// How long the page's values stand once read: an empty reply in that time is an unknown number.
const SIGNING_CHECKED_MS = 60 * 60_000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
// The page's own script, by the route it serves; its name changes with every deploy.
const TRACK_SCRIPT = /\/_next\/static\/chunks\/pages\/(?:%5B|\[)countryAndLang(?:%5D|\])\/track-[\w-]+\.js/;
const SCRIPT_KEY = /setPublicKey\("([A-Za-z0-9+/]{200,1000}={0,2})"\)/;
const SCRIPT_SALT = /\.MD5\(""\.concat\([\w$]+,"([\w-]{1,64})"\)\)/;
// Bot checks Cloudflare, in front of the site, could put in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;
const DEFAULT_BUDGET_MS = 20_000;
// Cainiao answers within a second or two; it gets half of what iMile left, at most this.
const CAINIAO_MS = 8_000;
// Less than this left for Cainiao is no time for a request.
const CAINIAO_MIN_MS = 250;

function publicKey(key: string): KeyObject {
  return createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
}

/** The page's `code` and `sign` for a number: the MD5 of the number and the salt, and the number encrypted with the key. */
export function imileSignature(number: string, signing: ImileSigning): { code: string; sign: string } {
  return {
    code: createHash('md5').update(`${number}${signing.salt}`).digest('hex'),
    sign: publicEncrypt({ key: publicKey(signing.key), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(number)).toString('base64'),
  };
}

/** The signing values in the tracking page's script; a script without them is a changed page. */
export function scriptSigning(script: string): ImileSigning {
  const key = SCRIPT_KEY.exec(script)?.[1];
  const salt = SCRIPT_SALT.exec(script)?.[1];
  if (!key || !salt || !script.includes('/saastms/mobileWeb/track/query')) {
    throw new SchemaError(PROVIDER, 'iMile\'s tracking script no longer shows how it signs a lookup');
  }
  try {
    publicKey(key);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'iMile\'s tracking script holds an unreadable key', { cause });
  }
  return { key, salt };
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'iMile answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'iMile returned a reply that is not JSON', { cause });
  }
}

export class ImileTracker {
  #signing: Readonly<ImileSigning>;
  // When the page last showed the values in use.
  #checkedAt = Number.NEGATIVE_INFINITY;
  readonly #cainiao: CainiaoTracker;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number;
    signing?: Readonly<ImileSigning> } = {}) {
    this.#signing = options.signing ?? IMILE_SIGNING;
    this.#cainiao = new CainiaoTracker({ fetcher: options.fetcher, userAgent: options.userAgent, timeoutMs: CAINIAO_MS });
  }

  /**
   * iMile's answer, with Cainiao's leg in front of its history unless
   * `cainiao` is false. Cainiao is asked only once iMile has answered with
   * scans, and its failure leaves iMile's answer as it is.
   */
  async fetch(raw: string, context: TrackingContext = {}, { cainiao = true }: { cainiao?: boolean } = {}): Promise<CarrierResult> {
    const number = normalizeImileNumber(raw);
    const started = performance.now();
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    let attempts = 0;
    const result = await this.#imile(number, { signal: context.signal, budgetMs }, (attempt) => { attempts = attempt; });
    if (!cainiao) return result;
    return this.#withCainiao(number, result, context.signal, budgetMs - (performance.now() - started), attempts + 1);
  }

  async #imile(number: string, context: Required<Pick<TrackingContext, 'budgetMs'>> & TrackingContext,
    attempted: (attempt: number) => void): Promise<CarrierResult> {
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const signing = this.#signing;
      try {
        return parseImile(await this.#query(number, signing, signal, left()), number);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        // A sign the service does not accept gets the same empty reply as an
        // unknown number, so the page must still sign with the values used.
        const current = await this.#currentSigning(signal, left);
        if (current.key === signing.key && current.salt === signing.salt) throw error;
        return parseImile(await this.#query(number, current, signal, left()), number);
      }
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'imile', budgetMs: context.budgetMs, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs, attempt }) => { attempted(attempt); return read(signal, firstAttemptMs(remainingMs)); } },
      networkRetryStep(({ signal, remainingMs, attempt }) => { attempted(attempt); return read(signal, remainingMs); }),
    ]);
  }

  /**
   * Cainiao's leg of the parcel in front of iMile's history, recorded as the
   * `cainiao` step. Cainiao gets half of the time iMile left, so iMile's
   * answer comes back inside the budget whatever Cainiao does. Any failure,
   * a challenge, a rate limit, an unknown number or a changed reply, is
   * recorded with its kind and returns iMile's answer unchanged.
   */
  async #withCainiao(number: string, result: CarrierResult, signal: AbortSignal | undefined, remainingMs: number,
    attempt: number): Promise<CarrierResult> {
    const recorder = safeRecorder(this.options.recorder ?? NOOP_RECORDER);
    const started = performance.now();
    const record = (error?: unknown) => recorder.step({
      carrier: 'imile', step: 'cainiao', attempt, outcome: error === undefined ? 'ok' : outcomeOf(error),
      errorType: error === undefined ? null : errorTypeOf(error), durationMs: Math.max(0, performance.now() - started),
      fallbackFrom: null, fallbackReason: null, fallbackErrorType: null, ...(error === undefined ? {} : { error }),
    });
    const budgetMs = Math.min(CAINIAO_MS, Math.floor(remainingMs / 2));
    try {
      if (budgetMs < CAINIAO_MIN_MS) throw new BudgetExceededError(CAINIAO, budgetMs);
      const merged = withCainiaoLeg(result, cainiaoScans(await this.#cainiao.detail(number, { signal, budgetMs }), number));
      record();
      return merged;
    } catch (error) {
      record(error);
      return result;
    }
  }

  async #query(number: string, signing: ImileSigning, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { code, sign } = imileSignature(number, signing);
    const { response, bytes } = await fetchBounded(`${IMILE_API}?waybillNo=${encodeURIComponent(number)}&code=${code}`, { method: 'GET', signal,
      headers: { Accept: 'application/json', lang: 'en_US', sign, 'User-Agent': userAgentOf(this.options.userAgent) } },
    { provider: PROVIDER, timeoutMs, maxBytes: IMILE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'iMile redirected its tracking lookup');
    // The page reads a missing parcel from a 200 reply; a 404 is a moved route.
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'iMile tracking lookup is unavailable');
    return json(decodeText(bytes));
  }

  /** The values the page signs with, read again once their last reading is an hour old. */
  async #currentSigning(signal: AbortSignal, left: () => number): Promise<Readonly<ImileSigning>> {
    const now = (this.options.now ?? Date.now)();
    if (now - this.#checkedAt < SIGNING_CHECKED_MS) return this.#signing;
    const page = await this.#text(IMILE_PAGE, signal, left());
    const path = TRACK_SCRIPT.exec(page)?.[0];
    if (!path) {
      if (CHALLENGE.test(page.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'iMile answered its tracking page with a browser check');
      throw new SchemaError(PROVIDER, 'iMile\'s tracking page no longer names its tracking script');
    }
    const signing = scriptSigning(await this.#text(`${ORIGIN}${path}`, signal, left()));
    this.#signing = signing;
    this.#checkedAt = now;
    return signing;
  }

  async #text(url: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: { 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, timeoutMs, maxBytes: PAGE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
        allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'iMile\'s tracking page is unavailable', { status: response.status });
    return decodeText(bytes);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ImileTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'imile', recordsSteps: true, steps: ['direct', 'retry', 'cainiao'],
    track: (input, context) => tracker.fetch(input.number, context),
    // Recognition asks iMile alone: Cainiao's record of a number is no evidence that iMile knows it.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context, { cainiao: false }),
      () => accepted(() => normalizeImileNumber(number))),
  };
};
