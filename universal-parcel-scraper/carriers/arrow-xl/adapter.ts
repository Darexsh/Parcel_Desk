import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ARROW_XL_MAX_BYTES, normalizeArrowXlNumber, normalizeArrowXlPostcode, parseArrowXl, PROVIDER } from './parser.js';

/** The form on askaxl.co.uk and on arrowxl.co.uk's home page sends the reference and postcode here. */
export const ARROW_XL_TRACKING = 'https://askaxl.co.uk/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The tracker's address for a reference and its delivery postcode, as the form builds it. */
export function arrowXlTrackingUrl(raw: string, rawPostcode: string | null | undefined): string {
  const url = new URL(ARROW_XL_TRACKING);
  url.searchParams.set('upi', normalizeArrowXlNumber(raw));
  url.searchParams.set('postcode', normalizeArrowXlPostcode(rawPostcode));
  return url.href;
}

/** The same failure without the request and response details fetchBounded attaches: the address holds the postcode. */
function withoutPostcode(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class ArrowXlTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  async fetch(raw: string, rawPostcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeArrowXlNumber(raw);
    // Without the postcode the tracker shows nothing, so no request is made.
    const url = arrowXlTrackingUrl(number, rawPostcode);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let response: Response;
      let bytes: Uint8Array;
      try {
        ({ response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
          Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ARROW_XL_MAX_BYTES, redirect: 'manual',
          fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] }));
      } catch (error) {
        throw withoutPostcode(error);
      }
      // The found pages do not repeat the reference, so only the page for the address asked counts.
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'ArrowXL redirected its tracking page');
      // The tracker answers a reference it shows nothing for on its form; a missing page is a moved route.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'ArrowXL tracking page is unavailable');
      return parseArrowXl(decodeText(bytes), number, (this.options.now ?? Date.now)());
    };
    return runSteps({ carrier: 'arrow-xl', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ArrowXlTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  // Every lookup needs the postcode, and an unknown reference and a wrong
  // postcode get the same notice, so the adapter cannot recognize a number alone.
  return {
    id: 'arrow-xl', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
  };
};
