import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { COPA_COURIER_MAX_BYTES, normalizeCopaCourierNumber, parseCopaCourier, parseCopaCourierForm, PROVIDER } from './parser.js';

const ORIGIN = 'https://www.copacourier.com';
/** The home page, whose tracking form carries the anti-forgery token. */
export const COPA_COURIER_HOME = `${ORIGIN}/`;
/** Where the form posts the HAWB. */
export const COPA_COURIER_LOOKUP = `${ORIGIN}/Hawb/Hawb`;
const REDIRECTS = [301, 302, 303, 307, 308];
const ANTIFORGERY_COOKIE = /^\.AspNetCore\.Antiforgery\.[A-Za-z0-9_-]{1,40}$/;
const COOKIE_VALUE = /^[^\s;,]{1,1024}$/;

/** The anti-forgery cookie the home page sets, which the token is bound to. */
function sessionCookie(response: Response): string {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (separator > 0 && ANTIFORGERY_COOKIE.test(name) && COOKIE_VALUE.test(value)) return `${name}=${value}`;
  }
  throw new IndeterminateError(PROVIDER, 'Copa Courier did not open an anonymous session');
}

export class CopaCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCopaCourierNumber(raw);
    // One attempt opens a session on the home page and posts the HAWB with the form's token.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      // The page's culture follows Accept-Language; Spanish is the site's own, and its month names are read.
      const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html', 'Accept-Language': 'es' };
      const home = await fetchBounded(COPA_COURIER_HOME, { signal, headers }, { provider: PROVIDER, timeoutMs: left(),
        maxBytes: COPA_COURIER_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher });
      if (home.response.status !== 200) throw new TransportError(PROVIDER, 'Copa Courier home page is unavailable');
      const token = parseCopaCourierForm(decodeText(home.bytes));
      const cookie = sessionCookie(home.response);
      signal.throwIfAborted();
      const lookup = await fetchBounded(COPA_COURIER_LOOKUP, { method: 'POST', signal, headers: { ...headers, Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Referer: COPA_COURIER_HOME },
      body: new URLSearchParams({ txtNumeroHAWB: number, __RequestVerificationToken: token }).toString() }, { provider: PROVIDER,
        timeoutMs: left(), maxBytes: COPA_COURIER_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 400, 404, 410],
        fetcher: this.options.fetcher });
      // The site answers a token it does not accept with an empty HTTP 400, which says nothing about the HAWB.
      if (lookup.response.status === 400) throw new IndeterminateError(PROVIDER, 'Copa Courier refused the tracking form');
      // An unknown HAWB is HTTP 200: a redirect or a 404 is a moved route.
      if (lookup.response.status !== 200) throw new TransportError(PROVIDER, 'Copa Courier tracking is unavailable');
      return parseCopaCourier(decodeText(lookup.bytes), number);
    };
    // An attempt that fails to reach the site, or hangs, gets one more in a new session: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'copa-courier', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CopaCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'copa-courier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeCopaCourierNumber(number))),
  };
};
