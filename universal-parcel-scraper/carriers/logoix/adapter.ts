import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { LOGOIX_MAX_BYTES, LOGOIX_WAIT_MS, normalizeLogoixNumber, parseLogoix, PROVIDER, waitNotice } from './parser.js';

/** The tracker the Track & Trace form on logoix.com sends the number to; a GET form. */
export const LOGOIX_TRACKING = 'https://www.logoix.com/cgi-bin/tnt.pl';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 15_000;

export class LogoixTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const url = `${LOGOIX_TRACKING}?${new URLSearchParams({ q: number })}`;
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LOGOIX_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403, 429] });
    // The tracker answers a known and an unknown number alike with HTTP 200.
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'LogoiX redirected its tracker', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'LogoiX tracker is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'LogoiX refused the lookup', { status: 403 });
    // The pages are ISO-8859-1.
    const html = decodeText(bytes, 'windows-1252');
    if (response.status === 429) {
      throw waitNotice(html) ?? new RateLimitedError(PROVIDER, LOGOIX_WAIT_MS);
    }
    return parseLogoix(html, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLogoixNumber(raw);
    // A read that fails to reach LogoiX, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'logoix', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LogoixTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'logoix', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLogoixNumber(number))),
  };
};
