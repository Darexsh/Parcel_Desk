import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeVintedGoNumber, parseVintedGo, parseVintedGoMissing, PROVIDER, VINTED_GO_MAX_BYTES } from './parser.js';

// The service the tracker's search box asks before it opens a parcel's page.
export const VINTED_GO_ENDPOINT = 'https://carrier.vintedgo.com/public/v3/tracking_events/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Cloudflare's challenge page, which can come instead of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>Just a moment/i;

export function vintedGoTrackingUrl(raw: string): string {
  return `${VINTED_GO_ENDPOINT}${normalizeVintedGoNumber(raw)}`;
}

export class VintedGoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = vintedGoTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The scans are worded in the language asked for; English is the one the map and the place rules read.
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: VINTED_GO_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, 404], fetcher: this.options.fetcher });
      const text = decodeText(bytes);
      if (response.status === 404) return parseVintedGoMissing(text, response.headers.get('content-type'));
      // A moved service says nothing about the parcel.
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Vinted Go tracking service moved');
      let reply: unknown;
      try {
        reply = JSON.parse(text);
      } catch (error) {
        if (CHALLENGE.test(text)) throw new ChallengeError(PROVIDER, 'Vinted Go answered with a browser challenge', { cause: error });
        throw new SchemaError(PROVIDER, 'Vinted Go returned a reply that is not JSON', { cause: error });
      }
      return parseVintedGo(reply, raw);
    };
    // A request that fails to reach Vinted Go, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'vinted-go', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new VintedGoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'vinted-go', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeVintedGoNumber(number))),
  };
};
