import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { GO_DADDY_SECURE_CA_G2 } from './certificate.js';
import { NORSK_GLOBAL_MAX_BYTES, normalizeNorskGlobalNumber, parseNorskGlobal, PROVIDER } from './parser.js';

/** The lookup Norsk's tracker makes, under the client token of the tracker's own `norsk` site. */
export const NORSK_GLOBAL_API = 'https://portal.norsk-global.com/api/public';
/** Norsk's own site on its tracker, whose page gives every visitor its client token. */
export const NORSK_GLOBAL_PAGE = 'https://norsk.trackmyparcel.info/gb';
/** The client token the `norsk` site's page gives every visitor, the same for all of them. */
export const NORSK_GLOBAL_TOKEN = 'WPJAXQYLK7WEZT3C'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
const PAGE_MAX_BYTES = 1024 * 1024;
// The `norsk` site's settings in the page's server components, up to its first client token.
const SITE_TOKEN = /"_id":"clients\/norsk"[^{}]{0,2000}?"clientToken1":"([A-Za-z0-9]{8,64})"/;
// The page's server sends its certificate without the intermediate, which Node does not fetch itself.
let trusting: typeof fetch | undefined;
const trustingFetch = () => trusting ??= fetchTrusting([GO_DADDY_SECURE_CA_G2]);
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Norsk Global answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Norsk Global returned a reply that is not JSON', { cause });
  }
}

export class NorskGlobalTracker {
  #token: string;
  readonly #pageFetcher: typeof fetch;

  /** Over the global fetch, the page is read trusting the intermediate it leaves out; a host's own fetcher is used as given. */
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; token?: string } = {}) {
    this.#token = options.token ?? NORSK_GLOBAL_TOKEN;
    this.#pageFetcher = transportOf(options.fetcher) === undefined ? trustingFetch() : options.fetcher!;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeNorskGlobalNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const token = this.#token;
      const reply = await this.#query(number, token, signal, left());
      if (reply !== null) return parseNorskGlobal(reply, number);
      // A refused token may have been replaced: the page gives the current one.
      const current = await this.#pageToken(signal, left());
      if (current === token) throw new SchemaError(PROVIDER, 'Norsk Global refused its tracker\'s client token');
      const retried = await this.#query(number, current, signal, left());
      if (retried === null) throw new SchemaError(PROVIDER, 'Norsk Global refused its tracker\'s client token');
      this.#token = current;
      return parseNorskGlobal(retried, number);
    };
    return runSteps({ carrier: 'norsk-global', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }

  /** The reply for the number, or null when the API refuses the token. */
  async #query(number: string, token: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(`${NORSK_GLOBAL_API}/${encodeURIComponent(token)}/tracking`, { method: 'POST', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
      body: JSON.stringify({ reference: number, userToken: [] }) },
    { provider: PROVIDER, timeoutMs, maxBytes: NORSK_GLOBAL_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 401, 404, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Norsk Global redirected its tracking lookup');
    // An unknown reference is an empty 200 reply; a 404 is a moved route.
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Norsk Global tracking lookup is unavailable');
    if (response.status === 401) return null;
    return json(decodeText(bytes));
  }

  /** The client token the `norsk` site's page gives now. */
  async #pageToken(signal: AbortSignal, timeoutMs: number): Promise<string> {
    // `RSC: 1` asks for the page's server components, which hold the site's settings as plain JSON.
    const { response, bytes } = await fetchBounded(NORSK_GLOBAL_PAGE, { method: 'GET', signal,
      headers: { RSC: '1', Accept: 'text/x-component', 'User-Agent': userAgentOf(this.options.userAgent) } },
    { provider: PROVIDER, timeoutMs, maxBytes: PAGE_MAX_BYTES, redirect: 'manual', fetcher: this.#pageFetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Norsk Global\'s tracking page is unavailable', { status: response.status });
    const page = decodeText(bytes);
    const token = SITE_TOKEN.exec(page)?.[1];
    if (token) return token;
    if (CHALLENGE.test(page.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Norsk Global answered its tracking page with a browser check');
    throw new SchemaError(PROVIDER, 'Norsk Global\'s tracking page no longer gives its client token');
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new NorskGlobalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'norsk-global', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeNorskGlobalNumber(number))),
  };
};
