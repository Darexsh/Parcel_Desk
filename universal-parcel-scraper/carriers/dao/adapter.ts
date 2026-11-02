import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { DAO_MAX_BYTES, normalizeDaoNumber, parseDao, PROVIDER } from './parser.js';

// The service dao.as/find-din-pakke asks, without a key, nonce or cookie.
export const DAO_ENDPOINT = 'https://dao.as/wp-json/dao-wp/v1/track-parcel';
// A WordPress or edge block page instead of the service's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied|403 Forbidden)|cf-chl-|cf-turnstile|captcha/i;

/** The service's address for one number, with English wording. */
export function daoTrackingUrl(raw: string): string {
  return `${DAO_ENDPOINT}?${new URLSearchParams({ barcode: normalizeDaoNumber(raw).number, lang: 'EN' })}`;
}

export class DaoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = daoTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      let status: number;
      try {
        // The page sends its WordPress nonce, which the service does not need
        // without a session cookie.
        ({ bytes, response: { status } } = await fetchBounded(url, { signal,
          headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DAO_MAX_BYTES, fetcher: this.options.fetcher,
          allowHttpStatuses: [400] }));
      } catch (error) {
        // An unknown number is {"found":false}; a missing route is not a missing parcel.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'DAO tracking service is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'DAO answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'DAO returned invalid tracking JSON', { cause });
      }
      // The service names a request it cannot read, such as one without a number.
      if (status === 400) throw new IndeterminateError(PROVIDER, 'DAO rejected the tracking request');
      return parseDao(payload, raw);
    };
    // A request that fails to reach DAO, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'dao', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DaoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dao', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDaoNumber(number))),
  };
};
