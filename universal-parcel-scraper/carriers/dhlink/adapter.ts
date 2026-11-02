import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DHLINK_MAX_BYTES, normalizeDhlinkNumber, parseDhlink, PROVIDER } from './parser.js';

/** The lookup the tracking page on www.dhlink.com makes. */
export const DHLINK_API = 'https://www.dhlink.com/stage-api/trbiz/track/queryTrack';
const REDIRECTS = [301, 302, 303, 307, 308];
// The firewall's block page, which comes with HTTP 403 and writes its message from a script.
const BLOCKED = /you have been blocked|您的请求被阻断|<title>\s*403 Forbidden\s*<\/title>/i;

export class DhlinkTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeDhlinkNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(DHLINK_API, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ trackNos: [number], state: '', language: 'EN' }) }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DHLINK_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'DHLink redirected its tracking lookup');
      // The firewall answers a client it refuses, such as a headless browser, with HTTP 403.
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'The DHLink firewall blocked the lookup');
      // The route answers every number; a missing route is a moved service, not a missing parcel.
      if (!response.ok) throw new TransportError(PROVIDER, 'DHLink tracking lookup is unavailable');
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'The DHLink firewall blocked the lookup', { cause });
        throw new SchemaError(PROVIDER, 'DHLink returned a reply that is not JSON', { cause });
      }
      return parseDhlink(payload, number);
    };
    // A request that fails to reach DHLink, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'dhlink', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DhlinkTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dhlink', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDhlinkNumber(number))),
  };
};
