import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { KEX_HK_MAX_BYTES, normalizeKexHkNumber, parseKexHk, PROVIDER } from './parser.js';

/** The tracker's page, which the server renders with the history of the number in its `track` parameter. */
export const KEX_HK_TRACKING = 'https://www.kex.kln.com/en/track';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export class KexHkTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${KEX_HK_TRACKING}?${new URLSearchParams({ track: number })}`, { method: 'GET', signal,
      headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) } }, { provider: PROVIDER,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: KEX_HK_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE] });
    // The tracker answers a known and an unknown number alike with HTTP 200.
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'KEX Express Hong Kong redirected its tracker', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'KEX Express Hong Kong tracker is unavailable', { status: response.status });
    return parseKexHk(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeKexHkNumber(raw);
    // A read that fails to reach KEX Express, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'kex-express-hk', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new KexHkTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'kex-express-hk', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeKexHkNumber(number))),
  };
};
