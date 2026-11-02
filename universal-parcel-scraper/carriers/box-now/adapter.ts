import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { BOX_NOW_MAX_BYTES, normalizeBoxNowNumber, parseBoxNow, PROVIDER } from './parser.js';

// The tracker on boxnow.cy posts here. The Greek, Bulgarian and Croatian sites
// post to their own hosts, which answer the same parcels.
export const BOX_NOW_ENDPOINT = 'https://api-production.boxnow.cy/api/v1/parcels:track';

export class BoxNowTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeBoxNowNumber(raw);
    return runSteps({ carrier: 'box-now', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      let bytes: Uint8Array;
      try {
        ({ bytes } = await fetchBounded(BOX_NOW_ENDPOINT, { method: 'POST', signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
          body: JSON.stringify({ parcelId: number }) },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: BOX_NOW_MAX_BYTES, fetcher: this.options.fetcher }));
      } catch (error) {
        // An unknown parcel is an empty list; a missing route is not a missing parcel.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'BOX NOW tracking endpoint is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        // The Greek site sits behind Cloudflare's challenge; the API could too.
        if (/<title>\s*Just a moment|cf-chl-|challenge-platform|cf-turnstile/i.test(decodeText(bytes.subarray(0, 64_000)))) {
          throw new ChallengeError(PROVIDER, 'BOX NOW answered with a browser challenge', { cause });
        }
        throw new SchemaError(PROVIDER, 'BOX NOW returned invalid tracking JSON', { cause });
      }
      return parseBoxNow(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new BoxNowTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'box-now', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBoxNowNumber(number))) };
};
