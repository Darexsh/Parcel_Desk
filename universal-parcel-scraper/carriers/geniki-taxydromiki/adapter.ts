import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeGenikiNumber, parseGeniki, PROVIDER } from './parser.js';

/** The tracking page's own lookup, which relays Geniki's voucher web service. */
const ENDPOINT = 'https://taxydromiki.com/external_scripts/track-site.php';
// Cloudflare's interstitial, served with a 200 or a 403.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required)|\bcf[-_]chl|challenge-platform/i;

export class GenikiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeGenikiNumber(raw);
    return runSteps({ carrier: 'geniki-taxydromiki', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      signal.throwIfAborted();
      const { response, bytes } = await fetchBounded(ENDPOINT, { method: 'POST', signal,
        // The page sends a JSON body under a form content type; English words the checkpoints in English.
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': userAgentOf(this.options.userAgent) },
        body: JSON.stringify({ lang: 'en', voucherNo: number }),
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 1_000_000,
        allowHttpStatuses: [404, 410], fetcher: this.options.fetcher });
      // A missing lookup script says nothing about the parcel.
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Geniki Taxydromiki tracking is unavailable');
      const text = decodeText(bytes.subarray(0, 4_096));
      if (CHALLENGE.test(text)) throw new ChallengeError(PROVIDER, 'Geniki Taxydromiki asked for a browser check');
      if (!text.trim()) throw new IndeterminateError(PROVIDER, 'Geniki Taxydromiki returned an empty reply');
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) { throw new SchemaError(PROVIDER, 'Geniki Taxydromiki returned invalid tracking JSON', { cause }); }
      return parseGeniki(payload, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new GenikiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'geniki-taxydromiki', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGenikiNumber(number))) };
};
