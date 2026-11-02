import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeToptransNumber, parseToptrans, PROVIDER, TOPTRANS_MAX_BYTES, type ToptransNumber } from './parser.js';

/** TOPTRANS's tracking service, which reads a shipment or a piece number from its address. */
export const TOPTRANS_TRACKING = 'https://apis.toptrans.cz/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The service's page for a shipment number, or for a piece number. */
export function toptransTrackingUrl({ number, kind }: ToptransNumber): string {
  return `${TOPTRANS_TRACKING}?${new URLSearchParams({ [kind === 'piece' ? 'item_number' : 'parcel_number']: number })}`;
}

export class ToptransTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const input = normalizeToptransNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(toptransTrackingUrl(input), { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TOPTRANS_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      // The service answers an unknown number on its page with HTTP 200; a 404 or a redirect is a moved route.
      if (!response.ok) throw new TransportError(PROVIDER, 'TOPTRANS tracking service is unavailable', { status: response.status });
      return parseToptrans(decodeText(bytes), input.number);
    };
    // A read that fails to reach TOPTRANS, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'toptrans', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers TOPTRANS for a number, so
// preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new ToptransTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'toptrans', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
