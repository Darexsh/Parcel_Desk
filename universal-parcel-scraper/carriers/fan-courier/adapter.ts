import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeFanCourierNumber, parseFanCourier, PROVIDER } from './parser.js';

/** The tracking page's own lookup, which it posts as a form. */
const ENDPOINT = 'https://www.fancourier.ro/limit-tracking.php';
// Cloudflare's interstitial, served with a 200 or a 403.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required)|\bcf[-_]chl|challenge-platform/i;

export class FanCourierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeFanCourierNumber(raw);
    return runSteps({ carrier: 'fan-courier', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(ENDPOINT, { method: 'POST', signal,
        headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
        // The English page's locale, which words the events in English.
        body: new URLSearchParams({ action: 'get_awb', awb: number, lang: 'en-US' }),
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000,
        allowHttpStatuses: [404, 422], fetcher: this.options.fetcher });
      // The number was checked before the request: a rejection or a missing page says nothing about the parcel.
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'FAN Courier tracking is unavailable');
      const text = decodeText(bytes.subarray(0, 4_096));
      if (CHALLENGE.test(text)) throw new ChallengeError(PROVIDER, 'FAN Courier asked for a browser check');
      // The page asks again after an empty reply, as after a rate limit.
      if (!text.trim()) throw new IndeterminateError(PROVIDER, 'FAN Courier returned an empty reply');
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) { throw new SchemaError(PROVIDER, 'FAN Courier returned invalid tracking JSON', { cause }); }
      return parseFanCourier(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new FanCourierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'fan-courier', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFanCourierNumber(number))) };
};
