import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePostaShqiptareNumber, parsePostaShqiptare, POSTA_SHQIPTARE_MAX_BYTES, PROVIDER } from './parser.js';

/** The lookup the e-Posta tracking page makes, with the item's code as the last part of the address. */
export const POSTA_SHQIPTARE_API = 'https://eposta.postashqiptare.al:8443/api/mailItemEvents/getTrackApi';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Request Rejected|Access Denied)|requested URL was rejected/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Posta Shqiptare answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Posta Shqiptare returned a reply that is not JSON', { cause });
  }
}

/** Whether an error reply is the page's own notice for a missing item. */
function missing(body: string): boolean {
  try {
    return JSON.parse(body) === 'package_not_found';
  } catch {
    return false;
  }
}

export class PostaShqiptareTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostaShqiptareNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(`${POSTA_SHQIPTARE_API}/${number}`, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: POSTA_SHQIPTARE_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 404, 410] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Posta Shqiptare redirected its tracking lookup');
      const body = decodeText(bytes);
      if (response.status !== 200) {
        if (response.status !== 410 && missing(body)) throw new NotFoundError(PROVIDER);
        // The tracker answers an unknown code with HTTP 200; a 404 is a moved route.
        if (response.status === 400) throw new IndeterminateError(PROVIDER, 'Posta Shqiptare refused the lookup');
        throw new TransportError(PROVIDER, 'Posta Shqiptare tracking lookup is unavailable');
      }
      return parsePostaShqiptare(json(body), number);
    };
    // A request that fails to reach the tracker, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'posta-shqiptare', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostaShqiptareTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'posta-shqiptare', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePostaShqiptareNumber(number))),
  };
};
