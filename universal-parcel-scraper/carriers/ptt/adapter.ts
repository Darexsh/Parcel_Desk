import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePttNumber, parsePtt, PROVIDER, PTT_MAX_BYTES } from './parser.js';

// The shipment query of PTT's own app, PTT Mobil. It needs no account, key or token.
export const PTT_ENDPOINT = 'https://pttreklamws.ptt.gov.tr/PttBirlesikMobil/takip/gonderiSorgulav2';
// PTT's firewall sends a request it turns away to its home page.
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing item: the service answers unknown barcodes with a notice.
const GONE = [404, 410];
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Just a moment)|requested URL was rejected|_cf_chl_opt|cf-turnstile/i;

export class PttTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePttNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(PTT_ENDPOINT, { method: 'POST', signal, headers: {
        Accept: 'application/json',
        // The service words its notices in English for other languages.
        'Accept-Language': 'tr',
        'Content-Type': 'application/json',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ barkod: number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: PTT_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new ChallengeError(PROVIDER, 'PTT turned the lookup away to another page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'PTT tracking service is unavailable');
      const text = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (!text) throw new IndeterminateError(PROVIDER, 'PTT returned an empty reply');
      let payload: unknown;
      try { payload = JSON.parse(text); }
      catch (cause) {
        if (BLOCKED.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'PTT answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'PTT returned invalid tracking JSON', { cause });
      }
      return parsePtt(payload, number);
    };
    // A request that fails to reach PTT, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'ptt', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PttTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ptt', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePttNumber(number))),
  };
};
