import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ELTA_MAX_BYTES, normalizeEltaNumber, parseElta, PROVIDER } from './parser.js';

// The tracking page on www.elta.gr posts the codes it looks up here.
export const ELTA_ENDPOINT = 'https://www.elta.gr/trackApi';
// The tracker's language switch: 2 is English, 1 Greek.
const ENGLISH = '2';
// An Akamai block page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*Access Denied|errors\.edgesuite\.net|bm-verify|sec-if-cpt/i;

export class EltaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEltaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      try {
        ({ bytes } = await fetchBounded(ELTA_ENDPOINT, { method: 'POST', signal, headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': userAgentOf(this.options.userAgent),
        }, body: new URLSearchParams([['code[]', number], ['in_lang', ENGLISH]]).toString() },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ELTA_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        // A missing route is not a missing item: the tracker answers unknown codes with a notice.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'ELTA tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
      const text = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      // The page shows nothing for an empty reply.
      if (!text) throw new IndeterminateError(PROVIDER, 'ELTA returned an empty reply');
      let payload: unknown;
      try { payload = JSON.parse(text); }
      catch (cause) {
        if (BLOCKED.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ELTA answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'ELTA returned invalid tracking JSON', { cause });
      }
      return parseElta(payload, number);
    };
    // A request that fails to reach ELTA, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'elta', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EltaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'elta', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEltaNumber(number))),
  };
};
