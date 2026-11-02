import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CITYMAIL_MAX_BYTES, normalizeCitymailNumber, parseCitymail, PROVIDER } from './parser.js';

/** The tracker the Spåra paket page on citymail.se sends the reference to; a GET form. */
export const CITYMAIL_TRACKING = 'https://tracking.citymail.se/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const DEFAULT_BUDGET_MS = 20_000;

export class CitymailTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const url = `${CITYMAIL_TRACKING}?${new URLSearchParams({ search: number })}`;
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CITYMAIL_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    // The tracker answers a known and an unknown reference alike with HTTP 200.
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'CityMail redirected its tracking page', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'CityMail tracking page is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'CityMail refused the lookup', { status: 403 });
    return parseCitymail(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCitymailNumber(raw);
    // A read that fails to reach CityMail, or hangs, is sent once more: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'citymail', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : DEFAULT_BUDGET_MS), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url: `${CITYMAIL_TRACKING}?${new URLSearchParams({ search: number })}`, maxBytes: CITYMAIL_MAX_BYTES,
        parse: html => parseCitymail(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new CitymailTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  const http = new CitymailTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'citymail', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeCitymailNumber(number))),
  };
};
