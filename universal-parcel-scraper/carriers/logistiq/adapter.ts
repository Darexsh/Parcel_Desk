import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { LOGISTIQ_MAX_BYTES, normalizeLogistiqNumber, parseLogistiq, PROVIDER } from './parser.js';

/** The lookup the tracking page on gecko.logistiq.io makes for the waybill in its address. */
export const LOGISTIQ_API = 'https://robin.logistiq.io/v1/order-details';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the service, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required|cf-error-details/i;

/** The lookup's address for one waybill. */
export function logistiqLookupUrl(number: string): string {
  return `${LOGISTIQ_API}?alpha_awb=${encodeURIComponent(normalizeLogistiqNumber(number))}`;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Logistiq answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Logistiq returned a reply that is not JSON', { cause });
  }
}

export class LogistiqTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLogistiqNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(logistiqLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LOGISTIQ_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Logistiq redirected its tracking lookup');
      // The page reads an unknown waybill from an HTTP 400 reply; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Logistiq tracking lookup is unavailable');
      const payload = json(decodeText(bytes));
      if (response.status === 400 && !(isRecord(payload) && payload.status === false)) {
        throw new SchemaError(PROVIDER, 'Logistiq refused the lookup without its answer for an unknown waybill');
      }
      return parseLogistiq(payload, number);
    };
    // A request that fails to reach the service, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'logistiq', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LogistiqTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'logistiq', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLogistiqNumber(number))),
  };
};
