import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePakistanPostNumber, PAKISTAN_POST_MAX_BYTES, parsePakistanPost, PROVIDER } from './parser.js';

/**
 * The tracker's result page. The form on ep.gov.pk posts the number to
 * `track.asp`, which opens this page for it in a frame.
 */
export const PAKISTAN_POST_TRACKER = 'https://ep.gov.pk/emtts/EPTrack_Live.aspx';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing item: the tracker answers unknown numbers on its page.
const GONE = [404, 410];

export class PakistanPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePakistanPostNumber(raw);
    const url = `${PAKISTAN_POST_TRACKER}?${new URLSearchParams({ ArticleIDz: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PAKISTAN_POST_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, ...GONE, 403], fetcher: this.options.fetcher });
      // The site sends a request its page fails on to its error page.
      if (REDIRECTS.includes(response.status)) throw new IndeterminateError(PROVIDER, 'Pakistan Post sent the lookup to another page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'The Pakistan Post tracker is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'Pakistan Post refused the lookup', { status: 403 });
      const html = decodeText(bytes);
      if (!html.trim()) throw new IndeterminateError(PROVIDER, 'Pakistan Post returned an empty page');
      return parsePakistanPost(html, number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest. The
    // page takes a few seconds to answer.
    return runSteps({ carrier: 'pakistan-post', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PakistanPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pakistan-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePakistanPostNumber(number))),
  };
};
