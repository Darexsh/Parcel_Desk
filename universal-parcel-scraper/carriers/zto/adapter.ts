import { accepted, recognizeFromBrowserLookup, recognizeFromLookup, type AdapterEnvironment, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import type { TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { API, MAX_BYTES, normalizeZtoNumber, PAGE, parseZto, PROVIDER } from './parser.js';

/** The challenge reason for each way the service's ZTO helper says the page stayed unverified. */
const VERIFICATION_REASONS = new Map([['unsolved', 'puzzle_unsolved'], ['solver_unavailable', 'solver_unavailable'],
  ['refused', 'verification_refused'], ['deadline', 'verification_unfinished'], ['no_puzzle', 'puzzle_missing']]);

function verificationReason(page: TrawlScrapeResponse): string | undefined {
  const last: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
  const outcome = isRecord(last) && typeof last.reason === 'string' ? /^zto-([a-z_]{1,40})$/.exec(last.reason)?.[1] : undefined;
  return outcome ? VERIFICATION_REASONS.get(outcome) : undefined;
}

export class ZtoTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async direct(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeZtoNumber(raw);
    const { bytes } = await fetchBounded(API, { method: 'POST', body: JSON.stringify({ items: [{ billCode: number }] }), signal: context.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgentOf(this.environment.userAgent) } },
    { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(context.budgetMs ?? 5000)), maxBytes: MAX_BYTES, fetcher: this.environment.fetcher });
    return this.parse(decodeText(bytes), number);
  }

  private parse(body: string, number: string): CarrierResult {
    if (/^\s*</.test(body)) throw new ChallengeError(PROVIDER, 'ZTO returned a browser challenge');
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { throw new SchemaError(PROVIDER, 'ZTO returned invalid JSON'); }
    return parseZto(payload, number);
  }

  async browser(raw: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const number = normalizeZtoNumber(raw);
    if (!this.environment.trawl) throw new ChallengeError(PROVIDER, 'ZTO requires the browser tracking service');
    const timeoutMs = Math.floor(remainingMs - 2000);
    if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
    const page = await this.environment.trawl.scrape({ url: `${PAGE}?waybills=${number}`, skipHttp: true, maxTier: 3,
      maxTimeout: timeoutMs, captureResponses: [API], settleTimeout: timeoutMs },
    { provider: PROVIDER, timeoutMs, signal, maxBytes: 6 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
    signal.throwIfAborted();
    const matching = page.capturedResponses.filter(row => {
      try { const url = new URL(row.url); return url.origin + url.pathname === API && !url.username && !url.password
        && !url.search && !url.hash && row.trackingNumberSubmitted === number; } catch { return false; }
    });
    const response = matching.at(-1), reason = verificationReason(page);
    if (!response || matching.length > 10) throw new ChallengeError(PROVIDER, 'ZTO returned no matching tracking response', { reason });
    if (response.status === 429) throw new RateLimitedError(PROVIDER);
    if ([401, 403, 428].includes(response.status)) throw new ChallengeError(PROVIDER, 'ZTO refused the browser tracking request', { status: response.status, reason: 'api_denied' });
    if (response.status >= 400) throw new UpstreamHttpError(PROVIDER, response.status);
    if (response.error || response.truncated || response.base64Encoded || response.body === null) throw new TransportError(PROVIDER, 'ZTO returned an incomplete browser response');
    if (response.status !== 200 || Buffer.byteLength(response.body) > MAX_BYTES) throw new SchemaError(PROVIDER, 'ZTO returned invalid browser data');
    try { return this.parse(response.body, number); } catch (error) {
      if (!(error instanceof ChallengeError) || !reason) throw error;
      throw new ChallengeError(PROVIDER, 'ZTO verification did not complete', { reason, cause: error });
    }
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeZtoNumber(raw);
    return runSteps({ carrier: 'zto', budgetMs: context.budgetMs ?? 45000, signal: context.signal, recorder: this.environment.recorder }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.direct(number, { signal, budgetMs: Math.min(5000, remainingMs) }) },
      { id: 'trawl', enabled: !!this.environment.trawl, run: ({ signal, remainingMs }) => this.browser(number, signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ZtoTracker(environment);
  // Recognition asks the API alone, through the step runner so its requests are recorded.
  const api = new ZtoTracker({ ...environment, trawl: null });
  return { id: 'zto', recordsSteps: true, steps: ['direct', 'trawl'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => api.fetch(number, context), () => accepted(() => normalizeZtoNumber(number))),
    recognizeWithBrowser: (number, context, previous) => {
      if (previous instanceof SchemaError || previous instanceof RateLimitedError) return Promise.reject(previous);
      return recognizeFromBrowserLookup(() => runSteps({ carrier: 'zto', budgetMs: context?.budgetMs ?? 45000,
        signal: context?.signal, recorder: environment.recorder }, [
        { id: 'trawl', run: ({ signal, remainingMs }) => tracker.browser(number, signal, remainingMs) },
      ]));
    } };
};
