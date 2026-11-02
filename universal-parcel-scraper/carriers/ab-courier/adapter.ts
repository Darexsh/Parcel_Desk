import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { AB_COURIER_MAX_BYTES, normalizeAbCourierNumber, parseAbCourier, PROVIDER } from './parser.js';

/** The lookup A&B's tracking page makes for an order number. */
export const AB_COURIER_API = 'https://abcourier.com/ABWebclientAPI/V1/Auth/TrackingInfo';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing order: the lookup answers an unknown order in its reply.
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|captcha/i;

/** The body the page posts for one whole order: no account, and the order as a number. */
export function abCourierLookupBody(number: string): string {
  return JSON.stringify({ accountNumber: 0, orderNumber: Number(normalizeAbCourierNumber(number)) });
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'A&B Courier answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'A&B Courier returned a reply that is not JSON', { cause });
  }
}

export class AbCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAbCourierNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(AB_COURIER_API, { method: 'POST', signal, body: abCourierLookupBody(number), headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: AB_COURIER_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'A&B Courier redirected its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'A&B Courier tracking lookup is unavailable');
      return parseAbCourier(json(decodeText(bytes)), number);
    };
    // A request that fails to reach A&B, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'ab-courier', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AbCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ab-courier', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAbCourierNumber(number))),
  };
};
