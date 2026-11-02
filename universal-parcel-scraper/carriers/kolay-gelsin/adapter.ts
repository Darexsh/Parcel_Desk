import { load } from 'cheerio';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient, type TrawlScrapeRequest } from '../../core/transport/trawl.js';
import { scopedTrawlCookies, trawlPrivateScrape } from '../../core/transport/trawlPrivate.js';
import { isRecord } from '../../core/types.js';
import { KOLAY_GELSIN_MAX_BYTES, normalizeKolayGelsinNumber, parseKolayGelsin, PROVIDER } from './parser.js';

export const KOLAY_GELSIN_PAGE = 'https://www.kolaygelsin.com/tracking';
export const KOLAY_GELSIN_CHECK = 'https://www.kolaygelsin.com/api/shipment/check';
const DOMAINS = ['www.kolaygelsin.com', 'kolaygelsin.com'];
const READY = 'body:has(input[name="cf-turnstile-response"][value]:not([value=""]))';

export class KolayGelsinTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeKolayGelsinNumber(raw);
    if (!this.options.trawl) throw new ChallengeError(PROVIDER, 'Kolay Gelsin requires the browser tracking service');
    const bootstrapUrl = `${KOLAY_GELSIN_PAGE}?${new URLSearchParams({ q: number })}`;
    return runSteps({ carrier: 'kolay-gelsin', budgetMs: context.budgetMs ?? 75_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      const start = performance.now();
      const read = async (request: TrawlScrapeRequest, maximum: number) => {
        const left = remainingMs - (performance.now() - start);
        const maxTimeout = Math.floor(Math.min(maximum, left - TRAWL_TRANSPORT_ALLOWANCE_MS));
        if (maxTimeout < 1) throw new BudgetExceededError(PROVIDER, left);
        const page = await trawlPrivateScrape(this.options.trawl!, { ...request, skipHttp: true, maxTier: 3, maxTimeout }, {
          provider: PROVIDER, timeoutMs: maxTimeout, signal, fetcher: this.options.fetcher, requireSolved: false,
          allowHttpStatuses: [399, 401, 403, 404, 405, 410], maxBytes: KOLAY_GELSIN_MAX_BYTES * 8 + 65_536,
        });
        signal.throwIfAborted();
        if (![2, 3].includes(page.tier) || typeof page.raw.url !== 'string' || page.url !== request.url) {
          throw new TransportError(PROVIDER, 'Kolay Gelsin did not return the requested browser response');
        }
        if ([399, 401, 403].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Kolay Gelsin refused tracking verification', { status: page.statusCode });
        if (page.statusCode !== 200) throw new TransportError(PROVIDER, 'Kolay Gelsin guest tracker is unavailable', { status: page.statusCode });
        if (new TextEncoder().encode(page.html).byteLength > KOLAY_GELSIN_MAX_BYTES) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned an oversized tracking reply');
        return page;
      };
      const bootstrap = await read({ url: bootstrapUrl, settleTimeout: 1000, contentWaitForSelector: READY }, 25_000);
      const fields = load(bootstrap.html)('input[name="cf-turnstile-response"]');
      const token = fields.length === 1 ? fields.attr('value') ?? '' : '';
      if (!/^[A-Za-z0-9._-]{40,8192}$/.test(token)) throw new ChallengeError(PROVIDER, 'Kolay Gelsin has not completed tracking verification');
      const checked = await read({ url: KOLAY_GELSIN_CHECK, method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: new URL(KOLAY_GELSIN_PAGE).origin, Referer: bootstrapUrl },
        body: JSON.stringify({ trackNumber: number, captchaCode: token, isRedirected: false }),
        cookies: scopedTrawlCookies(bootstrap.cookies, DOMAINS, KOLAY_GELSIN_CHECK),
      }, 18_000);
      let data: unknown;
      try { data = JSON.parse(checked.html); }
      catch {
        if (/_cf_chl_opt|cf-error-details|<title>\s*Just a moment/i.test(checked.html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Kolay Gelsin answered with a browser check');
        throw new SchemaError(PROVIDER, 'Kolay Gelsin returned an invalid verification reply');
      }
      if (!isRecord(data) || data.success !== true || data.result !== true) throw new IndeterminateError(PROVIDER, 'Kolay Gelsin did not complete the tracking lookup');
      const echoed = typeof data.trackingNumber === 'string' ? normalizeTrackingNumber(data.trackingNumber)
        : typeof data.trackingNumber === 'number' && Number.isSafeInteger(data.trackingNumber) && data.trackingNumber > 0 ? String(data.trackingNumber) : null;
      if (echoed !== number) throw new IndeterminateError(PROVIDER, 'Kolay Gelsin verified another tracking number');
      if (typeof data.isKG !== 'boolean' || typeof data.isSENDEO !== 'boolean' || data.isKG === data.isSENDEO) {
        throw new IndeterminateError(PROVIDER, 'Kolay Gelsin did not identify its delivery network');
      }
      if (data.referenceCode != null && data.referenceCode !== '') throw new IndeterminateError(PROVIDER, 'Kolay Gelsin requires additional verification');
      if (!data.isKG && (typeof data.qid !== 'string' || !data.qid || data.qid.length > 8192)) throw new SchemaError(PROVIDER, 'Kolay Gelsin returned no guest tracking capability');
      const params = new URLSearchParams({ q: number, qid: data.isKG ? number : data.qid as string });
      if (data.isKG) params.set('redirected', 'true');
      const landingUrl = `${KOLAY_GELSIN_PAGE}?${params}`;
      const cookies = scopedTrawlCookies(checked.cookies, DOMAINS, landingUrl);
      if (!data.isKG && !cookies.length) throw new ChallengeError(PROVIDER, 'Kolay Gelsin did not establish its guest session');
      const landing = await read({ url: landingUrl, cookies, settleTimeout: 500 }, 25_000);
      return parseKolayGelsin(landing.html, number, data.isKG, params.get('qid')!);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new KolayGelsinTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'kolay-gelsin', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
