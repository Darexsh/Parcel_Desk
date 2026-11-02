import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isMongolInfinityPostCustomsNumber, MONGOL_INFINITY_POST_MAX_BYTES, normalizeMongolInfinityPostNumber, parseMongolInfinityPostCustoms,
  parseMongolInfinityPostCustomsRefusal, parseMongolInfinityPostHistory, PROVIDER,
} from './parser.js';

/** The search the mypost.mn home page makes for the number typed in. */
export const MONGOL_INFINITY_POST_SEARCH_API = 'https://mypost.mn/core_api/api/order/history';
/** The lookup the home page makes instead for a number holding YC. */
export const MONGOL_INFINITY_POST_CUSTOMS_API = 'https://mypost.mn/order_api/api/customs/admin/status/item/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Mongol Infinity Post answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Mongol Infinity Post returned a reply that is not JSON', { cause });
  }
}

export class MongolInfinityPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMongolInfinityPostNumber(raw);
    const customs = isMongolInfinityPostCustomsNumber(number);
    const url = customs ? `${MONGOL_INFINITY_POST_CUSTOMS_API}${encodeURIComponent(number)}`
      : `${MONGOL_INFINITY_POST_SEARCH_API}?${new URLSearchParams({ q: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MONGOL_INFINITY_POST_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      const body = decodeText(bytes);
      if (response.status === 403) {
        throw new ChallengeError(PROVIDER, CHALLENGE.test(body.slice(0, 64_000)) ? 'Mongol Infinity Post answered with a browser check'
          : 'Mongol Infinity Post refused the lookup', { status: 403 });
      }
      // The customs lookup answers an item it does not know with HTTP 404 and a message naming it.
      if (customs && response.status === 404) {
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          payload = undefined;
        }
        return parseMongolInfinityPostCustomsRefusal(payload, number);
      }
      // The search reads a missing parcel from a 200 reply; a 404 or a redirect is a moved route.
      if (REDIRECTS.includes(response.status) || response.status === 404 || response.status === 410) {
        throw new TransportError(PROVIDER, 'Mongol Infinity Post tracking lookup is unavailable', { status: response.status });
      }
      const payload = json(body);
      return customs ? parseMongolInfinityPostCustoms(payload, number) : parseMongolInfinityPostHistory(payload, number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'mongol-infinity-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MongolInfinityPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'mongol-infinity-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMongolInfinityPostNumber(number))),
  };
};
