import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DAYLIGHT_MAX_BYTES, isDaylightUnknown, normalizeDaylightNumber, parseDaylight, PROVIDER } from './parser.js';

/** The base of the two lookups the MyDaylight shipment page makes for the probill in its address. */
export const DAYLIGHT_API = 'https://mydaylight.dylt.com/api/v1/shipments';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|AwsWafIntegration|awswaf\.com|captcha/i;

/** The addresses of the shipment's details and of its history, for one whole probill. */
export function daylightLookupUrls(number: string): { details: string; history: string } {
  const query = new URLSearchParams({ probill: normalizeDaylightNumber(number) });
  return { details: `${DAYLIGHT_API}/public?${query}`, history: `${DAYLIGHT_API}/history/public?${query}` };
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Daylight answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Daylight returned a reply that is not JSON', { cause });
  }
}

/** JSON, or nothing when the body is not JSON. */
function maybeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export class DaylightTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async #get(url: string, signal: AbortSignal, timeoutMs: number): Promise<{ status: number; body: string }> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: DAYLIGHT_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Daylight redirected its tracking lookup');
    return { status: response.status, body: decodeText(bytes) };
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDaylightNumber(raw);
    const urls = daylightLookupUrls(number);
    const read = async (signal: AbortSignal, remainingMs: number): Promise<CarrierResult> => {
      const timeoutMs = Math.max(1, Math.floor(remainingMs));
      // Both at once, as the page makes them. When one fails, the other is not left running.
      const sibling = new AbortController();
      const both = AbortSignal.any([signal, sibling.signal]);
      try {
        const [details, history] = await Promise.all([this.#get(urls.details, both, timeoutMs), this.#get(urls.history, both, timeoutMs)]);
        // The details answer a probill they do not know with a 404 holding an empty search;
        // any other 404, and a 404 or 410 from the history, is a moved route.
        const unknown = details.status === 404 ? maybeJson(details.body) : undefined;
        if ((details.status !== 200 && !isDaylightUnknown(unknown)) || history.status !== 200) {
          throw new TransportError(PROVIDER, 'Daylight tracking lookup is unavailable');
        }
        return parseDaylight({ status: details.status, body: details.status === 404 ? unknown : json(details.body) }, json(history.body), number);
      } finally {
        sibling.abort();
      }
    };
    // A request that fails to reach Daylight, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'daylight-transport', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DaylightTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'daylight-transport', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDaylightNumber(number))),
  };
};
