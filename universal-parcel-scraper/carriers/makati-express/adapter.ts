import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { MAKATI_EXPRESS_MAX_BYTES, normalizeMakatiExpressNumber, parseMakatiExpress, PROVIDER } from './parser.js';

/** The tracking page, which its own form posts the AWB to. */
export const MAKATI_EXPRESS_TRACKER = 'https://makati-express.com/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];

export class MakatiExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMakatiExpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(MAKATI_EXPRESS_TRACKER, { method: 'POST', signal, headers: {
        Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ awbnumber: number, Submittrackwidget: 'Check' }).toString() }, { provider: PROVIDER,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAKATI_EXPRESS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 406] });
      // The page answers every AWB with HTTP 200; a redirect or a 404 is a moved route.
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Makati Express redirected its tracking page');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Makati Express tracking page is unavailable');
      // The server's filter refuses some clients' names with 406.
      if (response.status === 406) throw new ChallengeError(PROVIDER, 'Makati Express refused the lookup', { status: 406 });
      return parseMakatiExpress(decodeText(bytes), number);
    };
    // One read with the whole budget: the page takes several seconds to
    // answer, so half of a recognition's budget would not fit a retry.
    return runSteps({ carrier: 'makati-express', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MakatiExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'makati-express', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeMakatiExpressNumber(number))),
  };
};
