import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeGofoFranceNumber, normalizeRegionalGofoNumber, parseGofoFrance, regionalGofoRequestNumber, type GofoRegion } from './parser.js';

export class RegionalGofoTracker {
  constructor(private readonly region: GofoRegion, private readonly parse: (payload: unknown, number: string) => CarrierResult,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeRegionalGofoNumber(raw, this.region);
    const country = this.region.toLowerCase(), provider = `GOFO ${this.region}`;
    return runSteps({ carrier: `gofo-${country}`, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      try {
        const { bytes } = await fetchBounded(`https://www.gofo.com/${country}/open-api/official/track/queryTrackV2`, { method: 'POST', signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', lang: country, 'User-Agent': userAgentOf(this.options.userAgent) },
          body: JSON.stringify({ numberList: [regionalGofoRequestNumber(number)] }) }, { provider,
          timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000, fetcher: this.options.fetcher });
        let payload: unknown;
        try { payload = parseJsonBytes(bytes, provider); } catch (cause) {
          if (/<title>\s*Just a moment|cf-chl-|challenge-platform|cf-turnstile/i.test(decodeText(bytes))) throw new ChallengeError(provider);
          throw new SchemaError(provider, 'GOFO returned invalid tracking JSON', { cause });
        }
        return this.parse(payload, number);
      } catch (error) {
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(provider, 'GOFO tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
    } }]);
  }
}

export class GofoFranceTracker extends RegionalGofoTracker {
  constructor(options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) { super('FR', parseGofoFrance, options); }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new GofoFranceTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'gofo-fr', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeGofoFranceNumber(number))) };
};
