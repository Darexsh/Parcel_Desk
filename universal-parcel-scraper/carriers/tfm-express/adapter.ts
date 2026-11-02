import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTfmExpressNumber, parseTfmExpress, PROVIDER, TFM_EXPRESS_MAX_BYTES } from './parser.js';

/** The tracking page, which TFM Express's site frames, and where its form posts the airwaybill. */
export const TFM_EXPRESS_TRACKING = 'https://customer.tfmex.com/Skybill/TrackSkybill';
const REDIRECTS = [301, 302, 303, 307, 308];

export class TfmExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTfmExpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The form's script posts the browser's offset in hours, which the page adds to its clocks; 0 keeps them in UTC.
      const { response, bytes } = await fetchBounded(TFM_EXPRESS_TRACKING, { method: 'POST', signal, headers: {
        'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html', 'Accept-Language': 'en',
        'Content-Type': 'application/x-www-form-urlencoded',
      }, body: new URLSearchParams({ AWB: number, clientTimeZoneOffSetHour: '0' }).toString() }, { provider: PROVIDER,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TFM_EXPRESS_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, 400, 404, 410], fetcher: this.options.fetcher });
      // The page does not check its anti-forgery field: a refusal of the form means the site started to.
      if (response.status === 400) throw new SchemaError(PROVIDER, 'TFM Express refused the tracking form');
      // An unknown airwaybill is HTTP 200: a redirect or a 404 is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'TFM Express tracking is unavailable');
      return parseTfmExpress(decodeText(bytes), number);
    };
    // A read that fails to reach the site, or hangs, gets one more: the first gets half of the
    // budget, so the retry fits in the rest.
    return runSteps({ carrier: 'tfm-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TfmExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tfm-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTfmExpressNumber(number))),
  };
};
