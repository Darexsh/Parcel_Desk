import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTntItalyNumber, parseTntItaly, PROVIDER, TNT_ITALY_MAX_BYTES } from './parser.js';

/** The lookup tnt.it's tracking page posts its form to. */
export const TNT_ITALY_API = 'https://www.tnt.it/tracking/getTrackXML.html';
const REDIRECTS = [301, 302, 303, 307, 308];

export class TntItalyTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTntItalyNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // `wt=1` searches by waybill; `2` would search the sender's references.
      const { response, bytes } = await fetchBounded(TNT_ITALY_API, { method: 'POST', signal, headers: {
        Accept: 'text/xml, */*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: new URLSearchParams({ wt: '1', consigNos: number }).toString() }, { provider: PROVIDER,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TNT_ITALY_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'TNT Italy redirected its tracking lookup');
      // The route answers every number; a missing route is a moved service, not a missing parcel.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'TNT Italy tracking lookup is unavailable');
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'TNT Italy refused the lookup', { status: 403 });
      // The reply is ISO-8859-1, as its header and its XML declaration say.
      const utf8 = /charset\s*=\s*"?utf-?8\b/i.test(response.headers.get('content-type') ?? '');
      return parseTntItaly(decodeText(bytes, utf8 ? 'utf-8' : 'iso-8859-1'), number);
    };
    // A request that fails to reach tnt.it, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'tnt-it', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TntItalyTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'tnt-it', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTntItalyNumber(number))),
  };
};
