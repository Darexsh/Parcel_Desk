import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePostexNumber, parsePostex, POSTEX_MAX_BYTES, PROVIDER } from './parser.js';

/** The lookup the tracking page on postex.pk makes for the number in `cn` or typed in. */
export const POSTEX_API = 'https://postex.pk/api/tracking-order';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Bot checks and block pages Cloudflare could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenges\.cloudflare\.com|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'PostEx answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'PostEx returned a reply that is not JSON', { cause });
  }
}

export class PostexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostexNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(POSTEX_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ trackingNumber: number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: POSTEX_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'PostEx redirected its tracking lookup');
      // The page reads a missing parcel from a 200 reply; a 404 is a moved route.
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'PostEx tracking lookup is unavailable');
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'PostEx refused the lookup', { status: 403 });
      return parsePostex(json(decodeText(bytes)), number);
    };
    return runSteps({ carrier: 'postex', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'postex', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePostexNumber(number))),
  };
};
