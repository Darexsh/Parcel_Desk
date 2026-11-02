import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import { EGYPT_POST_MAX_BYTES, normalizeEgyptPostNumber, parseEgyptPost, PROVIDER } from './parser.js';

/** The lookup Egypt Post's tracking page and Android app make for a code, with English wording. */
export const EGYPT_POST_ENDPOINT = 'https://egyptpost.gov.eg/en-us/TrackTrace/GetShipmentDetails';
// The Android app's HTTP client, as Dart names it. The site's firewall blocks
// or challenges other clients that are not browsers, and lets the app's through.
export const EGYPT_POST_USER_AGENT = 'Dart/3.9 (dart:io)';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];
// Cloudflare's block page and browser check.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|cf-turnstile|cf-error-details/i;

export class EgyptPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEgyptPostNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${EGYPT_POST_ENDPOINT}?barcode=${encodeURIComponent(number)}`, { signal, headers: {
        Accept: 'application/json', 'User-Agent': EGYPT_POST_USER_AGENT,
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: EGYPT_POST_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      // The tracker answers an unknown code in its reply: a missing route is not a missing item.
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Egypt Post tracking lookup is unavailable', { status: response.status });
      }
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Egypt Post refused the lookup at its firewall', { status: 403 });
      const text = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (!text) throw new IndeterminateError(PROVIDER, 'Egypt Post returned an empty reply');
      let payload: unknown;
      try { payload = JSON.parse(text); }
      catch (cause) {
        if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Egypt Post answered with a browser check', { cause });
        throw new SchemaError(PROVIDER, 'Egypt Post returned a reply that is not JSON', { cause });
      }
      return parseEgyptPost(payload, number);
    };
    // A lookup that fails to reach Egypt Post, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'egypt-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new EgyptPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder });
  return {
    id: 'egypt-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeEgyptPostNumber(number))),
  };
};
