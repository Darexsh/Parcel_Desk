import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { INTERNET_EXPRESS_MAX_BYTES, normalizeInternetExpressNumber, parseInternetExpress, PROVIDER, SHIP_LOGIC_PROVIDER_ID } from './parser.js';

/** The lookup Internet Express's portal on Ship Logic makes for the reference typed in. */
export const INTERNET_EXPRESS_API = 'https://api.portal.internetexpress.co.za/tracking/shipments';
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|AwsWafIntegration|awswaf\.com|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Internet Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Internet Express returned a reply that is not JSON', { cause });
  }
}

export class InternetExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeInternetExpressNumber(raw);
    return runSteps({ carrier: 'internet-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const url = new URL(INTERNET_EXPRESS_API);
      url.searchParams.set('tracking_reference', number);
      url.searchParams.set('provider_id', String(SHIP_LOGIC_PROVIDER_ID));
      const { response, bytes } = await fetchBounded(url, { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: INTERNET_EXPRESS_MAX_BYTES,
        allowHttpStatuses: [404, 410], fetcher: this.options.fetcher,
      });
      const body = decodeText(bytes);
      if (response.status === 404 || response.status === 410) {
        // The service's own answer for a reference it does not know names that reference.
        if (response.status === 404 && body.trim() === `could not find shipment or parcel with reference ${number}`) throw new NotFoundError(PROVIDER);
        throw new IndeterminateError(PROVIDER, 'Internet Express tracking lookup is unavailable', { status: response.status });
      }
      return parseInternetExpress(json(body), number);
    } }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new InternetExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'internet-express', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
