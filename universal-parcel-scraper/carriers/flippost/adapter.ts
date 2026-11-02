import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, isNetworkFailure, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { flippostWaybills } from './number.js';
import { FLIPPOST_MAX_BYTES, PROVIDER, settleFlippost } from './parser.js';

/** Flip Post's documented client API; `getTrackInfo` is its tracking request. */
export const FLIPPOST_API = 'https://web.flippost.com/fp/client/api.php';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenges\.cloudflare\.com|<title>\s*Just a moment|g-recaptcha|h-captcha|smartcaptcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Flip Post answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Flip Post returned a reply that is not JSON', { cause });
  }
}

/** The API's tracking request for one waybill, in its dashed form. */
export function flippostLookupUrl(waybill: string): string {
  const url = new URL(FLIPPOST_API);
  url.search = new URLSearchParams({ dbAct: 'getTrackInfo', wbno: waybill }).toString();
  return url.toString();
}

export class FlippostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(waybill: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { response, bytes } = await fetchBounded(flippostLookupUrl(waybill), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FLIPPOST_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Flip Post redirected its tracking lookup', { status: response.status });
    // The API answers every waybill with HTTP 200; a 404 is a moved route.
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Flip Post tracking lookup is unavailable', { status: response.status });
    return json(decodeText(bytes));
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const waybills = flippostWaybills(raw);
    // Each reading's reply, kept for the retry: only a reading that failed to reach Flip Post is asked again.
    const replies = new Map<string, unknown>();
    const ask = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const outcomes = await Promise.allSettled(waybills.filter((waybill) => !replies.has(waybill)).map(async (waybill) => {
        replies.set(waybill, await this.read(waybill, signal, timeoutMs));
      }));
      const failures = outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason as unknown] : []));
      // A failure other than the network's stands; a network failure gets the retry.
      if (failures.length) throw failures.find((error) => !isNetworkFailure(error)) ?? failures[0];
      return settleFlippost(waybills.map((waybill) => replies.get(waybill)));
    };
    // The readings are asked together; a request that fails to reach the API, or hangs, gets one
    // more try. The first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'flippost', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => ask(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => ask(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FlippostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'flippost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => flippostWaybills(number))),
  };
};
