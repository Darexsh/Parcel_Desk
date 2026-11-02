import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isBlockPage, normalizeSerpostNumber, parseSerpost, parseSerpostForm, PROVIDER, SERPOST_MAX_BYTES } from './parser.js';

const ORIGIN = 'https://www.serpost.com.pe';
/** The tracking page, whose form carries the anti-forgery token. */
export const SERPOST_PAGE = `${ORIGIN}/Cliente/SegumientoLinea`;
/** The lookup the page's script posts the number to. */
export const SERPOST_LOOKUP = `${SERPOST_PAGE}/ObtenerTracking`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown number in its reply: a missing route is not a missing item.
const GONE = [404, 405, 410];
// The anti-forgery cookie the page sets beside its token.
const ANTIFORGERY = /^\.AspNetCore\.Antiforgery\.[A-Za-z0-9_-]{1,40}$/;
const COOKIE_VALUE = /^[^\s;,]{1,1024}$/;

/** The page's anti-forgery cookie, which the lookup sends back with the token. */
function antiforgeryCookie(response: Response): string {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (separator > 0 && ANTIFORGERY.test(name) && COOKIE_VALUE.test(value)) return `${name}=${value}`;
  }
  throw new IndeterminateError(PROVIDER, 'Serpost did not open an anonymous session');
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (isBlockPage(body)) throw new ChallengeError(PROVIDER, 'Serpost answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Serpost returned a reply that is not JSON', { cause });
  }
}

export class SerpostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSerpostNumber(raw);
    // One attempt opens a session on the tracking page and posts the number with its token, as the page's script does.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const userAgent = userAgentOf(this.options.userAgent);
      const page = await fetchBounded(SERPOST_PAGE, { signal, headers: { Accept: 'text/html', 'User-Agent': userAgent } },
        { provider: PROVIDER, timeoutMs: left(), maxBytes: SERPOST_MAX_BYTES, redirect: 'manual',
          allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      if (page.response.status === 403) throw new ChallengeError(PROVIDER, 'Serpost refused its tracking page', { status: 403 });
      if (page.response.status !== 200) {
        throw new TransportError(PROVIDER, 'Serpost tracking page is unavailable', { status: page.response.status });
      }
      const token = parseSerpostForm(decodeText(page.bytes));
      const cookie = antiforgeryCookie(page.response);
      signal.throwIfAborted();
      const lookup = await fetchBounded(SERPOST_LOOKUP, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': userAgent, Cookie: cookie, 'X-CSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest', Origin: ORIGIN, Referer: SERPOST_PAGE,
      }, body: new URLSearchParams({ numeroTracking: number }) }, { provider: PROVIDER, timeoutMs: left(), maxBytes: SERPOST_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 400, 403], fetcher: this.options.fetcher });
      const status = lookup.response.status;
      if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'Serpost tracking lookup is unavailable', { status });
      if (status === 403) throw new ChallengeError(PROVIDER, 'Serpost refused the lookup', { status });
      // A refused token or session, which says nothing about the item.
      if (status === 400) throw new IndeterminateError(PROVIDER, 'Serpost refused the lookup request');
      const body = decodeText(lookup.bytes).replace(/^\uFEFF/, '').trim();
      if (!body) throw new IndeterminateError(PROVIDER, 'Serpost returned an empty reply');
      return parseSerpost(json(body), number);
    };
    // An attempt that fails to reach the tracker, or hangs, gets one more in a new session:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'serpost', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SerpostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'serpost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeSerpostNumber(number))),
  };
};
