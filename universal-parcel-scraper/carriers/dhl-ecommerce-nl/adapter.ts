import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeDhlEcommerceNlNumber, parseDhlEcommerceNl, parseDhlEcommerceNlNotFound } from './parser.js';

const PROVIDER = 'DHL eCommerce Netherlands';
// The gateway behind my.dhlecommerce.nl. A key without a postcode returns the
// public history and none of the recipient's details.
const ENDPOINT = 'https://api-gw.dhlparcel.nl/track-trace';

export class DhlEcommerceNlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDhlEcommerceNlNumber(raw);
    return runSteps({ carrier: 'dhl-ecommerce-nl', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      if (remainingMs <= 0) throw new BudgetExceededError(PROVIDER, context.budgetMs ?? 15_000);
      const url = new URL(ENDPOINT);
      url.searchParams.set('key', number);
      const { response, bytes } = await fetchBounded(url, { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 2_000_000,
        allowHttpStatuses: [404], fetcher: this.options.fetcher,
      });
      if (response.status === 404) return parseDhlEcommerceNlNotFound(new TextDecoder().decode(bytes));
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Netherlands returned an inconclusive tracking response');
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) { throw new SchemaError(PROVIDER, 'DHL eCommerce Netherlands returned invalid tracking JSON', { cause }); }
      return parseDhlEcommerceNl(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DhlEcommerceNlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'dhl-ecommerce-nl', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDhlEcommerceNlNumber(number))) };
};
