import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { GOFO_US, normalizeGofoNumber, parseGofo, type GofoSite } from './parser.js';

export class GofoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {},
    private readonly site: GofoSite = GOFO_US) {}
  async fetch(raw: string, context: TrackingContext = {}) {
    const { site } = this;
    const number = normalizeGofoNumber(raw, site);
    return runSteps({ carrier: site.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      try {
        const { bytes } = await fetchBounded(`https://www.gofo.com/${site.path}/cnee-api/consignee/track/query/page`, { method: 'POST', signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', lang: 'en', 'User-Time-Zone': site.clockZone,
            'User-Agent': userAgentOf(this.options.userAgent) },
          body: JSON.stringify({ numberList: [number] }) }, { provider: site.provider, timeoutMs: Math.max(1, Math.floor(remainingMs)),
          maxBytes: 1_000_000, fetcher: this.options.fetcher });
        let payload: unknown;
        try { payload = parseJsonBytes(bytes, site.provider); } catch (cause) { throw new SchemaError(site.provider, 'GOFO returned invalid tracking JSON', { cause }); }
        return parseGofo(payload, number, site);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError(site.provider, 'GOFO tracking endpoint is unavailable', { cause: error });
        throw error;
      }
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new GofoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'gofo', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeGofoNumber(number))) };
};
