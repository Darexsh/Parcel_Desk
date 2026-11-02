import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { LA_POSTE_SENEGAL_MAX_BYTES, normalizeLaPosteSenegalNumber, parseLaPosteSenegal, PROVIDER } from './parser.js';

/** The lookup the tracking box on laposte.sn's home page makes for the code typed in. */
export const LA_POSTE_SENEGAL_API = 'https://www.laposte.sn/wp-json/lp/v1/track';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown code in its reply: a missing route is not a missing item.
const GONE = [404, 405, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|captcha|Request Rejected/i;

export function laPosteSenegalLookupUrl(number: string): string {
  return `${LA_POSTE_SENEGAL_API}?${new URLSearchParams({ code: number })}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'La Poste du Sénégal answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'La Poste du Sénégal returned a reply that is not JSON', { cause });
  }
}

export class LaPosteSenegalTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLaPosteSenegalNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(laPosteSenegalLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LA_POSTE_SENEGAL_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'La Poste du Sénégal tracking lookup is unavailable', { status: response.status });
      }
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      // The home page shows its connection error for an empty reply.
      if (!body) throw new IndeterminateError(PROVIDER, 'La Poste du Sénégal returned an empty reply');
      return parseLaPosteSenegal(json(body), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'la-poste-senegal', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LaPosteSenegalTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'la-poste-senegal', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLaPosteSenegalNumber(number))),
  };
};
