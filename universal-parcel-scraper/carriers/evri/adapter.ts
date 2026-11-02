import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeEvriNumber, parse, PROVIDER } from './parser.js';

export { normalizeEvriNumber, parse } from './parser.js';

// The international tracker linked by https://www.evri.com/track-a-parcel.
// It is separate from the domestic UK customer-tracking API.
const ENDPOINT = 'https://globaleco.app/track';
const MAX_RESPONSE_BYTES = 1_000_000;

/**
 * One bounded form POST to Evri International's tracker, with the caller's
 * signal and budget. The tracker answers an Evri barcode and the delivery
 * partner's number alike; the caller's parser binds the reply to one of them.
 */
export async function fetchEvriInternational(
  number: string,
  options: { budgetMs: number; signal?: AbortSignal; fetcher?: typeof fetch; userAgent?: string },
): Promise<string> {
  try {
    const { bytes } = await fetchBounded(ENDPOINT, {
      method: 'POST', headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(options.userAgent) },
      body: new URLSearchParams({ tracking_number: number }).toString(),
    }, {
      provider: PROVIDER, maxBytes: MAX_RESPONSE_BYTES, timeoutMs: Math.max(1, Math.floor(options.budgetMs)),
      fetcher: (input, init) => (options.fetcher ?? fetch)(input, {
        ...init,
        signal: AbortSignal.any([...(options.signal ? [options.signal] : []), ...(init?.signal ? [init.signal] : [])]),
      }),
    });
    options.signal?.throwIfAborted();
    return decodeText(bytes);
  } catch (error) {
    // Missing parcels use HTTP 200 with the exact result heading.
    if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
      throw new TransportError(PROVIDER, 'Evri International tracking endpoint is unavailable', { cause: error });
    }
    throw error;
  }
}

export class EvriTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; timeoutMs?: number; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEvriNumber(raw);
    const budgetMs = context.budgetMs ?? this.options.timeoutMs ?? 15_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Evri timeout must be positive');
    context.signal?.throwIfAborted();
    const html = await fetchEvriInternational(number, { budgetMs, signal: context.signal, fetcher: this.options.fetcher, userAgent: this.options.userAgent });
    return parse(html, number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EvriTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'evri', steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeEvriNumber(number))),
  };
};
