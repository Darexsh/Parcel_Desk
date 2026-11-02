import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  normalizePostaNorthMacedoniaNumber, parsePostaNorthMacedonia, parsePostaNorthMacedoniaBody, POSTA_NORTH_MACEDONIA_MAX_BYTES, PROVIDER,
} from './parser.js';

/** The lookup posta.com.mk's tracking page makes for the code in its field or its `tn` parameter. */
export const POSTA_NORTH_MACEDONIA_API = 'https://www.posta.com.mk/api/api.php/shipment';
const REDIRECTS = [301, 302, 303, 307, 308];
// The service answers an unknown code in its reply: a missing route is not a missing item.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export function postaNorthMacedoniaLookupUrl(number: string): string {
  return `${POSTA_NORTH_MACEDONIA_API}?code=${encodeURIComponent(number)}`;
}

export class PostaNorthMacedoniaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostaNorthMacedoniaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(postaNorthMacedoniaLookupUrl(number), { method: 'GET', signal, headers: {
        // What the page's getJSON call asks for.
        Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: POSTA_NORTH_MACEDONIA_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Pošta na Severna Makedonija tracking lookup is unavailable', { status: response.status });
      }
      return parsePostaNorthMacedonia(parsePostaNorthMacedoniaBody(decodeText(bytes).replace(/^\uFEFF/, '').trim()), number);
    };
    // A lookup that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'posta-north-macedonia', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostaNorthMacedoniaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'posta-north-macedonia', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePostaNorthMacedoniaNumber(number))),
  };
};
