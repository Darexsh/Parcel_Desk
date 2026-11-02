import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MATKAHUOLTO_MAX_BYTES, normalizeMatkahuoltoNumber, normalizeMatkahuoltoRecognitionNumber, parseMatkahuolto, PROVIDER } from './parser.js';

// The service the tracking page on matkahuolto.fi asks for a number.
export const MATKAHUOLTO_ENDPOINT = 'https://wwwservice.matkahuolto.fi/search/trackingInfo';
const REDIRECTS = [301, 302, 303, 307, 308];
// A moved or missing route says nothing about the parcel: the service answers
// an unknown number with its own not-found reply.
const MISSING = [404, 410];
// An AWS WAF challenge or a CloudFront block page, which can come instead of the reply.
const CHALLENGE = /awswaf|gokuProps|captcha|Request blocked|<title>\s*(?:ERROR|403)/i;

export function matkahuoltoTrackingUrl(raw: string): string {
  const url = new URL(MATKAHUOLTO_ENDPOINT);
  url.search = new URLSearchParams([['language', 'en'], ['parcelNumber', normalizeMatkahuoltoNumber(raw).query]]).toString();
  return url.toString();
}

export class MatkahuoltoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = matkahuoltoTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        'User-Agent': userAgentOf(this.options.userAgent), Accept: 'application/json',
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MATKAHUOLTO_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...MISSING], fetcher: this.options.fetcher });
      const text = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (response.status !== 200 || response.headers.get('x-amzn-waf-action')) {
        if (response.headers.get('x-amzn-waf-action') || CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER);
        if (MISSING.includes(response.status) || REDIRECTS.includes(response.status)) {
          throw new TransportError(PROVIDER, 'Matkahuolto tracking service is unavailable');
        }
        throw new IndeterminateError(PROVIDER, `Matkahuolto answered with HTTP ${response.status}`);
      }
      // The page shows nothing for an empty reply.
      if (!text) throw new IndeterminateError(PROVIDER, 'Matkahuolto returned an empty reply');
      let reply: unknown;
      try {
        reply = JSON.parse(text);
      } catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Matkahuolto answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'Matkahuolto returned a reply that is not JSON', { cause });
      }
      return parseMatkahuolto(reply, raw);
    };
    // A request that fails to reach Matkahuolto, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'matkahuolto', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MatkahuoltoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'matkahuolto', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMatkahuoltoRecognitionNumber(number))),
  };
};
