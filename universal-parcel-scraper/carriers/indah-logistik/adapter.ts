import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { INDAH_LOGISTIK_MAX_BYTES, normalizeIndahLogistikNumber, parseIndahLogistik, PROVIDER } from './parser.js';

/**
 * The lookup the resi tab of Indah Logistik's Android app (com.indahlogistik.checker)
 * makes. The website's resi form asks for the last four digits of the sender's or
 * recipient's phone and a Turnstile token; the app asks for the resi alone.
 */
export const INDAH_LOGISTIK_API = 'https://indahonline.com/api/internal/indahonlinemobile/getresidetail?english=0';
// The app signs every request with this login, the same for every install,
// until a customer signs in; its resi tab needs no sign-in.
const APP_LOGIN = 'indahonline:1nd4h0nl1n3165!@#'; // gitleaks:allow
const APP_AUTHORIZATION = `Basic ${btoa(APP_LOGIN)}`;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Bot checks Cloudflare, in front of the site, could put in place of the reply.
// The site's own pages load Turnstile and carry a commented-out captcha field,
// so neither is a sign of one.
const CHALLENGE = /_cf_chl_opt|<title>\s*Just a moment|<title>\s*Attention Required/i;

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Indah Logistik answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Indah Logistik returned a reply that is not JSON', { cause });
  }
}

export class IndahLogistikTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeIndahLogistikNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(INDAH_LOGISTIK_API, { method: 'POST', signal, headers: {
        Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8', Authorization: APP_AUTHORIZATION,
        'User-Agent': userAgentOf(this.options.userAgent),
      }, body: JSON.stringify({ nomorResi: number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: INDAH_LOGISTIK_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 401] });
      if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
        throw new TransportError(PROVIDER, 'Indah Logistik tracking lookup is unavailable', { status: response.status });
      }
      if (response.status === 401) throw new ChallengeError(PROVIDER, 'Indah Logistik refused the app’s login', { status: 401 });
      return parseIndahLogistik(json(decodeText(bytes)), number);
    };
    // A lookup that fails to reach the service, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: 'indah-logistik', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new IndahLogistikTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'indah-logistik', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeIndahLogistikNumber(number))),
  };
};
