import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { ACI_EXPRESS_KR_MAX_BYTES, normalizeAciExpressKrNumber, parseAciExpressKr, PROVIDER } from './parser.js';

/** ACI's e-commerce tracking page, where its courier lookup sends a number it does not know. */
export const ACI_EXPRESS_KR_TRACKER = 'https://www.acieshop.com/pod.php';
/** The courier lookup on the delivery page of aciexpress.net. */
export const ACI_EXPRESS_KR_COURIER = 'https://133.acieshop.com/webpod.php';
// The courier lookup's whole answer for a number it has no shipment for: a
// script that opens the e-commerce tracking page for it.
const COURIER_MISS = /^\s*<script[^>]*>\s*(?:<!--)?\s*location\.href\s*=\s*'https?:\/\/www\.acieshop\.com\/pod\.php\?OrderNo=([^']*)';\s*(?:\/\/\s*-->)?\s*<\/script>\s*$/i;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|g-recaptcha|h-captcha|AwsWafIntegration|awswaf\.com/i;
const REDIRECTS = [301, 302, 303, 307, 308];
// Both pages answer every number with HTTP 200; a missing route is not a missing parcel.
const GONE = [404, 410];

export function aciExpressKrTrackerUrl(number: string): string {
  return `${ACI_EXPRESS_KR_TRACKER}?${new URLSearchParams({ OrderNo: normalizeAciExpressKrNumber(number) })}`;
}

export function aciExpressKrCourierUrl(number: string): string {
  return `${ACI_EXPRESS_KR_COURIER}?${new URLSearchParams({ HawbNo: normalizeAciExpressKrNumber(number) })}`;
}

export class AciExpressKrTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async page(url: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ACI_EXPRESS_KR_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'ACI Express redirected its tracking page', { status: response.status });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'ACI Express tracking page is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'ACI Express refused the lookup', { status: 403 });
    return decodeText(bytes);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAciExpressKrNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = Date.now() + timeoutMs;
      try {
        return parseAciExpressKr(await this.page(aciExpressKrTrackerUrl(number), signal, timeoutMs), number);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      // The delivery page's e-commerce lookup sends a number it does not know
      // to the courier lookup, which sends it here when it has none either.
      const body = await this.page(aciExpressKrCourierUrl(number), signal, deadline - Date.now());
      const miss = COURIER_MISS.exec(body);
      if (miss && decodeURIComponent(miss[1]!).toUpperCase() === number) throw new NotFoundError(PROVIDER);
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ACI Express answered with a browser check');
      throw new IndeterminateError(PROVIDER, 'ACI Express has a courier shipment under this number, which the adapter does not read');
    };
    // A lookup that fails to reach ACI, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'aci-express-kr', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AciExpressKrTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'aci-express-kr', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAciExpressKrNumber(number))),
  };
};
