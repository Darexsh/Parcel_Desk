import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { BESTFULFILL_MAX_BYTES, CARRIER, normalizeBestfulfillNumber, parseBestfulfill, PROVIDER } from './parser.js';

/** The open service the tracking page asks. */
export const BESTFULFILL_API = 'https://www.bestfulfillpacket.com/openapi/v1/external/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|AwsWafIntegration|awswaf\.com|captcha/i;
const DEFAULT_BUDGET_MS = 15_000;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'BestFulfill Packet answered with a browser check', { cause });
    return undefined;
  }
}

export class BestfulfillTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${BESTFULFILL_API}?number=${encodeURIComponent(number)}`, { method: 'GET', signal,
      headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BESTFULFILL_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    const payload = json(decodeText(bytes));
    // The service answers a number it does not hold with HTTP 404 and its own
    // message; a 404 page or a redirect is a moved service, not a missing parcel.
    if (response.status === 404 && isRecord(payload) && payload.error === 'tracking not found') throw new NotFoundError(PROVIDER);
    if (response.status !== 200) throw new TransportError(PROVIDER, 'BestFulfill Packet tracking service moved', { status: response.status });
    if (payload === undefined) throw new SchemaError(PROVIDER, 'BestFulfill Packet returned a reply that is not JSON');
    return parseBestfulfill(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBestfulfillNumber(raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BestfulfillTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeBestfulfillNumber(number))),
  };
};
