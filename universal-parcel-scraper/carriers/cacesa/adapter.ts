import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { CACESA_MAX_BYTES, normalizeCacesaNumber, parseCacesa, PROVIDER } from './parser.js';

// The service cacesa.com's tracking page asks, without a key, cookie or token.
export const CACESA_ENDPOINT = 'https://apiweb.cacesa.com/cacesa.api/api/Tracking';
const REDIRECTS = [301, 302, 303, 307, 308];

export class CacesaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    // The page also sends the visitor's IP address. The service requires the
    // field but accepts it empty, so no address is sent.
    const body = JSON.stringify({ trackingId: normalizeCacesaNumber(raw), ipAddress: '' });
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(CACESA_ENDPOINT, { method: 'POST', body, signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CACESA_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: REDIRECTS, fetcher: this.options.fetcher });
      // A moved service says nothing about the parcel.
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'CACESA tracking service moved');
      let payload: unknown;
      try {
        payload = parseJsonBytes(bytes, PROVIDER);
      } catch (cause) {
        throw new SchemaError(PROVIDER, 'CACESA returned a reply that is not JSON', { cause });
      }
      return parseCacesa(payload, raw);
    };
    // A request that fails to reach CACESA, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'cacesa', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CacesaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'cacesa', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
