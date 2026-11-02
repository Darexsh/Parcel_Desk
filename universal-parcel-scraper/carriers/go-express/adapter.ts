import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GO_EXPRESS_MAX_BYTES, normalizeGoExpressNumber, parseGoExpress, PROVIDER } from './parser.js';

// The service GO!'s tracking pages post their search to. It answers with the
// HTML fragment the page inserts.
export const GO_EXPRESS_ENDPOINT = 'https://www.general-overnight.com/api/v2/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing shipment: unknown waybills get a notice.
const GONE = [404, 410];

/**
 * The form body the page sends: its search as base64 JSON, with the country
 * and language of the page. Germany's English page answers in English; every
 * GO! country's page reads the same shipments.
 */
export function goExpressRequestBody(number: string): string {
  return new URLSearchParams({ q: btoa(JSON.stringify({ q: number, country: 'deu', language: 'en' })) }).toString();
}

export class GoExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGoExpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(GO_EXPRESS_ENDPOINT, { method: 'POST', signal, body: goExpressRequestBody(number),
        headers: {
          Accept: 'text/html',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GO_EXPRESS_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'GO! Express sent the lookup to another page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'GO! Express tracking service is unavailable');
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'GO! Express returned an empty reply');
      return parseGoExpress(html, number);
    };
    // A request that fails to reach GO!, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'go-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GoExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'go-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeGoExpressNumber(number))),
  };
};
