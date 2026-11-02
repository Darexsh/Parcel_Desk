import { accepted, recognizeFromBrowserLookup, recognizeFromLookup, type AdapterEnvironment, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { API, COURIER_API, MAX_BYTES, normalizeWanbNumber, ORIGIN, parseWanb, PROVIDER, wanbShippingService, withWanbCourier } from './parser.js';
import { fetchWanbInBrowser } from './browser.js';

export class WanbTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  private get endpoint(): string | null { return this.environment.env.WANBEXPRESS_BROWSER_WS_ENDPOINT?.trim() || null; }

  browserSteps(number: string) {
    return [
      { id: 'browser', enabled: !!this.endpoint, run: async ({ signal, remainingMs }: { signal: AbortSignal; remainingMs: number }) => {
        const deadline = performance.now() + remainingMs;
        const payload = await fetchWanbInBrowser(number, this.endpoint!, signal, Math.max(1, Math.min(20_000, remainingMs - 2000)));
        return this.read(payload, number, signal, deadline);
      } },
      { id: 'trawl', enabled: !!this.environment.trawl, run: ({ signal, remainingMs }: { signal: AbortSignal; remainingMs: number }) => this.browser(number, signal, remainingMs) },
    ];
  }

  async direct(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeWanbNumber(raw);
    const deadline = performance.now() + (context.budgetMs ?? 5000);
    // Node's fetch sends `Accept-Language: *` unless told otherwise, and the
    // tracker fails on it with HTTP 500, often after several seconds.
    const { bytes } = await fetchBounded(`${API}?TrackingNumber=${number}`, { signal: context.signal,
      headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.environment.userAgent) } },
    { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(context.budgetMs ?? 5000)), maxBytes: MAX_BYTES, fetcher: this.environment.fetcher });
    return this.read(this.decode(decodeText(bytes)), number, context.signal, deadline);
  }

  private decode(body: string): unknown {
    if (/^\s*</.test(body)) throw new ChallengeError(PROVIDER, 'WanbExpress returned a browser challenge');
    try { return JSON.parse(body); } catch { throw new SchemaError(PROVIDER, 'WanbExpress returned invalid JSON'); }
  }

  /**
   * Parses the tracking reply, then asks the last-mile panel for the courier of its shipping
   * service within the lookup's deadline. The panel needs no verification; without its answer
   * the courier's number stays unattributed.
   */
  private async read(payload: unknown, number: string, signal: AbortSignal | undefined, deadline: number): Promise<CarrierResult> {
    const result = parseWanb(payload, number);
    const service = wanbShippingService(payload);
    const timeoutMs = Math.min(3000, Math.floor(deadline - performance.now() - 500));
    if (!result.delivery_tracking_number || !service || timeoutMs < 500) return result;
    try {
      const { bytes } = await fetchBounded(`${COURIER_API}?shippingServiceId=${encodeURIComponent(service)}&trackingNumber=${result.delivery_tracking_number}`, { signal,
        headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': userAgentOf(this.environment.userAgent) } },
      { provider: PROVIDER, timeoutMs, maxBytes: 20_000, fetcher: this.environment.fetcher });
      return withWanbCourier(result, JSON.parse(decodeText(bytes)));
    } catch {
      signal?.throwIfAborted();
      return result;
    }
  }

  async browser(raw: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const number = normalizeWanbNumber(raw);
    const deadline = performance.now() + remainingMs;
    if (!this.environment.trawl) throw new ChallengeError(PROVIDER, 'WanbExpress requires the browser tracking service');
    const timeoutMs = Math.floor(remainingMs - 2000);
    if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
    const page = await this.environment.trawl.scrape({ url: `${ORIGIN}/?trackingNumbers=${number}`, skipHttp: true, maxTier: 3,
      maxTimeout: timeoutMs, captureResponses: [API], settleTimeout: timeoutMs },
    { provider: PROVIDER, timeoutMs, signal, maxBytes: 6 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
    signal.throwIfAborted();
    const matching = page.capturedResponses.filter(row => {
      try { const url = new URL(row.url); return url.origin + url.pathname === API && !url.username && !url.password
        && url.searchParams.getAll('TrackingNumber').length === 1 && url.searchParams.get('TrackingNumber') === number; } catch { return false; }
    });
    const response = matching.at(-1);
    if (!response || matching.length > 10) throw new ChallengeError(PROVIDER, 'WanbExpress returned no matching tracking response');
    if (response.status === 429) throw new RateLimitedError(PROVIDER);
    if ([401, 403, 428].includes(response.status)) throw new ChallengeError(PROVIDER);
    if (response.status >= 400) throw new UpstreamHttpError(PROVIDER, response.status);
    if (response.error || response.truncated || response.base64Encoded || response.body === null) throw new TransportError(PROVIDER, 'WanbExpress returned an incomplete browser response');
    if (response.status !== 200 || Buffer.byteLength(response.body) > MAX_BYTES) throw new SchemaError(PROVIDER, 'WanbExpress returned invalid browser data');
    return this.read(this.decode(response.body), number, signal, deadline);
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeWanbNumber(raw);
    const browsers = this.browserSteps(number);
    // The tracker refuses plain lookups with its verification code, so with a browser to
    // ask the lookup starts there; HTTP recognition still makes the plain request.
    const browser = browsers.some(step => step.enabled);
    return runSteps({ carrier: 'wanbexpress', budgetMs: context.budgetMs ?? 45000, signal: context.signal, recorder: this.environment.recorder }, [
      { id: 'direct', enabled: !browser, run: ({ signal, remainingMs }) => this.direct(number, { signal, budgetMs: Math.min(5000, remainingMs) }) },
      ...browsers,
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new WanbTracker(environment);
  return { id: 'wanbexpress', recordsSteps: true, steps: ['direct', ...(environment.env.WANBEXPRESS_BROWSER_WS_ENDPOINT?.trim() ? ['browser'] : []), 'trawl'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.direct(number, context), () => accepted(() => normalizeWanbNumber(number))),
    recognizeWithBrowser: (number, context, previous) => {
      if (previous instanceof SchemaError || previous instanceof RateLimitedError) return Promise.reject(previous);
      if (!environment.env.WANBEXPRESS_BROWSER_WS_ENDPOINT?.trim() && !environment.trawl) return Promise.reject(new ChallengeError(PROVIDER, 'WanbExpress requires a browser tracking service'));
      return recognizeFromBrowserLookup(() => runSteps({ carrier: 'wanbexpress', budgetMs: context?.budgetMs ?? 45000,
        signal: context?.signal, recorder: environment.recorder }, [
        ...tracker.browserSteps(normalizeWanbNumber(number)),
      ]));
    } };
};
