import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { AMERIJET_MAX_BYTES, normalizeAmerijetNumber, parseAmerijet, PROVIDER } from './parser.js';

/** The lookup the air waybill tracking page on amerijet.com makes for each air waybill typed in. */
export const AMERIJET_API = 'https://amerijetprod.wpenginepowered.com/api/index.php/tracking/getTrackingInfo';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the lookup, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|cf-error-details/i;

/** The lookup's address for one air waybill: the prefix and the serial without a dash, as the page sends them. */
export function amerijetLookupUrl(number: string): string {
  return `${AMERIJET_API}?awbNo=${encodeURIComponent(number)}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Amerijet answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Amerijet returned a reply that is not JSON', { cause });
  }
}

export class AmerijetTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAmerijetNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(amerijetLookupUrl(number), { signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: AMERIJET_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher });
      // An unknown air waybill is HTTP 200 with its own message: a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Amerijet tracking lookup is unavailable');
      return parseAmerijet(json(decodeText(bytes)), number);
    };
    // A read that fails to reach the lookup, or hangs, gets one more: the first gets half of
    // the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'amerijet', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AmerijetTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'amerijet', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAmerijetNumber(number))),
  };
};
