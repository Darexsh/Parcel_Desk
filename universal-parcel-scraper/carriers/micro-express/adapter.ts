import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, MICRO_EXPRESS_MAX_BYTES, normalizeMicroExpressNumber, parseMicroExpress, PROVIDER } from './parser.js';

/** The lookup the Track Item page on microexpress.com.au makes for the number typed in. */
export const MICRO_EXPRESS_API = 'https://microexpress.com.au/partner/tracking-info';
const REDIRECTS = [301, 302, 303, 307, 308];
// The service answers an unknown number with HTTP 200: a 404 is a moved route.
const GONE = [404, 405, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access Denied)|g-recaptcha|hcaptcha|AwsWafIntegration|awswaf\.com/i;
const DEFAULT_BUDGET_MS = 15_000;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Micro Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Micro Express returned a reply that is not JSON', { cause });
  }
}

export class MicroExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page's own body, flag included; the reply is JSON under a text/html type.
    const { response, bytes } = await fetchBounded(MICRO_EXPRESS_API, { method: 'POST', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json;UTF-8', 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ tracking_number: number, bloclose: 'true' }) }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MICRO_EXPRESS_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE],
    });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Micro Express redirected its tracking lookup', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Micro Express tracking lookup is unavailable', { status: response.status });
    return parseMicroExpress(json(decodeText(bytes)), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMicroExpressNumber(raw);
    // A read that fails to reach Micro Express, or hangs, is sent once more:
    // the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MicroExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMicroExpressNumber(number))),
  };
};
