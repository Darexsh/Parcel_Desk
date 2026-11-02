import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeUniuniNumber, normalizeUniuniRecognitionNumber, parseUniuni } from './parser.js';
import { UniuniEstimates } from './estimate.js';

const ENDPOINT = 'https://tracking-service-api.uniuni.ca/tracking/trackinguniuninew';
// Fixed anonymous website configuration from the official tracking client;
// this is neither an account credential nor an issued browser/session token.
const WEB_KEY = 'SMq45nJhQuNR3WHsJA6N'; // gitleaks:allow

export class UniuniTracker {
  private readonly estimates: UniuniEstimates;
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {
    this.estimates = new UniuniEstimates({ fetcher: options.fetcher, userAgent: userAgentOf(options.userAgent) });
  }

  async fetch(raw: string, context: TrackingContext = {}, enrich = true) {
    const number = normalizeUniuniNumber(raw);
    return runSteps({ carrier: 'uniuni', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const deadline = performance.now() + remainingMs;
      let bytes: Uint8Array;
      try {
        const params = new URLSearchParams({ id: number, key: WEB_KEY, source: 'web' });
        ({ bytes } = await fetchBounded(`${ENDPOINT}?${params}`, { signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } }, {
          provider: 'UniUni', timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher,
        }));
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError('UniUni', 'UniUni tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, 'UniUni'); }
      catch (cause) { throw new SchemaError('UniUni', 'UniUni returned invalid tracking JSON', { cause }); }
      const result = parseUniuni(payload, number);
      if (enrich && result.status !== 'delivered' && !['returned', 'return_started'].includes(result.current_stage ?? '')
        && result.provider_leg !== 'return') {
        try { Object.assign(result, await this.estimates.fetch(number, { signal, remainingMs: deadline - performance.now() })); }
        catch { /* Optional estimates cannot discard independently verified history. */ }
      }
      context.signal?.throwIfAborted();
      return result;
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new UniuniTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'uniuni', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context, false),
      () => accepted(() => normalizeUniuniRecognitionNumber(number))) };
};
