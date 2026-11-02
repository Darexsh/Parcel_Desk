import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GMS_MAX_BYTES, normalizeGmsNumber, parseGms, PROVIDER } from './parser.js';

/** The lookup the tracking page on gmsworldwide.com makes for the consignment number in its address. */
export const GMS_API = 'https://www.gmsglobe.com/webapi/get-consignment.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// An unknown number is HTTP 200 with the lookup's own answer; a 404 is a moved route.
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /captcha|_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_Incapsula_Resource|AwsWafIntegration/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GMS Worldwide Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'GMS Worldwide Express returned a reply that is not JSON', { cause });
  }
}

export class GmsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGmsNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page can also look up a customer reference (`refno`); only the consignment number (`cnno`) is asked.
      const { response, bytes } = await fetchBounded(`${GMS_API}?${new URLSearchParams({ cnno: number })}`, { method: 'GET', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GMS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'GMS Worldwide Express moved its tracking lookup', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'GMS Worldwide Express tracking lookup is unavailable', { status: response.status });
      return parseGms(json(decodeText(bytes)), number);
    };
    // A read that fails to reach GMS, or hangs, gets one more: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'gms-worldwide', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GmsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gms-worldwide', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGmsNumber(number))),
  };
};
