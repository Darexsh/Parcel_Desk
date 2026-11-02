import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  AM_HOME_DELIVERY_MAX_BYTES, isAmHomeDeliveryBlockPage, normalizeAmHomeDeliveryNumber, parseAmHomeDelivery, PROVIDER,
} from './parser.js';

/** The address the tracking form on amtrucking.com sends a number to. It redirects to the page that shows the shipment. */
export const AM_HOME_DELIVERY_LOOKUP = 'https://www.amtrucking.com/track-number.php';
/** Where that page lives: a NetSuite script of the carrier's account, whose access parameter the redirect carries. */
const PAGE_ORIGIN = 'https://4301600.extforms.netsuite.com';
const PAGE_PATH = '/app/site/hosting/scriptlet.nl';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

/** The lookup's address for one whole track number, as the tracking form builds it. */
export function amHomeDeliveryLookupUrl(raw: string): string {
  return `${AM_HOME_DELIVERY_LOOKUP}?${new URLSearchParams({ cnumber: normalizeAmHomeDeliveryNumber(raw) })}`;
}

/** The tracking page the lookup's redirect points to, which must carry the number asked and nothing else as its number. */
export function amHomeDeliveryPageUrl(location: string | null, number: string): string {
  if (!location || location.length > 2_000) throw new SchemaError(PROVIDER, 'AM Home Delivery returned an incomplete redirect');
  let url: URL;
  try {
    url = new URL(location, AM_HOME_DELIVERY_LOOKUP);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'AM Home Delivery returned an invalid redirect', { cause });
  }
  if (url.origin !== PAGE_ORIGIN || url.pathname !== PAGE_PATH || url.hash) {
    throw new SchemaError(PROVIDER, 'AM Home Delivery redirected the lookup to an unexpected address');
  }
  const numbers = url.searchParams.getAll('number');
  if (numbers.length !== 1 || numbers[0] !== number) throw new IndeterminateError(PROVIDER, 'AM Home Delivery redirected the lookup to another number');
  return url.href;
}

export class AmHomeDeliveryTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAmHomeDeliveryNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const request = async (address: string) => {
        const result = await fetchBounded(address, { method: 'GET', signal, headers: {
          Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: AM_HOME_DELIVERY_MAX_BYTES,
          redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
        if (GONE.includes(result.response.status)) {
          throw new TransportError(PROVIDER, 'AM Home Delivery tracking is unavailable', { status: result.response.status });
        }
        return result;
      };
      // The lookup the tracking form opens answers with a redirect to the shipment's page.
      const lookup = await request(amHomeDeliveryLookupUrl(number));
      if (!REDIRECTS.includes(lookup.response.status)) {
        if (isAmHomeDeliveryBlockPage(decodeText(lookup.bytes))) throw new ChallengeError(PROVIDER, 'AM Home Delivery answered with a block page');
        throw new SchemaError(PROVIDER, 'AM Home Delivery did not redirect the lookup to its tracking page');
      }
      signal.throwIfAborted();
      const page = await request(amHomeDeliveryPageUrl(lookup.response.headers.get('location'), number));
      if (REDIRECTS.includes(page.response.status)) throw new TransportError(PROVIDER, 'AM Home Delivery redirected its tracking page');
      return parseAmHomeDelivery(decodeText(page.bytes), number);
    };
    // A lookup that fails to reach the carrier, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'am-home-delivery', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AmHomeDeliveryTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'am-home-delivery', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAmHomeDeliveryNumber(number))),
  };
};
