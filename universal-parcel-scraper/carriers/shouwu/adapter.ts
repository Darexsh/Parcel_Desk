import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeShouwuNumber, parseShouwu, PROVIDER, SHOUWU_MAX_BYTES } from './parser.js';

const ORIGIN = 'https://admin.shshouwu.com';
/** The tracking page, which opens a parcel from `?q=`. */
export const SHOUWU_PAGE = `${ORIGIN}/track.html`;
/** The lookup the tracking page's script asks, with the numbers in a JSON body. */
export const SHOUWU_API = `${ORIGIN}/api/freight/order/PubOrder/getOrderTrace`;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or a firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|cf-error-details|captcha/i;

/** The reply's JSON. */
function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Shouwu answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Shouwu returned a reply that is not JSON', { cause });
  }
}

export class ShouwuTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeShouwuNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's script sends its locale, Chinese unless the visitor chose another.
      const { response, bytes } = await fetchBounded(SHOUWU_API, { method: 'POST', signal, body: JSON.stringify({ strs: [number] }), headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', Origin: ORIGIN, Referer: SHOUWU_PAGE, 'x-locale': 'zh-cn',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: SHOUWU_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The lookup answers every number, known or not, with HTTP 200; a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Shouwu tracking lookup moved', { status: response.status });
      return parseShouwu(json(decodeText(bytes)), number);
    };
    // A read that fails to reach the site, or hangs, gets one more: the first gets half of the budget.
    return runSteps({ carrier: 'shouwu', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ShouwuTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'shouwu', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeShouwuNumber(number))),
  };
};
