import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { KUNYOUNG_MAX_BYTES, normalizeKunyoungNumber, parseKunyoung, PROVIDER } from './parser.js';

/** The lookup Kunyoung's tracking page on mj.kunyoung.com makes for the number typed in. */
export const KUNYOUNG_LOOKUP = 'https://mj.kunyoung.com/webinvoicetracehistory/selectListInvoiceTraceHistory.do';
const REDIRECTS = [301, 302, 303, 307, 308];
// The lookup answers an unknown number with HTTP 200; a missing route is not a missing parcel.
const GONE = [404, 410];
// The reply is served as UTF-8; an older Korean server would name EUC-KR or its Windows superset.
const KOREAN_CHARSET = /charset=["']?(?:euc-kr|ks_c_5601-1987|cp949|windows-949)\b/i;
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Kunyoung Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Kunyoung Express returned a reply that is not JSON', { cause });
  }
}

export class KunyoungTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeKunyoungNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page sends the number as multipart form data.
      const body = new FormData();
      body.append('invoiceNumber', number);
      const { response, bytes } = await fetchBounded(KUNYOUNG_LOOKUP, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: KUNYOUNG_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE] });
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Kunyoung Express redirected its tracking lookup');
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Kunyoung Express tracking lookup is unavailable');
      const encoding = KOREAN_CHARSET.test(response.headers.get('content-type') ?? '') ? 'euc-kr' : 'utf-8';
      return parseKunyoung(json(decodeText(bytes, encoding)), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'kunyoung', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new KunyoungTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'kunyoung', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeKunyoungNumber(number))),
  };
};
