import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isPosIndonesiaNotFound, normalizePosIndonesiaNumber, parsePosIndonesia, posIndonesiaPayload, POS_INDONESIA_MAX_BYTES,
  PROVIDER } from './parser.js';

// The service Pos Indonesia's mobile app tracks items with. The tracking page
// at posindonesia.co.id asks it through a server action that checks a
// Cloudflare Turnstile token; the app sends its own key, the same for every
// install, and no token.
export const POS_INDONESIA_ENDPOINT = 'https://jembatan.posindonesia.co.id/utility/2.0.0/tracking/';
const APP_KEY = 'CpFzVJWl7MgFLWT8wL8Aqz1Jvo3zyytF'; // gitleaks:allow
// A firewall or server error page instead of the service's JSON.
const BLOCKED = /<html|<!doctype|akses diblokir|access denied|forbidden|just a moment/i;

export class PosIndonesiaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePosIndonesiaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let reply: Awaited<ReturnType<typeof fetchBounded>>;
      try {
        reply = await fetchBounded(`${POS_INDONESIA_ENDPOINT}${encodeURIComponent(number)}`, { method: 'GET', signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-KEY': APP_KEY,
            'User-Agent': userAgentOf(this.options.userAgent) } },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: POS_INDONESIA_MAX_BYTES,
          fetcher: this.options.fetcher, allowHttpStatuses: [400, 401] });
      } catch (error) {
        // An unknown number has its own notice; a missing route is not a missing item.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'Pos Indonesia tracking service is unavailable', { cause: error });
        }
        throw error;
      }
      const { response, bytes } = reply;
      if (response.status === 401) throw new ChallengeError(PROVIDER, 'Pos Indonesia refused the app’s key', { status: 401 });
      const body = decodeText(bytes);
      let payload: unknown;
      try { payload = posIndonesiaPayload(body); }
      catch (error) {
        if (BLOCKED.test(body.slice(0, 64_000))) {
          throw new ChallengeError(PROVIDER, 'Pos Indonesia answered with a block page', { status: response.status, cause: error });
        }
        throw error;
      }
      // HTTP 400 carries the not-found notice, and nothing else is read from it.
      if (response.status === 400 && !isPosIndonesiaNotFound(payload)) {
        throw new IndeterminateError(PROVIDER, 'Pos Indonesia refused the lookup', { status: 400 });
      }
      return parsePosIndonesia(payload, number);
    };
    // A request that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'pos-indonesia', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PosIndonesiaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pos-indonesia', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePosIndonesiaNumber(number))),
  };
};
