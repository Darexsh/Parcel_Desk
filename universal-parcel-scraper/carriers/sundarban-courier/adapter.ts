import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSundarbanNumber, parseSundarban, PROVIDER, SUNDARBAN_MAX_BYTES } from './parser.js';

/** Sundarban's tracking page, whose script gives every visitor the lookup's key. */
export const SUNDARBAN_PAGE = 'https://operation.sundarbancourierltd.com/';
/** The lookup the tracking page makes for a CN number. */
export const SUNDARBAN_API = 'https://operation.sundarbancourierltd.com/Home/getDatabyCN';
/** The key the tracking page's script sends with every lookup, the same for every visitor. */
export const SUNDARBAN_KEY = 'CzbZcWnwf7TNTzluD9rxyXCUqzN4xOhs'; // gitleaks:allow
const REDIRECTS = [301, 302, 303, 307, 308];
const PAGE_MAX_BYTES = 1024 * 1024;
// The service's answer to a lookup without the page's key, as a JSON string.
const REFUSED = 'UNAUTHORIZED';
// The page script's header for the lookup.
const PAGE_KEY = /setRequestHeader\(\s*["']key["']\s*,\s*["']([A-Za-z0-9]{8,128})["']\s*\)/;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;

/** The page's request: one CN number, looked up as a CN number over its default period. */
export function sundarbanLookupBody(number: string): string {
  return JSON.stringify({ selectedtypes: 'cnno', selectedtimes: '7', inputvalue: number });
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Sundarban answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Sundarban returned a reply that is not JSON', { cause });
  }
}

export class SundarbanTracker {
  #key: string;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; key?: string } = {}) {
    this.#key = options.key ?? SUNDARBAN_KEY;
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSundarbanNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const key = this.#key;
      const reply = await this.#query(number, key, signal, left());
      if (reply !== REFUSED) return parseSundarban(reply, number);
      // A refused key may have been replaced: the page gives the current one.
      const current = await this.#pageKey(signal, left());
      if (current === key) throw new SchemaError(PROVIDER, 'Sundarban refused its tracking page\'s key');
      const retried = await this.#query(number, current, signal, left());
      if (retried === REFUSED) throw new SchemaError(PROVIDER, 'Sundarban refused its tracking page\'s key');
      this.#key = current;
      return parseSundarban(retried, number);
    };
    // A read that fails to reach Sundarban, or hangs, gets one more: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'sundarban-courier', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  /** The decoded reply for the number. */
  async #query(number: string, key: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(SUNDARBAN_API, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/json;charset=utf-8', key,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: sundarbanLookupBody(number) }, { provider: PROVIDER, timeoutMs, maxBytes: SUNDARBAN_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Sundarban redirected its tracking lookup');
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Sundarban tracking lookup is unavailable', { status: response.status });
    return json(decodeText(bytes));
  }

  /** The key the tracking page's script sends now. */
  async #pageKey(signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(SUNDARBAN_PAGE, { method: 'GET', signal,
      headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } },
    { provider: PROVIDER, timeoutMs, maxBytes: PAGE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Sundarban\'s tracking page is unavailable', { status: response.status });
    const page = decodeText(bytes);
    const key = PAGE_KEY.exec(page)?.[1];
    if (key) return key;
    if (CHALLENGE.test(page.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Sundarban answered its tracking page with a browser check');
    throw new SchemaError(PROVIDER, 'Sundarban\'s tracking page no longer gives its lookup key');
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SundarbanTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'sundarban-courier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
