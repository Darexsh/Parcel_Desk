import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, isNetworkFailure } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { CttExpressErrorReply, normalizeCttExpressNumber, parseCttExpress } from './parser.js';

const ENDPOINT = 'https://wct.cttexpress.com/p_track_redis_v2.php';

/** A body that is not JSON. */
class UnreadableReply extends SchemaError {}
/** An empty body, read once more before it stands for no shipment. */
class EmptyReply extends UnreadableReply {}

export class CttExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeCttExpressNumber(raw);
    let empty = 0;
    const read = async (signal: AbortSignal, timeoutMs: number) => {
      signal.throwIfAborted();
      const url = new URL(ENDPOINT);
      url.searchParams.set('sc', number);
      const { response, bytes } = await fetchBounded(url, { signal, headers: { Accept: 'application/json',
        Origin: 'https://shipping-tracking.production.cloud2.cttexpress.com', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: 'CTT Express', timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 1_000_000,
        allowHttpStatuses: [404, 410], fetcher: this.options.fetcher });
      if (response.status !== 200) throw new IndeterminateError('CTT Express', 'CTT Express tracking endpoint is unavailable');
      // An empty body is the answer for a number with no shipment, which the tracking page
      // reads as a shipment it has not located. A real parcel's lookup can fail once with a
      // body that is not JSON, so only a second empty read in a row is that answer.
      if (!bytes.length) {
        throw ++empty > 1 ? new NotFoundError('CTT Express', 'CTT Express has no shipment under this number')
          : new EmptyReply('CTT Express', 'CTT Express returned an empty tracking reply');
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, 'CTT Express'); }
      catch (cause) { throw new UnreadableReply('CTT Express', 'CTT Express returned invalid tracking JSON', { cause }); }
      return parseCttExpress(payload, number);
    };
    // A few percent of lookups get an error reply or a body that is not JSON, and the same
    // parcel reads normally on the next poll. Those, like a request that fails to reach the
    // service, are read once more.
    return runSteps({ carrier: 'ctt-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      { id: 'retry', recovers: (error) => error instanceof CttExpressErrorReply || error instanceof UnreadableReply || isNetworkFailure(error),
        run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CttExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'ctt-express', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeCttExpressNumber(number))) };
};
