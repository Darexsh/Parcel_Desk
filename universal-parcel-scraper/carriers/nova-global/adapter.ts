import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { NOVA_GLOBAL_MAX_BYTES, normalizeNovaGlobalNumber, parseNovaGlobal, PROVIDER } from './parser.js';

/** The lookup the tracking page on nova.global makes for the number typed in. */
export const NOVA_GLOBAL_API = 'https://personal.nova.global/tracking.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the tracker, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*Just a moment|<title>\s*Attention Required/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Nova Global answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Nova Global returned a reply that is not JSON', { cause });
  }
}

export class NovaGlobalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeNovaGlobalNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(NOVA_GLOBAL_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ num: number, lang: 'en' }).toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: NOVA_GLOBAL_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Nova Global redirected its tracking lookup');
      // The tracker answers every number with HTTP 200; a 404 is a moved route, not an unknown parcel.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Nova Global tracking lookup is unavailable');
      const body = decodeText(bytes);
      // A number the tracker does not know, or no longer keeps, gets an empty body.
      if (!body.trim()) throw new NotFoundError(PROVIDER);
      return parseNovaGlobal(json(body), number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'nova-global', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new NovaGlobalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'nova-global', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeNovaGlobalNumber(number))),
  };
};
