import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { HAL_MAX_BYTES, isHalNotFound, normalizeHalNumber, parseHal, PROVIDER } from './parser.js';

/** The lookup halexpress.la's parcel page makes for the number in its address. */
export const HAL_API = 'https://hal.hal-logistics.la/api/v1/orders/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /captcha|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'HAL Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'HAL Express returned a reply that is not JSON', { cause });
  }
}

/** A 404 is HAL's answer for an unknown bill only when its body says so; any other is a moved route. */
function gone(body: string): never {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  if (isHalNotFound(payload)) throw new NotFoundError(PROVIDER);
  throw new TransportError(PROVIDER, 'HAL Express tracking lookup is unavailable');
}

export class HalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHalNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${HAL_API}${encodeURIComponent(number)}`, { signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HAL_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'HAL Express redirected its tracking lookup');
      if (GONE.includes(response.status)) gone(decodeText(bytes));
      return parseHal(json(decodeText(bytes)), number);
    };
    // A request that fails to reach HAL, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'houng-ah-loun', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'houng-ah-loun', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeHalNumber(number))),
  };
};
