import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePostaRomanaNumber, parsePostaRomana, POSTA_ROMANA_MAX_BYTES, PROVIDER } from './parser.js';

/** The lookup Poșta Română's Android app makes for a number. */
export const POSTA_ROMANA_ENDPOINT = 'https://api.posta-romana.ro/api/track-trace';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];
// A bot check a CDN could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)/i;

export class PostaRomanaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostaRomanaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(POSTA_ROMANA_ENDPOINT, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams([['awb', number]]).toString() },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: POSTA_ROMANA_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      // A missing route is not a missing item: the lookup answers unknown codes with a flag.
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Poșta Română tracking lookup is unavailable', { status: response.status });
      }
      // The server refuses some networks outright.
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Poșta Română refused the lookup', { status: 403 });
      // The reply is JSON labelled as HTML.
      const text = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (!text) throw new IndeterminateError(PROVIDER, 'Poșta Română returned an empty reply');
      let payload: unknown;
      try { payload = JSON.parse(text); }
      catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Poșta Română answered with a browser check', { cause });
        throw new SchemaError(PROVIDER, 'Poșta Română returned a reply that is not JSON', { cause });
      }
      return parsePostaRomana(payload, number);
    };
    // A lookup that fails to reach Poșta Română, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'posta-romana', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostaRomanaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'posta-romana', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePostaRomanaNumber(number))),
  };
};
