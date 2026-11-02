import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MESSENGER_MAX_BYTES, normalizeMessengerNumber, parseMessenger, PROVIDER } from './parser.js';

/** The lookup tracking.messenger.cz makes for the number in its address or search box. */
export const MESSENGER_API = 'https://api.messenger.cz/MessengerWeb/tracking/REST/trackingStatus/';
/** The tracking page's origin: the API's request filter fails with HTTP 500 without one. */
export const MESSENGER_ORIGIN = 'https://tracking.messenger.cz';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown number with 204: a missing route is not a missing consignment.
const GONE = [404, 405, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Messenger answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Messenger returned a reply that is not JSON', { cause });
  }
}

export class MessengerTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMessengerNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${MESSENGER_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', Origin: MESSENGER_ORIGIN, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MESSENGER_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Messenger tracking lookup is unavailable', { status: response.status });
      }
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Messenger refused the lookup', { status: 403 });
      // The page reads an empty answer as "Zásilku se nám nepodařilo vyhledat".
      if (response.status === 204) throw new NotFoundError(PROVIDER);
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (!body) throw new IndeterminateError(PROVIDER, 'Messenger returned an empty reply');
      return parseMessenger(json(body), number);
    };
    // A lookup that fails to reach Messenger, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'messenger-cz', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MessengerTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'messenger-cz', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
