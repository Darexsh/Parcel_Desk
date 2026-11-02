import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { INTEX_MAX_BYTES, intexRequestNumber, parseIntex, PROVIDER } from './parser.js';

/** INTEX's tracker, which its website's tracking page frames and which reads the number from its address. */
export const INTEX_TRACKING = 'https://www.intex-paketdienst.de/sendungsstatus/index.php';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The tracker's page for one number, as its form sends it. */
export function intexTrackingUrl(raw: string): string {
  return `${INTEX_TRACKING}?${new URLSearchParams({ sdnr: intexRequestNumber(raw), mid: '1' })}`;
}

export class IntexTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = intexTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: INTEX_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The tracker answers an unknown number on its page with HTTP 200; a 404 or a redirect is a moved route.
      if (!response.ok) throw new TransportError(PROVIDER, 'INTEX tracker is unavailable', { status: response.status });
      return parseIntex(decodeText(bytes), raw);
    };
    // A read that fails to reach INTEX, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'intex-paketdienst', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers INTEX for a number, so preflight
// never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new IntexTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'intex-paketdienst', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
