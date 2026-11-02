import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, JEEBLY_MAX_BYTES, JEEBLY_SERVICES, normalizeJeeblyNumber, parseJeebly, PROVIDER, type JeeblyService } from './parser.js';

/** Jeebly's public tracking page for the UAE, whose form submits to itself. */
export const JEEBLY_TRACKER = 'https://myjeebly.jeebly.com/shipment-tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers every lookup with HTTP 200: a missing route is not a missing shipment.
const GONE = [404, 405, 410];
// Jeebly's pages for signed-in customers send a visitor to the sign-in page.
const SIGN_IN = /\/login\b/i;

/** The tracker's address for one number and delivery service, as its form builds it. */
export function jeeblyLookupUrl(number: string, service: JeeblyService): string {
  const url = new URL(JEEBLY_TRACKER);
  url.searchParams.set('uae', 'uae');
  url.searchParams.set('service_type', service);
  url.searchParams.set('awb', number);
  return url.href;
}

export class JeeblyTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJeeblyNumber(raw);
    const read = async (service: JeeblyService, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(jeeblyLookupUrl(number, service), { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: JEEBLY_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      const status = response.status;
      const target = `${response.headers.get('location') ?? ''} ${response.headers.get('refresh') ?? ''}`;
      if (SIGN_IN.test(target)) throw new ChallengeError(PROVIDER, 'Jeebly asked for a sign-in', { status });
      if (status === 403) throw new ChallengeError(PROVIDER, 'Jeebly refused the lookup', { status });
      if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'Jeebly tracker is unavailable', { status });
      return parseJeebly(decodeText(bytes), number, service);
    };
    // The form asks for the delivery service, which the number does not show.
    // Each service is asked in turn until one has the shipment; a service that
    // answered "No Shipment Found" is not asked again by the retry.
    const answered = new Set<JeeblyService>();
    const lookup = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      for (const service of JEEBLY_SERVICES) {
        if (answered.has(service)) continue;
        try {
          return await read(service, signal, deadline - performance.now());
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
          answered.add(service);
        }
      }
      throw new NotFoundError(PROVIDER);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => lookup(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => lookup(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JeeblyTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeJeeblyNumber(number))),
  };
};
