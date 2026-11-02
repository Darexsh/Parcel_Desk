import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { MAERSK_MAX_BYTES, normalizeMaerskNumber, parseMaersk, PROVIDER } from './parser.js';

/** The parcel page, which opens one parcel from its path. */
export const MAERSK_PAGE = 'https://www.maersk.com/tracking/parcel/';
/** The lookup that page makes for one parcel. */
export const MAERSK_API = 'https://api.maersk.com/ecommerce/tracking/public/packages/';
/** The consumer key Maersk's site sends every visitor with that lookup. */
export const MAERSK_CONSUMER_KEY = 'ooSqJh6xLjNGWf0kNLlrC6eAQGIVHdpI'; // gitleaks:allow

export class MaerskTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMaerskNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${MAERSK_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'Consumer-Key': MAERSK_CONSUMER_KEY, Origin: 'https://www.maersk.com',
        Referer: `${MAERSK_PAGE}${number}`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAERSK_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [301, 302, 303, 307, 308, 401, 404] });
      // An unknown parcel is a 404 with an empty body. A refused key or a moved
      // route is no answer about the parcel.
      if (response.status === 404 && bytes.length === 0) throw new NotFoundError(PROVIDER);
      if (response.status === 401) throw new TransportError(PROVIDER, 'Maersk eCommerce refused its consumer key', { status: response.status });
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Maersk eCommerce tracking lookup moved', { status: response.status });
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); } catch (cause) { throw new SchemaError(PROVIDER, 'Maersk eCommerce returned invalid tracking JSON', { cause }); }
      return parseMaersk(payload, number);
    };
    // A read that fails to reach the site, or hangs, gets one more: the first gets half of the budget.
    return runSteps({ carrier: 'maersk-ecommerce', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MaerskTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'maersk-ecommerce', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMaerskNumber(number))),
  };
};
