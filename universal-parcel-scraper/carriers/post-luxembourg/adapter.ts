import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizePostLuxembourgNumber, parsePostLuxembourg, POST_LUXEMBOURG_MAX_BYTES, PROVIDER } from './parser.js';

// The service the Track and Trace page on www.post.lu asks, behind POST's API gateway.
export const POST_LUXEMBOURG_ENDPOINT = 'https://api.post.lu/services/trackandtrace-api/items';
// The gateway's client id the page sends with every request, the same for
// every visitor; the page reads it from www.post.lu/ng-conf/trackandtrace-web.json.
const CLIENT_ID = '5ef1cb63-37b8-4a30-8215-57fc3bc722b9'; // gitleaks:allow
// A web application firewall or bot check's page.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Just a moment|Attention Required)|requested URL was rejected|_cf_chl_opt|cf-turnstile/i;

export class PostLuxembourgTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostLuxembourgNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      try {
        ({ bytes } = await fetchBounded(POST_LUXEMBOURG_ENDPOINT, { method: 'POST', signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Language': 'en',
            'X-IBM-Client-Id': CLIENT_ID, 'User-Agent': userAgentOf(this.options.userAgent) },
          body: JSON.stringify({ ids: [number] }) },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: POST_LUXEMBOURG_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        // A missing route is not a missing item: the service answers unknown numbers with an error word.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'POST Luxembourg tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'POST Luxembourg answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'POST Luxembourg returned invalid tracking JSON', { cause });
      }
      return parsePostLuxembourg(payload, number);
    };
    // A request that fails to reach POST Luxembourg, or hangs, gets one more
    // try: the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'post-luxembourg', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostLuxembourgTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'post-luxembourg', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePostLuxembourgNumber(number))),
  };
};
