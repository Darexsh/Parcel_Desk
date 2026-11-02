import { load } from 'cheerio';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, NoHistoryError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { trawlPrivateScrape } from '../../core/transport/trawlPrivate.js';
import { isRecord } from '../../core/types.js';
import { FM_TRANSPORTES_MAX_BYTES, normalizeFmTransportesNumber, parseFmTransportes, PROVIDER } from './parser.js';

export const FM_TRANSPORTES_PAGE = 'https://rastreio.fmtransportes.com.br/';
export const FM_TRANSPORTES_API = `${FM_TRANSPORTES_PAGE}api/v1`;
const BOOTSTRAP_MAX_BYTES = 1_000_000;
// The visible body waits for the hidden field's value, rather than waiting for
// a hidden input to become visible. The blank page leaves its token unused.
const READY = 'body:has(input[name="cf-turnstile-response"][value]:not([value=""]))';

function json(body: string): unknown {
  try { return JSON.parse(body); }
  catch {
    if (/_cf_chl_opt|cf-error-details|<title>\s*(?:Just a moment|Attention Required)|verify you are human/i.test(body.slice(0, 64_000))) {
      throw new ChallengeError(PROVIDER, 'FM Transportes answered with a browser check');
    }
    throw new SchemaError(PROVIDER, 'FM Transportes returned a reply that is not JSON');
  }
}

export class FmTransportesTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeFmTransportesNumber(raw);
    if (!this.options.trawl) throw new ChallengeError(PROVIDER, 'FM Transportes requires the browser tracking service');
    return runSteps({ carrier: 'fm-transportes', budgetMs: context.budgetMs ?? 60_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      const start = performance.now();
      const timeout = (maximum: number) => {
        const left = remainingMs - (performance.now() - start);
        const value = Math.floor(Math.min(maximum, left - TRAWL_TRANSPORT_ALLOWANCE_MS));
        if (value < 1) throw new BudgetExceededError(PROVIDER, left);
        return value;
      };
      const bootstrapMs = timeout(30_000);
      const page = await trawlPrivateScrape(this.options.trawl!, {
        url: FM_TRANSPORTES_PAGE, skipHttp: true, maxTier: 3, maxTimeout: bootstrapMs, contentWaitForSelector: READY,
      }, { provider: PROVIDER, timeoutMs: bootstrapMs, signal, fetcher: this.options.fetcher, maxBytes: BOOTSTRAP_MAX_BYTES * 8 + 65_536 });
      signal.throwIfAborted();
      if (![FM_TRANSPORTES_PAGE, `${FM_TRANSPORTES_PAGE}#/`].includes(page.url)) throw new TransportError(PROVIDER, 'FM Transportes redirected its guest tracker');
      if (new TextEncoder().encode(page.html).byteLength > BOOTSTRAP_MAX_BYTES) throw new SchemaError(PROVIDER, 'FM Transportes returned an oversized guest page');
      const inputs = load(page.html)('input[name="cf-turnstile-response"]');
      const token = inputs.length === 1 ? inputs.attr('value') ?? '' : '';
      if (!/^[A-Za-z0-9._-]{40,8192}$/.test(token)) throw new ChallengeError(PROVIDER, 'FM Transportes has not completed guest verification');
      if (!page.userAgent || page.userAgent.length > 1024 || /[\r\n]/.test(page.userAgent)) throw new TransportError(PROVIDER, 'The browser did not return its request identity');
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json',
        Origin: new URL(FM_TRANSPORTES_PAGE).origin, Referer: FM_TRANSPORTES_PAGE, 'User-Agent': page.userAgent };
      const post = async (path: '/c' | '/get', body: Record<string, string>, session?: string): Promise<unknown> => {
        const url = `${FM_TRANSPORTES_API}${path}`, maxTimeout = timeout(12_000);
        // Keep both requests on the browser service's egress. Consumers do not
        // need to run on that host or receive any reusable session state.
        const reply = await trawlPrivateScrape(this.options.trawl!, { url, method: 'POST', maxTier: 1, maxTimeout,
          headers: { ...headers, ...(session ? { 'X-Session-Token': session } : {}) }, body: JSON.stringify(body),
        }, { provider: PROVIDER, timeoutMs: maxTimeout, signal, fetcher: this.options.fetcher, requireSolved: false,
          maxBytes: FM_TRANSPORTES_MAX_BYTES * 8 + 65_536, allowHttpStatuses: [401, 403, 404, 405, 410] });
        signal.throwIfAborted();
        if (reply.url !== url || reply.tier !== 1) throw new TransportError(PROVIDER, 'FM Transportes did not return the requested guest response');
        if ([401, 403].includes(reply.statusCode)) throw new ChallengeError(PROVIDER, 'FM Transportes refused guest verification', { status: reply.statusCode });
        if (reply.statusCode === 204) {
          if (path === '/get') throw new NoHistoryError(PROVIDER);
          throw new IndeterminateError(PROVIDER, 'FM Transportes returned no guest verification result');
        }
        if (reply.statusCode !== 200) throw new TransportError(PROVIDER, 'FM Transportes guest lookup is unavailable', { status: reply.statusCode });
        // HTTP tier1 does not render DOM. Its html is decoded response text;
        // raw body bytes may still be Brotli-compressed on the wire.
        const bytes = reply.html;
        if (new TextEncoder().encode(bytes).byteLength > FM_TRANSPORTES_MAX_BYTES) throw new SchemaError(PROVIDER, 'FM Transportes returned excessive tracking data');
        return json(bytes);
      };
      const session = await post('/c', { token });
      if (!isRecord(session) || session.success !== true || !isRecord(session.data)
        || typeof session.data.t !== 'string' || !/^[\x21-\x7E]{1,8192}$/.test(session.data.t)) {
        throw new ChallengeError(PROVIDER, 'FM Transportes did not accept guest verification');
      }
      return parseFmTransportes(await post('/get', { trackingCode: number }, session.data.t), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new FmTransportesTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'fm-transportes', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
