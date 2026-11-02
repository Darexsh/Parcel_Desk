import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CITY_EXPRESS_FRAGMENT, CITY_EXPRESS_MAX_BYTES, cityExpressNumber, parseCityExpress, parseCityExpressPage, PROVIDER } from './parser.js';

const ORIGIN = 'https://www.cityexpress.rs';
/** The English tracking page, which opens the session the lookup needs, in English. */
export const CITY_EXPRESS_PAGE = `${ORIGIN}/en/shipment-tracing`;
/** The fragment the page's tracking form asks for, through htmx. */
export const CITY_EXPRESS_LOOKUP = `${ORIGIN}${CITY_EXPRESS_FRAGMENT}`;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown number in its reply: a missing route is not a missing shipment.
const GONE = [404, 405, 410];
const SESSION = /^JSESSIONID=[A-Za-z0-9._-]{8,200}$/;
// The site's own 403 page, for a request without its session or token, or with an expired one.
const REFUSED = /<main id="error-content-403">/;

/** The fragment's address for a centre and its eight digits, as the form sends them. */
export function cityExpressLookupUrl(centre: string, serial: string): string {
  return `${CITY_EXPRESS_LOOKUP}?${new URLSearchParams({ 'track-trace-page-shipment-center': centre, 'track-trace-page-shipment-number': serial })}`;
}

/** The anonymous session the tracking page opens, which the lookup sends back with the page's token. */
function sessionCookie(response: Response): string {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0]!.trim();
    if (SESSION.test(pair)) return pair;
  }
  throw new IndeterminateError(PROVIDER, 'City Express did not open an anonymous session', { reason: 'session_rejected' });
}

export class CityExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const asked = cityExpressNumber(raw);
    // One attempt opens a session on the tracking page and asks for the fragment with its token, as the page's script does.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const userAgent = userAgentOf(this.options.userAgent);
      const page = await fetchBounded(CITY_EXPRESS_PAGE, { method: 'GET', signal, headers: { Accept: 'text/html', 'User-Agent': userAgent } },
        { provider: PROVIDER, timeoutMs: left(), maxBytes: CITY_EXPRESS_MAX_BYTES, redirect: 'manual',
          allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      if (page.response.status === 403) throw new ChallengeError(PROVIDER, 'City Express refused its tracking page', { status: 403 });
      if (page.response.status !== 200) {
        throw new TransportError(PROVIDER, 'City Express tracking page is unavailable', { status: page.response.status });
      }
      const { header, token } = parseCityExpressPage(decodeText(page.bytes), asked.centre);
      const cookie = sessionCookie(page.response);
      signal.throwIfAborted();
      const lookup = await fetchBounded(cityExpressLookupUrl(asked.centre, asked.serial), { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgent, Cookie: cookie, [header]: token, 'HX-Request': 'true', Referer: CITY_EXPRESS_PAGE,
      } }, { provider: PROVIDER, timeoutMs: left(), maxBytes: CITY_EXPRESS_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      const status = lookup.response.status;
      if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'City Express tracking lookup is unavailable', { status });
      const body = decodeText(lookup.bytes);
      if (status === 403) {
        // A refused or expired session says nothing about the shipment.
        if (REFUSED.test(body)) throw new IndeterminateError(PROVIDER, 'City Express refused the lookup’s session', { reason: 'session_rejected' });
        throw new ChallengeError(PROVIDER, 'City Express refused the lookup', { status });
      }
      return parseCityExpress(body, asked.number);
    };
    // An attempt that fails to reach the tracker, or hangs, gets one more in a new session:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'city-express-rs', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CityExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'city-express-rs', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => cityExpressNumber(number))),
  };
};
