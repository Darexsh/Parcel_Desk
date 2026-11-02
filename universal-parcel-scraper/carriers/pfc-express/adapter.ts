import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePfcExpressNumber, parsePfcExpress, PFC_EXPRESS_MAX_BYTES, PROVIDER } from './parser.js';

/** The lookup PFC's tracker on www.pfctrack.com makes for the numbers typed in. */
export const PFC_EXPRESS_API = 'https://www.pfctrack.com/Index';
const REDIRECTS = [301, 302, 303, 307, 308];
// A missing route is not a missing parcel: an unknown number gets the tracker's own "Not Found".
const GONE = [404, 410];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden)|acw_sc__v2|aliyun_waf|_____tmd_____|captcha|<title>\s*(?:滑动验证|验证码|安全验证)/i;

/**
 * The tracker's lookup for one number, as its page asks it: `nos` is the
 * numbers each followed by a comma, and `language=cn`, the page's default,
 * keeps each scan's own wording. The page's other setting asks for a
 * translation into Chinese.
 */
export function pfcExpressLookupUrl(raw: string): string {
  const url = new URL(PFC_EXPRESS_API);
  url.searchParams.set('handler', 'AccessRedirect');
  url.searchParams.set('nos', `${normalizePfcExpressNumber(raw)},`);
  url.searchParams.set('language', 'cn');
  return url.href;
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'PFC Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'PFC Express returned a reply that is not JSON', { cause });
  }
}

export class PfcExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = pfcExpressLookupUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: PFC_EXPRESS_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'PFC Express redirected its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'PFC Express tracking lookup is unavailable', { status: response.status });
      if (response.status !== 200) throw new IndeterminateError(PROVIDER, 'PFC Express did not answer with its tracking result');
      return parsePfcExpress(json(decodeText(bytes)), raw);
    };
    // A read that fails to reach PFC, or hangs, gets one more: the first gets
    // half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'pfc-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PfcExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'pfc-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePfcExpressNumber(number))),
  };
};
