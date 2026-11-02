import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  LA_POSTE_BURKINA_FASO_MAX_BYTES, laPosteBurkinaFasoItemUrl, normalizeLaPosteBurkinaFasoNumber, parseLaPosteBurkinaFasoItem, PROVIDER,
} from './parser.js';

export { LA_POSTE_BURKINA_FASO_ITEM } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// The page answers an unknown code itself: a missing route is not a missing item.
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export class LaPosteBurkinaFasoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLaPosteBurkinaFasoNumber(raw);
    // One request opens the page the tracker's form opens for the code. It
    // needs no cookie, token or browser.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(laPosteBurkinaFasoItemUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LA_POSTE_BURKINA_FASO_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'La Poste Burkina Faso tracking page is unavailable', { status: response.status });
      }
      return parseLaPosteBurkinaFasoItem(decodeText(bytes), number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'la-poste-burkina-faso', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LaPosteBurkinaFasoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'la-poste-burkina-faso', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLaPosteBurkinaFasoNumber(number))),
  };
};
