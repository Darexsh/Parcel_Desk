import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { IndeterminateError, NotFoundError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeFoxpostNumber, parseFoxpost, PROVIDER } from './parser.js';

const PAGE = 'https://foxpost.hu/csomagkovetes/';
// The page is about 60 kB, with its styles inline.
const MAX_BYTES = 512 * 1024;
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker sends a Z number it does not know on to Packeta's tracker.
const PACKETA = /^https:\/\/tracking\.packeta\.com\/[a-z]{2}\/(Z\d{10})$/;

export function foxpostTrackingUrl(raw: string): string {
  return `${PAGE}?${new URLSearchParams({ code: normalizeFoxpostNumber(raw) })}`;
}

export class FoxpostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFoxpostNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(foxpostTrackingUrl(number), { signal, headers: {
        'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html', 'Accept-Language': 'hu-HU,hu;q=0.9',
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher });
      if (REDIRECTS.includes(response.status)) {
        if (PACKETA.exec(response.headers.get('location') ?? '')?.[1] === number) {
          throw new NotFoundError(PROVIDER, 'Foxpost does not know this Packeta number', { reason: 'packeta_number' });
        }
        throw new IndeterminateError(PROVIDER, 'Foxpost tracking page moved');
      }
      // A missing page says nothing about the parcel.
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'Foxpost tracking page is unavailable');
      return parseFoxpost(decodeText(bytes), number);
    };
    // A request that fails to reach Foxpost, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'foxpost', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FoxpostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'foxpost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFoxpostNumber(number))),
  };
};
