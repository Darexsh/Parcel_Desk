import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePassportNumber, parsePassport, PASSPORT_MAX_BYTES, PASSPORT_ORIGIN, PROVIDER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker sends a merchant's shipment to the merchant's page under the same number.
const MERCHANT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.passportglobal\.com$/;

export function passportTrackingUrl(raw: string): string {
  return `${PASSPORT_ORIGIN}/${normalizePassportNumber(raw)}`;
}

/** The merchant page a redirect names, only when it is Passport's page for the same number. */
function merchantPage(location: string | null, number: string): string {
  let url: URL | null;
  try {
    url = location ? new URL(location, PASSPORT_ORIGIN) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || !MERCHANT_HOST.test(url.hostname)
    || url.pathname !== `/${number}` || url.search || url.hash) {
    throw new IndeterminateError(PROVIDER, 'Passport sent the lookup to an unexpected page');
  }
  return url.href;
}

export class PassportTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePassportNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      const get = (url: string) => fetchBounded(url, { signal, headers: {
        'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html', 'Accept-Language': 'en',
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - Date.now())), maxBytes: PASSPORT_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: REDIRECTS, fetcher: this.options.fetcher });
      let { response, bytes } = await get(passportTrackingUrl(number));
      if (REDIRECTS.includes(response.status)) {
        ({ response, bytes } = await get(merchantPage(response.headers.get('location'), number)));
        if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Passport sent the lookup on again');
      }
      return parsePassport(decodeText(bytes), number);
    };
    // A request that fails to reach Passport, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'passport', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PassportTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'passport', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePassportNumber(number))),
  };
};
