import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ANSERX_MAX_BYTES, normalizeAnserxNumber, parseAnserx, PROVIDER } from './parser.js';

/** The lookup the tracking page on oms.anserx.com makes for the numbers in its address. */
export const ANSERX_API = 'https://oms.anserx.com/client/cs/anserxWebsite/tracking/getTrackInfo';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'AnserX returned a reply that is not JSON', { cause });
  }
}

export class AnserxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAnserxNumber(raw);
    // The page's own request, `internalFlag=0` included.
    const url = `${ANSERX_API}?${new URLSearchParams({ nos: number, internalFlag: '0' })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ANSERX_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      const body = decodeText(bytes);
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'AnserX redirected its tracking lookup', { status: response.status });
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'AnserX answered with a browser check', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'AnserX refused the lookup', { status: 403 });
      // The page reads a missing parcel from a 200 reply; a 404 is a moved route.
      if (response.status === 404 || response.status === 410) {
        throw new TransportError(PROVIDER, 'AnserX tracking lookup is unavailable', { status: response.status });
      }
      return parseAnserx(json(body), number);
    };
    // A lookup that fails to reach the service, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'anserx', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AnserxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'anserx', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAnserxNumber(number))),
  };
};
