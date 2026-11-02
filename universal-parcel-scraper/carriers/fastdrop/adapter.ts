import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { FASTDROP_MAX_BYTES, normalizeFastdropNumber, parseFastdrop, PROVIDER } from './parser.js';

const API = 'https://api.motiontools.io/api';
/** The MotionTools lookup Fastdrop's tracking page on booking.fastdrop.mt makes for the number in its address. */
export const fastdropTrackingUrl = (number: string) => `${API}/hailing/packages/${encodeURIComponent(number)}/tracking`;
/** The tenant settings the page reads first, which name the client version it sends. */
export const FASTDROP_CONFIG = `${API}/config?origin=${encodeURIComponent('https://booking.fastdrop.mt')}`;
/** The client version the page sends: MotionTools finds the operator, and so its packages, by it. */
export const FASTDROP_CLIENT_VERSION = 'eCabs Web Dashboard/1.0.0';
const CONFIG_MAX_BYTES = 64 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the API, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Fastdrop answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Fastdrop returned a reply that is not JSON', { cause });
  }
}

const errorCode = (body: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed.error_code : undefined;
  } catch {
    return undefined;
  }
};

export class FastdropTracker {
  #clientVersion: string;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; clientVersion?: string } = {}) {
    this.#clientVersion = options.clientVersion ?? FASTDROP_CLIENT_VERSION;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFastdropNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const version = this.#clientVersion;
      const answer = await this.#lookup(number, version, signal, left());
      if (answer !== 'refused') return parseFastdrop(answer, number);
      // MotionTools refuses a client version it no longer accepts; the
      // tenant settings name the one the page sends now.
      const current = await this.#currentVersion(signal, left());
      if (current === version) throw new TransportError(PROVIDER, 'MotionTools refused the client version Fastdrop\'s page sends');
      this.#clientVersion = current;
      const retried = await this.#lookup(number, current, signal, left());
      if (retried === 'refused') throw new TransportError(PROVIDER, 'MotionTools refused the client version Fastdrop\'s page sends');
      return parseFastdrop(retried, number);
    };
    // A request that fails to reach the API, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'fastdrop', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  /** The package's reply, or `refused` when MotionTools does not accept the client version. */
  async #lookup(number: string, version: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(fastdropTrackingUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'Accept-Language': 'en', 'X-Client-Version': version, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: FASTDROP_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 400, 404, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Fastdrop redirected its tracking lookup');
    const body = decodeText(bytes);
    // An unknown version is HTTP 400 `unknown_tenant`; one too old to serve, HTTP 410.
    if (response.status === 410 || (response.status === 400 && errorCode(body) === 'unknown_tenant')) return 'refused';
    if (response.status === 400) throw new TransportError(PROVIDER, 'MotionTools rejected Fastdrop\'s tracking lookup', { status: 400 });
    if (response.status === 404) {
      // The page reports this reply as a tracking ID it cannot match; any other 404 is a moved route.
      if (errorCode(body) === 'not_found') throw new NotFoundError(PROVIDER);
      throw new TransportError(PROVIDER, 'Fastdrop tracking lookup is unavailable', { status: 404 });
    }
    return json(body);
  }

  async #currentVersion(signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(FASTDROP_CONFIG, { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: CONFIG_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Fastdrop\'s tenant settings are unavailable', { status: response.status });
    const config = json(decodeText(bytes));
    const tenant = isRecord(config) ? config.tenant : undefined;
    const version = isRecord(tenant) && typeof tenant.web_client_version === 'string' ? tenant.web_client_version.trim() : '';
    if (!version || version.length > 120) throw new SchemaError(PROVIDER, 'Fastdrop\'s tenant settings name no client version');
    return version;
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FastdropTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'fastdrop', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFastdropNumber(number))),
  };
};
