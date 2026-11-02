import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { BOSTA_MAX_BYTES, normalizeBostaNumber, parseBosta, PROVIDER } from './parser.js';

/** The lookup the tracking page on bosta.co makes for the number in its address, in English. */
export const BOSTA_API = 'https://tracking.bosta.co/shipments/track/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)|AwsWafIntegration|awswaf\.com/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Bosta answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Bosta returned a reply that is not JSON', { cause });
  }
}

/** The service's own answer to a number it does not know: `{"error":"Invalid tracking number!","status":"Not Found."}`. */
function unknownNumber(body: string): boolean {
  try {
    const reply: unknown = JSON.parse(body);
    return isRecord(reply) && typeof reply.error === 'string' && /invalid tracking number/i.test(reply.error);
  } catch {
    return false;
  }
}

export class BostaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBostaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // Without the page's X-Requested-By header the service answers in an older shape.
      const { response, bytes } = await fetchBounded(`${BOSTA_API}${number}?lang=en`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'X-Requested-By': 'Bosta', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BOSTA_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Bosta redirected its tracking lookup');
      const body = decodeText(bytes);
      if (response.status === 404 && unknownNumber(body)) throw new NotFoundError(PROVIDER);
      if (response.status === 404 || response.status === 410) {
        if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Bosta answered with a browser check', { status: response.status });
        throw new TransportError(PROVIDER, 'Bosta tracking lookup is unavailable', { status: response.status });
      }
      return parseBosta(json(body), number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'bosta', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BostaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'bosta', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBostaNumber(number))),
  };
};
