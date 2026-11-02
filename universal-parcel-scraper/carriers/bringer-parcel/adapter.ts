import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BRINGER_PARCEL_MAX_BYTES, isBringerParcelMissing, normalizeBringerParcelNumber, parseBringerParcel, PROVIDER } from './parser.js';

/** The lookup the tracking page on bringerparcel.com makes for each number typed in. */
export const BRINGER_PARCEL_API = 'https://bps.bringer.io/parcels/track-public/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|AwsWafIntegration|awswaf\.com|gokuProps|_Incapsula_Resource/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'BPX answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'BPX returned a reply that is not JSON', { cause });
  }
}

export class BringerParcelTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBringerParcelNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${BRINGER_PARCEL_API}${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BRINGER_PARCEL_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'BPX redirected its tracking lookup');
      const body = decodeText(bytes);
      if (response.status === 404 || response.status === 410) {
        // The tracker names the number it could not find; any other 404 is a moved route.
        let payload: unknown = null;
        try {
          payload = JSON.parse(body);
        } catch {
          if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'BPX answered with a browser check');
        }
        if (response.status === 404 && isBringerParcelMissing(payload, number)) throw new NotFoundError(PROVIDER);
        throw new TransportError(PROVIDER, 'BPX tracking lookup is unavailable');
      }
      return parseBringerParcel(json(body), number);
    };
    // A request that fails to reach BPX, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'bringer-parcel', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BringerParcelTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'bringer-parcel', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBringerParcelNumber(number))),
  };
};
