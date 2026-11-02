import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePdqNumber, parsePdq, PDQ_MAX_BYTES, PROVIDER } from './parser.js';

/** The lookup www.pdq.cl's tracking page makes for the number typed in. */
export const PDQ_API = 'https://www.pdq.cl/api/tracking';
// The lookup answers only requests its own site sends.
const REFERER = 'https://www.pdq.cl/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// The lookup's own refusals carry a JSON `motivo`: 400 for input it does not
// take, 403 for a request from elsewhere and 404 for a guide it does not know.
const ANSWERED = [400, 403, 404, 410];
// Bot checks Cloudflare, in front of the site, could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;

function json(body: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (status === 403 || CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'PDQ answered with a browser check', { cause });
    if (status === 404 || status === 410) throw new TransportError(PROVIDER, 'PDQ tracking lookup is unavailable', { cause });
    throw new SchemaError(PROVIDER, 'PDQ returned a reply that is not JSON', { cause });
  }
}

export class PdqTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePdqNumber(raw);
    const url = `${PDQ_API}?${new URLSearchParams({ q: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', Referer: REFERER, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PDQ_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...ANSWERED] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'PDQ redirected its tracking lookup');
      return parsePdq(json(decodeText(bytes), response.status), number);
    };
    // A request that fails to reach PDQ, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'pdq-chile', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PdqTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pdq-chile', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePdqNumber(number))),
  };
};
