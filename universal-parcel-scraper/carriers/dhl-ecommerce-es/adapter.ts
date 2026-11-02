import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeDhlEcommerceEsNumber, parseDhlEcommerceEs } from './parser.js';

const PROVIDER = 'DHL eCommerce Iberia';
// The gateway behind clientesparcel.dhl.es. A number without a postcode returns
// the public history; a wrong postcode would strip the shipment header.
const ENDPOINT = 'https://clientesparcel.dhl.es/LiveTracking.GTW/api/shipment-detail';

export class DhlEcommerceEsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeDhlEcommerceEsNumber(raw);
    return runSteps({ carrier: 'dhl-ecommerce-es', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      if (remainingMs <= 0) throw new BudgetExceededError(PROVIDER, context.budgetMs ?? 15_000);
      const url = new URL(ENDPOINT);
      url.searchParams.set('number', number);
      const { response, bytes } = await fetchBounded(url, { signal, headers: { Accept: 'application/json', 'Accept-Language': 'en-US',
        cultura: 'en', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 2_000_000,
        allowHttpStatuses: [409, 503], fetcher: this.options.fetcher,
      });
      // An unknown or purged number is an empty 204. A 409 asks for the postcode
      // of a number two shipments share.
      if (response.status === 204 && !bytes.byteLength) throw new NotFoundError(PROVIDER);
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'DHL eCommerce Iberia returned an inconclusive tracking response');
      // The firewall rejects a request with an HTML page under HTTP 200.
      if (!/json/i.test(response.headers.get('content-type') ?? '')) {
        if (/Request Rejected/i.test(decodeText(bytes.subarray(0, 2_000)))) throw new ChallengeError(PROVIDER, 'DHL eCommerce Iberia rejected the tracking request');
        throw new IndeterminateError(PROVIDER, 'DHL eCommerce Iberia returned an inconclusive tracking response');
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) { throw new SchemaError(PROVIDER, 'DHL eCommerce Iberia returned invalid tracking JSON', { cause }); }
      return parseDhlEcommerceEs(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DhlEcommerceEsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'dhl-ecommerce-es', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDhlEcommerceEsNumber(number))) };
};
