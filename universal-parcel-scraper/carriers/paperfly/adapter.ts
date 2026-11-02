import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { paperflyRequestNumber } from './number.js';
import { PAPERFLY_MAX_BYTES, parsePaperfly, PROVIDER } from './parser.js';

/** The lookup the public tracking page on go.paperfly.com.bd makes for the number in its address. */
export const PAPERFLY_API = 'https://go-app.paperfly.com.bd/merchant/api/react/order/track_order.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)|AwsWafIntegration|awswaf\.com|g-recaptcha|hcaptcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Paperfly answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Paperfly returned a reply that is not JSON', { cause });
  }
}

export class PaperflyTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    // The service finds a number only with the hyphens Paperfly writes in it.
    const number = paperflyRequestNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const url = `${PAPERFLY_API}?${new URLSearchParams({ order_number: number })}`;
      const { response, bytes } = await fetchBounded(url, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PAPERFLY_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Paperfly redirected its tracking lookup');
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Paperfly tracking lookup is unavailable');
      const payload = json(decodeText(bytes));
      // An unknown number is a 400 with the service's own error; an order is never one.
      if (response.status === 400 && !(payload && typeof payload === 'object' && 'error' in payload)) {
        throw new SchemaError(PROVIDER, 'Paperfly refused the lookup');
      }
      return parsePaperfly(payload, number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'paperfly', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PaperflyTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'paperfly', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => paperflyRequestNumber(number))),
  };
};
