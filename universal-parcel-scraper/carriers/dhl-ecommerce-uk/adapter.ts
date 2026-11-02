import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, IndeterminateError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeDhlEcommerceUkNumber, parseDhlEcommerceUk } from './parser.js';

const PROVIDER = 'DHL eCommerce UK';
// The tracking page renders the journey on the server for a number given in
// the address. No postcode is sent: a wrong one hides an existing shipment.
const ENDPOINT = 'https://track.dhlecommerce.co.uk/';

export class DhlEcommerceUkTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDhlEcommerceUkNumber(raw);
    return runSteps({ carrier: 'dhl-ecommerce-uk', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      if (remainingMs <= 0) throw new BudgetExceededError(PROVIDER, context.budgetMs ?? 15_000);
      const url = new URL(ENDPOINT);
      url.searchParams.set('con', number);
      const { response, bytes } = await fetchBounded(url, { signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 2_000_000, fetcher: this.options.fetcher,
      });
      // The page answers 200 for a found and for an unknown shipment alike.
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'DHL eCommerce UK returned an inconclusive tracking response');
      return parseDhlEcommerceUk(decodeText(bytes, 'utf-8'), number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DhlEcommerceUkTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'dhl-ecommerce-uk', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDhlEcommerceUkNumber(number))) };
};
