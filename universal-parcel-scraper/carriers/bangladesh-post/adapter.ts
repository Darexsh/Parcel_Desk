import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep, withNetworkRetry } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  BANGLADESH_POST_MAX_BYTES, bangladeshPostDomesticReply, bangladeshPostDomesticToken, isBangladeshPostCode, normalizeBangladeshPostNumber,
  parseBangladeshPostDomestic, parseBangladeshPostInternational, PROVIDER,
} from './parser.js';

/** The lookup the international tracker's page makes for the code in its form. */
export const BANGLADESH_POST_INTERNATIONAL_API = 'https://ipsbd.bdpost.gov.bd/app_mail_tracking/search1.php';
/** The domestic tracker's page, which carries the token its lookup sends. */
export const BANGLADESH_POST_DOMESTIC_PAGE = 'https://report.dms.bdpost.gov.bd/';
/** The lookup the domestic tracker's page makes. */
export const BANGLADESH_POST_DOMESTIC_API = 'https://report.dms.bdpost.gov.bd/mail_tracking_new/get_data.php';
const REDIRECTS = [301, 302, 303, 307, 308];
// The trackers answer an unknown code in their reply: a missing route is not a missing item.
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 20_000;

interface Read { status: number; body: string }

export class BangladeshPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<Read> {
    const { response, bytes } = await fetchBounded(url, { ...init, signal, headers: { ...init.headers as Record<string, string>,
      'User-Agent': userAgentOf(this.options.userAgent) } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      maxBytes: BANGLADESH_POST_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    if (REDIRECTS.includes(response.status) || GONE.includes(response.status)) {
      throw new TransportError(PROVIDER, 'Bangladesh Post tracking lookup is unavailable', { status: response.status });
    }
    const body = decodeText(bytes).replace(/^\uFEFF/, '').trim();
    if (response.status !== 403 && !body) throw new IndeterminateError(PROVIDER, 'Bangladesh Post returned an empty reply');
    return { status: response.status, body };
  }

  /** The international tracker: Bangladesh Post's records of S10 items, its own and those from abroad. */
  private async international(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The form post its page's script sends.
    const { status, body } = await this.read(BANGLADESH_POST_INTERNATIONAL_API, { method: 'POST', headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    }, body: new URLSearchParams({ item_id: number }).toString() }, signal, timeoutMs);
    if (status === 403) throw new ChallengeError(PROVIDER, 'Bangladesh Post refused the lookup', { status });
    return parseBangladeshPostInternational(body, number);
  }

  /** The domestic tracker: its page's token, then the lookup that sends it. */
  private async domestic(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, deadline - performance.now());
    const page = await this.read(BANGLADESH_POST_DOMESTIC_PAGE, { method: 'GET', headers: { Accept: 'text/html' } }, signal, left());
    if (page.status === 403) throw new ChallengeError(PROVIDER, 'Bangladesh Post refused the domestic tracker page', { status: 403 });
    const csrfToken = bangladeshPostDomesticToken(page.body);
    const { status, body } = await this.read(BANGLADESH_POST_DOMESTIC_API, { method: 'POST', headers: {
      Accept: 'application/json', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ item_id: number, csrf_token: csrfToken }) }, signal, left());
    if (status === 403) {
      // The tracker refuses a token it did not issue in plain text; anything else is a firewall's.
      if (/^CSRF token invalid$/i.test(body)) throw new SchemaError(PROVIDER, 'Bangladesh Post refused its page’s lookup token', { status });
      throw new ChallengeError(PROVIDER, 'Bangladesh Post refused the domestic lookup', { status });
    }
    return parseBangladeshPostDomestic(bangladeshPostDomesticReply(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBangladeshPostNumber(raw);
    // A lookup that fails to reach the international tracker, or hangs, gets
    // one more try: the first gets half of the budget, so the retry fits in
    // the rest. A Bangladesh Post code that tracker does not know goes to
    // the domestic tracker, which gets one more try the same way.
    return runSteps({ carrier: 'bangladesh-post', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.international(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.international(number, signal, remainingMs)),
      { id: 'domestic', enabled: isBangladeshPostCode(number), recovers: error => error instanceof NotFoundError,
        run: ({ signal, remainingMs }) => {
          const deadline = performance.now() + remainingMs;
          return withNetworkRetry({ signal, remainingMs: () => deadline - performance.now() },
            timeoutMs => this.domestic(number, signal, timeoutMs));
        } },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BangladeshPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'bangladesh-post', recordsSteps: true, steps: ['direct', 'retry', 'domestic'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeBangladeshPostNumber(number))),
  };
};
