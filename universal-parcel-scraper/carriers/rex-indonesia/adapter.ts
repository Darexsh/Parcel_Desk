import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseRex, PROVIDER, REX_MAX_BYTES, rexNumber } from './parser.js';

export const REX_PAGE = 'https://www.rex.co.id/id/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];

export class RexIndonesiaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = rexNumber(raw), url = new URL(REX_PAGE); url.searchParams.set('airwaybill', number);
    const read = async (signal: AbortSignal, remainingMs: number) => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal,
        headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: REX_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, 404, 410], fetcher: this.options.fetcher }).catch((error: unknown) => {
        // A rejected page can contain the unprojected sender or signatory fields.
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(PROVIDER, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(PROVIDER, undefined);
        throw error;
      });
      if (response.status !== 200) throw new TransportError(PROVIDER, 'REX Indonesia tracking endpoint is unavailable', { status: response.status });
      return parseRex(decodeText(bytes), number);
    };
    return runSteps({ carrier: 'rex-indonesia', budgetMs: context.budgetMs ?? 15_000, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new RexIndonesiaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'rex-indonesia', steps: ['direct', 'retry'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => rexNumber(number))) };
};
