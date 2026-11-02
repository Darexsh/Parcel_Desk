import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, NotFoundError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { geisShipmentNumber, parseGeis, PROVIDER } from './parser.js';

// Geis CZ's site does not show Geis SK's consignments, so a number the Czech
// site does not know is asked at the Slovak one. The Czech site goes first: it
// knows its own consignments' places better than the Slovak one does.
const HOSTS = ['www.geis-group.cz', 'www.geis-group.sk'] as const;
// A page is about 25 kB.
const MAX_BYTES = 512 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];

/** The English tracking page of one country site for a consignment number. */
export function geisTrackingUrl(host: (typeof HOSTS)[number], shipment: string): string {
  return `https://${host}/en/detail-of-cargo?${new URLSearchParams({ packNumber: shipment })}`;
}

export class GeisTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const shipment = geisShipmentNumber(raw);
    // A label's barcode is looked up as the consignment it carries.
    const alias = normalizeTrackingNumber(raw) !== shipment;
    const page = async (host: (typeof HOSTS)[number], signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(geisTrackingUrl(host, shipment), { signal, headers: {
        'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html',
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: REDIRECTS, fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Geis tracking page moved');
      return parseGeis(decodeText(bytes), shipment);
    };
    // Only both sites' not-found is a missing consignment; any other failure
    // on one site leaves the answer open.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      let failure: Error | undefined;
      for (const host of HOSTS) {
        if (failure && signal.aborted) throw failure;
        signal.throwIfAborted();
        try {
          const result = await page(host, signal, deadline - performance.now());
          return alias ? { ...result, canonical_tracking_number: shipment } : result;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          if (!(error instanceof NotFoundError)) failure ??= error;
        }
      }
      throw failure ?? new NotFoundError(PROVIDER);
    };
    // A read that fails to reach Geis, or hangs, gets one more try: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'geis', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GeisTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'geis', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => geisShipmentNumber(number))),
  };
};
