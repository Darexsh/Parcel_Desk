import { load } from 'cheerio';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient, type TrawlScrapeRequest } from '../../core/transport/trawl.js';
import { scopedTrawlCookies, trawlPrivateScrape } from '../../core/transport/trawlPrivate.js';
import { parseYalidine, PROVIDER, YALIDINE_MAX_BYTES, yalidineRequestNumber } from './parser.js';

export const YALIDINE_PAGE = 'https://www.yalidine.com/suivre-un-colis/';
const READY = 'body:has(input[name="cf-turnstile-response"][value]:not([value=""]))';

export class YalidineTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = yalidineRequestNumber(raw);
    if (!this.options.trawl) throw new ChallengeError(PROVIDER, 'Yalidine requires the browser tracking service');
    return runSteps({ carrier: 'yalidine', budgetMs: context.budgetMs ?? 75_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      const start = performance.now();
      const read = async (request: TrawlScrapeRequest) => {
        const left = remainingMs - (performance.now() - start);
        const maxTimeout = Math.floor(Math.min(30_000, left - TRAWL_TRANSPORT_ALLOWANCE_MS));
        if (maxTimeout < 1) throw new BudgetExceededError(PROVIDER, left);
        const page = await trawlPrivateScrape(this.options.trawl!, { ...request, skipHttp: true, maxTier: 3, maxTimeout }, {
          provider: PROVIDER, timeoutMs: maxTimeout, signal, fetcher: this.options.fetcher,
          requireSolved: false, allowHttpStatuses: [401, 403, 404, 405, 410], maxBytes: YALIDINE_MAX_BYTES * 8 + 65_536,
        });
        signal.throwIfAborted();
        if (![2, 3].includes(page.tier) || typeof page.raw.url !== 'string' || page.url !== YALIDINE_PAGE) {
          throw new TransportError(PROVIDER, 'Yalidine did not return the requested guest page');
        }
        if ([401, 403].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Yalidine refused guest verification', { status: page.statusCode });
        if (page.statusCode !== 200) throw new TransportError(PROVIDER, 'Yalidine guest tracker is unavailable', { status: page.statusCode });
        if (new TextEncoder().encode(page.html).byteLength > YALIDINE_MAX_BYTES) throw new SchemaError(PROVIDER, 'Yalidine returned an oversized guest page');
        return page;
      };
      // The blank form leaves its Turnstile response unused for this one POST.
      const bootstrap = await read({ url: YALIDINE_PAGE, contentWaitForSelector: READY });
      const fields = load(bootstrap.html)('input[name="cf-turnstile-response"]');
      const token = fields.length === 1 ? fields.attr('value') ?? '' : '';
      if (!/^[A-Za-z0-9._-]{40,8192}$/.test(token)) throw new ChallengeError(PROVIDER, 'Yalidine has not completed guest verification');
      if (!bootstrap.userAgent || bootstrap.userAgent.length > 1024 || /[\r\n]/.test(bootstrap.userAgent)) throw new TransportError(PROVIDER, 'The browser did not return its request identity');
      const page = await read({ url: YALIDINE_PAGE, method: 'POST', settleTimeout: 500,
        headers: { 'User-Agent': bootstrap.userAgent, 'Content-Type': 'application/x-www-form-urlencoded',
          Origin: new URL(YALIDINE_PAGE).origin, Referer: YALIDINE_PAGE },
        body: new URLSearchParams({ tracking: number, 'cf-turnstile-response': token }).toString(),
        cookies: scopedTrawlCookies(bootstrap.cookies, ['www.yalidine.com', 'yalidine.com'], YALIDINE_PAGE),
      });
      return parseYalidine(page.html, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new YalidineTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'yalidine', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
