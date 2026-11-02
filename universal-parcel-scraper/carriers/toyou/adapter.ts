import { load } from 'cheerio';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { trawlPrivateScrape } from '../../core/transport/trawlPrivate.js';
import { isRecord } from '../../core/types.js';
import { normalizeToyouNumber, parseToyou, PROVIDER, TOYOU_MAX_BYTES } from './parser.js';

export const TOYOU_PAGE = 'https://www.toyou.co.uk/track';
export const TOYOU_API = 'https://www.toyou.co.uk/api/external/toyou/web/track/parcel/';
const BLOCKED = /_cf_chl_opt|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

export class ToyouTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeToyouNumber(raw);
    if (!this.options.trawl) throw new ChallengeError(PROVIDER, 'toyou requires the browser tracking service');
    return runSteps({ carrier: 'toyou', budgetMs: context.budgetMs ?? 60_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      const start = performance.now();
      const timeout = (maximum: number) => {
        const left = remainingMs - (performance.now() - start);
        const value = Math.floor(Math.min(maximum, left - TRAWL_TRANSPORT_ALLOWANCE_MS));
        if (value < 1) throw new BudgetExceededError(PROVIDER, left);
        return value;
      };
      const bootstrapMs = timeout(25_000);
      const page = await trawlPrivateScrape(this.options.trawl!, { url: TOYOU_PAGE, skipHttp: true, maxTier: 3,
        maxTimeout: bootstrapMs, contentWaitForSelector: 'body:has(script#mobify-data)',
      }, { provider: PROVIDER, timeoutMs: bootstrapMs, signal, fetcher: this.options.fetcher, maxBytes: TOYOU_MAX_BYTES * 8 + 65_536 });
      signal.throwIfAborted();
      if (typeof page.raw.url !== 'string' || page.url !== TOYOU_PAGE) throw new TransportError(PROVIDER, 'toyou redirected its guest tracking page');
      if (new TextEncoder().encode(page.html).byteLength > TOYOU_MAX_BYTES) throw new SchemaError(PROVIDER, 'toyou returned an oversized guest page');
      const scripts = load(page.html)('script#mobify-data');
      if (scripts.length !== 1) {
        if (BLOCKED.test(page.html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'toyou answered with a browser check');
        throw new SchemaError(PROVIDER, 'toyou returned no unique guest page state');
      }
      let state: unknown;
      try { state = JSON.parse(scripts.text()); } catch { throw new SchemaError(PROVIDER, 'toyou returned invalid guest page state'); }
      const preloaded = isRecord(state) ? state.__PRELOADED_STATE__ : undefined;
      const props = isRecord(preloaded) ? preloaded.appProps : undefined;
      const token = isRecord(props) ? props.azureToken : undefined;
      if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/.test(token)) {
        throw new ChallengeError(PROVIDER, 'toyou did not establish its guest tracking session');
      }
      const url = TOYOU_API + number, apiMs = timeout(12_000);
      const reply = await trawlPrivateScrape(this.options.trawl!, { url, maxTier: 1, maxTimeout: apiMs,
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, Referer: TOYOU_PAGE },
      }, { provider: PROVIDER, timeoutMs: apiMs, signal, fetcher: this.options.fetcher, requireSolved: false,
        maxBytes: TOYOU_MAX_BYTES * 8 + 65_536, allowHttpStatuses: [401, 403, 404, 405, 410] });
      signal.throwIfAborted();
      if (typeof reply.raw.url !== 'string' || reply.url !== url || reply.tier !== 1) throw new TransportError(PROVIDER, 'toyou did not return the requested guest response');
      if ([401, 403].includes(reply.statusCode)) throw new ChallengeError(PROVIDER, 'toyou refused its guest session', { status: reply.statusCode });
      if (reply.statusCode !== 200) throw new TransportError(PROVIDER, 'toyou guest tracking is unavailable', { status: reply.statusCode });
      if (new TextEncoder().encode(reply.html).byteLength > TOYOU_MAX_BYTES) throw new SchemaError(PROVIDER, 'toyou returned excessive parcel data');
      let data: unknown;
      try { data = JSON.parse(reply.html); }
      catch {
        if (BLOCKED.test(reply.html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'toyou answered with a browser check');
        throw new SchemaError(PROVIDER, 'toyou returned a reply that is not JSON');
      }
      return parseToyou(data, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ToyouTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'toyou', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
