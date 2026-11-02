import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CHALLENGE, normalizeTranscorpNumber, parseTranscorp, PROVIDER, TRANSCORP_MAX_BYTES } from './parser.js';

/** Elite's tracking page, which looks the airwaybill up while it renders. */
export const TRANSCORP_TRACK_URL = 'https://app.elite-co.com/shipments/track';
const REDIRECTS = [301, 302, 303, 307, 308];

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  return header && /^\d{1,6}$/.test(header) ? Number(header) * 1000 : undefined;
}

export class TranscorpTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTranscorpNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'transcorp', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // `RSC: 1` asks the page for its server components instead of HTML.
    const { response, bytes } = await fetchBounded(`${TRANSCORP_TRACK_URL}?references=${number}`, { method: 'GET', signal, headers: {
      RSC: '1', Accept: 'text/x-component', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TRANSCORP_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410, 429] });
    // Vercel's checkpoint answers 429 or 403 with this header.
    if (response.headers.get('x-vercel-mitigated') === 'challenge' || (!response.ok && CHALLENGE.test(decodeText(bytes).slice(0, 64_000)))) {
      throw new ChallengeError(PROVIDER, 'Elite answered with a browser check', { status: response.status });
    }
    if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response), 'Elite limited the lookups', { status: 429 });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Elite redirected its tracking page', { status: response.status });
    // An unknown number is a 200 page naming it; a 404 means the page itself is gone.
    if (!response.ok) throw new TransportError(PROVIDER, 'Elite tracking page is unavailable', { status: response.status });
    return parseTranscorp(bytes, response.headers.get('content-type'), number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TranscorpTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'transcorp', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTranscorpNumber(number))),
  };
};
