import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, HUNTER_EXPRESS_MAX_BYTES, normalizeHunterExpressNumber, parseHunterExpress, PROVIDER } from './parser.js';

/** Hunter Express's public tracker; 55010 is the carrier's own portal on its consignment software. */
export const HUNTER_EXPRESS_TRACKER = 'https://portal.hunterexpress.com.au/Track/55010/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers every number with HTTP 200: a missing route is not a missing consignment.
const GONE = [404, 405, 410];

/** The tracker's address for one consignment, as its search box builds it. */
export function hunterExpressLookupUrl(number: string): string {
  return `${HUNTER_EXPRESS_TRACKER}${encodeURIComponent(number)}`;
}

export class HunterExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHunterExpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(hunterExpressLookupUrl(number), { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: HUNTER_EXPRESS_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
      const status = response.status;
      if (status === 403) throw new ChallengeError(PROVIDER, 'Hunter Express refused the lookup', { status });
      if (REDIRECTS.includes(status) || GONE.includes(status)) throw new TransportError(PROVIDER, 'Hunter Express tracker is unavailable', { status });
      return parseHunterExpress(decodeText(bytes), number);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HunterExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
