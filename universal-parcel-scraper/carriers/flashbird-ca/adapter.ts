import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, FLASHBIRD_MAX_BYTES, flashbirdJson, normalizeFlashbirdNumber, parseFlashbird, PROVIDER } from './parser.js';

/** The service FlashBird's tracking page asks for one parcel. */
export const FLASHBIRD_TRACKING_API = 'https://flashbird.ca/ghost/api/v0.1/package_trackings';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The service's address for one number, as the tracking page builds it. */
export function flashbirdTrackingUrl(number: string): string {
  return `${FLASHBIRD_TRACKING_API}/${encodeURIComponent(normalizeFlashbirdNumber(number))}`;
}

export class FlashbirdTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(flashbirdTrackingUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: FLASHBIRD_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // The service answers an unknown number with HTTP 200; a redirect or a missing page is a moved route.
    if (!response.ok) throw new TransportError(PROVIDER, 'FlashBird tracking service is unavailable', { status: response.status });
    return parseFlashbird(flashbirdJson(decodeText(bytes)), number, (this.options.now ?? Date.now)());
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeFlashbirdNumber(raw);
    // A read that fails to reach FlashBird, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new FlashbirdTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeFlashbirdNumber(number))),
  };
};
