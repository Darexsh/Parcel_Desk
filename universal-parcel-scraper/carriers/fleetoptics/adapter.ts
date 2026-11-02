import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FLEETOPTICS_MAX_BYTES, normalizeFleetopticsNumber, parseFleetoptics, PROVIDER } from './parser.js';

/** FleetOptics' tracking page; its search form sends the number back to it as `tracking_number`. */
export const FLEETOPTICS_TRACKING = 'https://track.fleetopticsinc.com/';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The tracking page's address for one number, as its search form builds it. */
export function fleetopticsTrackingUrl(raw: string): string {
  return `${FLEETOPTICS_TRACKING}?tracking_number=${encodeURIComponent(normalizeFleetopticsNumber(raw))}`;
}

/** The barcode a redirect names, which the service sends a number that is not one to. */
function redirectedNumber(location: string | null): string {
  try {
    return (new URL(location ?? '', FLEETOPTICS_TRACKING).searchParams.get('tracking_number') ?? '').toUpperCase();
  } catch {
    return '';
  }
}

export class FleetopticsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFleetopticsNumber(raw);
    const url = fleetopticsTrackingUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FLEETOPTICS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) {
        // The service sends a number it files under another barcode to that barcode's page.
        const target = redirectedNumber(response.headers.get('location'));
        if (target && target !== number) throw new IndeterminateError(PROVIDER, 'FleetOptics answered for another number');
        throw new TransportError(PROVIDER, 'FleetOptics redirected its tracking page');
      }
      // The page answers an unknown number with a notice; a missing page is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'FleetOptics tracking page is unavailable');
      return parseFleetoptics(decodeText(bytes), number, (this.options.now ?? Date.now)());
    };
    // A request that fails to reach the service, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'fleetoptics', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url, maxBytes: FLEETOPTICS_MAX_BYTES,
        parse: html => parseFleetoptics(html, number, (this.options.now ?? Date.now)()) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FleetopticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  const http = new FleetopticsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'fleetoptics', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeFleetopticsNumber(number))),
  };
};
