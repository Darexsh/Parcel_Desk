import { load } from 'cheerio';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, carrierErrorKind, ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient, type TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { scopedTrawlCookies, trawlPrivateScrape } from '../../core/transport/trawlPrivate.js';
import type { JsonObject } from '../../core/types.js';
import { normalizeZoomNumber, parseZoom, PROVIDER, validateZoomResultUrl, ZOOM_MAX_BYTES, ZOOM_PAGE, ZOOM_READY_SELECTOR, zoomTrackingUrl } from './parser.js';

export class ZoomTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeZoomNumber(raw), url = zoomTrackingUrl(number);
    if (!this.options.trawl) throw new ChallengeError(PROVIDER, 'Zoom requires the browser tracking service');
    return runSteps({ carrier: 'zoom-ve', budgetMs: context.budgetMs ?? 75_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      const start = performance.now();
      const timeout = (maximum: number) => {
        const left = remainingMs - (performance.now() - start);
        const value = Math.floor(Math.min(maximum, left - TRAWL_TRANSPORT_ALLOWANCE_MS));
        if (value < 1) throw new BudgetExceededError(PROVIDER, left);
        return value;
      };
      const bounded = (page: TrawlScrapeResponse, html: string) => {
        if (typeof page.raw.url !== 'string') throw new TransportError(PROVIDER, 'Zoom returned no bound response address');
        validateZoomResultUrl(page.url, number);
        if (new TextEncoder().encode(html).byteLength > ZOOM_MAX_BYTES) throw new SchemaError(PROVIDER, 'Zoom returned an oversized tracking page');
        return html;
      };
      const browser = async (cookies?: JsonObject[]) => {
        const maxTimeout = timeout(25_000);
        const page = await trawlPrivateScrape(this.options.trawl!, { url, skipHttp: true, maxTier: 3, maxTimeout,
          contentWaitForSelector: ZOOM_READY_SELECTOR, settleTimeout: 1000, ...(cookies ? { cookies } : {}),
        }, { provider: PROVIDER, timeoutMs: maxTimeout, signal, fetcher: this.options.fetcher, maxBytes: ZOOM_MAX_BYTES * 8 + 65_536 });
        signal.throwIfAborted();
        bounded(page, page.html);
        return page;
      };
      let page = await browser();
      for (let attempt = 0; attempt < 2; attempt++) {
        // The official callback can finish and consume the token before the
        // browser returns. Read that bound positive or negative result first.
        try { return parseZoom(page.html, number, page.url); }
        catch (error) { if (carrierErrorKind(error) !== 'challenge') throw error; }
        const inputs = load(page.html)('.cf-turnstile input[name="cf-turnstile-response"]');
        const token = inputs.length === 1 ? inputs.attr('value') ?? '' : '';
        if (/^[A-Za-z0-9._-]{40,8192}$/.test(token)) {
          if (!page.userAgent || page.userAgent.length > 1024 || /[\r\n]/.test(page.userAgent)) throw new TransportError(PROVIDER, 'The browser did not return its request identity');
          const verified = new URL(url); verified.searchParams.set('turnstile-token', token);
          const maxTimeout = timeout(12_000);
          const reply = await trawlPrivateScrape(this.options.trawl!, { url: verified.href, method: 'GET', maxTier: 1, maxTimeout,
            headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': page.userAgent, Referer: ZOOM_PAGE },
          }, { provider: PROVIDER, timeoutMs: maxTimeout, signal, fetcher: this.options.fetcher, requireSolved: false,
            maxBytes: ZOOM_MAX_BYTES * 8 + 65_536, allowHttpStatuses: [401, 403, 404, 405, 410] });
          signal.throwIfAborted();
          if (reply.tier !== 1) throw new TransportError(PROVIDER, 'Zoom did not return the requested HTTP response');
          if ([401, 403].includes(reply.statusCode)) throw new ChallengeError(PROVIDER, 'Zoom refused tracking verification', { status: reply.statusCode });
          if (reply.statusCode !== 200) throw new TransportError(PROVIDER, 'Zoom tracking page is unavailable', { status: reply.statusCode });
          const html = bounded(reply, reply.html);
          return parseZoom(html, number, reply.url);
        }
        const cookies = scopedTrawlCookies(page.cookies, ['zoom.red'], url);
        if (attempt === 0 && cookies.length) {
          // Real carrier cookies select the service's fresh browser tier. A
          // warm unfinished widget gets this one bounded retry, never a fake cookie.
          page = await browser(cookies);
          continue;
        }
        throw new ChallengeError(PROVIDER, 'Zoom has not completed tracking verification');
      }
      throw new ChallengeError(PROVIDER, 'Zoom has not completed tracking verification');
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ZoomTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'zoom-ve', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
