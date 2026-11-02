import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePostaFaroeNumber, parsePostaFaroe, POSTA_FAROE_MAX_BYTES, PROVIDER } from './parser.js';

/** The lookup posta.fo's tracking page makes for the number in its address or search box. */
export const POSTA_FAROE_API = 'https://odin.posta.fo/api/TrackTrace';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers an unknown number with 204: a missing route is not a missing item.
const GONE = [404, 405, 410];
// Bot checks a CDN or the site's firewall could put in place of the reply.
const CHALLENGE = /<title>\s*(?:Web Page Blocked|Request Rejected|Access Denied|Attention Required|Just a moment)|requested URL was rejected|FortiGuard|FortiWeb|_cf_chl_opt|cf-turnstile|captcha/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Posta answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Posta returned a reply that is not JSON', { cause });
  }
}

export class PostaFaroeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostaFaroeNumber(raw);
    // The wording comes in Faroese whatever language is asked; English is the page's own default.
    const url = `${POSTA_FAROE_API}?trackTraceCode=${encodeURIComponent(number)}&languageCode=en`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: POSTA_FAROE_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Posta tracking lookup is unavailable', { status: response.status });
      }
      // The page reads an empty answer as "Trace & trace number was not found".
      if (response.status === 204) throw new NotFoundError(PROVIDER);
      const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
      if (!body) throw new IndeterminateError(PROVIDER, 'Posta returned an empty reply');
      return parsePostaFaroe(json(body), number);
    };
    // A lookup that fails to reach Posta, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'posta-faroe', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostaFaroeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'posta-faroe', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePostaFaroeNumber(number))),
  };
};
