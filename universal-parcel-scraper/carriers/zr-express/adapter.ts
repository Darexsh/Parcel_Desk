import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseZrExpress, PROVIDER, ZR_EXPRESS_MAX_BYTES, zrExpressRequestNumber } from './parser.js';

/** The tracking page on zrexpress.net, which looks the number up while it renders. */
export const ZR_EXPRESS_TRACK_URL = 'https://www.zrexpress.net/suivi';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|captcha|<title>\s*(?:Just a moment|Attention Required)/i;

export class ZrExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = zrExpressRequestNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'zr-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // `RSC: 1` asks the page for its server components instead of HTML. The
    // site sends another browser language to its English or Arabic page.
    const { response, bytes } = await fetchBounded(`${ZR_EXPRESS_TRACK_URL}?tn=${encodeURIComponent(number)}`, { method: 'GET', signal, headers: {
      RSC: '1', Accept: 'text/x-component', 'Accept-Language': 'fr', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ZR_EXPRESS_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'ZR Express redirected its tracking page', { status: response.status });
    // An unknown number is a 200 page naming it; a 404 means the page itself is gone.
    if (response.status === 404 || response.status === 410) {
      if (CHALLENGE.test(decodeText(bytes).slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ZR Express answered with a browser check', { status: response.status });
      throw new TransportError(PROVIDER, 'ZR Express tracking page is unavailable', { status: response.status });
    }
    return parseZrExpress(bytes, response.headers.get('content-type'), number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ZrExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'zr-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => zrExpressRequestNumber(number))),
  };
};
