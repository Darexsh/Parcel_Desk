import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTotalExpressNumber, parseTotalExpress, parseTotalExpressSearch, PROVIDER, TOTAL_EXPRESS_MAX_BYTES } from './parser.js';

/** The API the tracking page on totalconecta.totalexpress.com.br reads. */
export const TOTAL_EXPRESS_API = 'https://totalconecta.totalexpress.com.br/mfe-rastreio/api';
const REDIRECTS = [301, 302, 303, 307, 308];
// Akamai's refusal of an address, and bot checks a CDN could put in place of the reply.
const CHALLENGE = /<title>\s*Access Denied\s*<\/title>|errors\.edgesuite\.net|_cf_chl_opt|cf-turnstile|<title>\s*Just a moment/i;
// The edge's answer, as JSON with HTTP 400, to a client it does not take for a browser.
const NO_AGENT = /'User-Agent' header is required/;
// The site's own page for too many requests, which it also serves, with HTTP 403,
// to clients whose User-Agent names no browser.
const TOO_MANY = /<title>\s*Erro 429\s*<\/title>|Muitas solicita(?:ç|&ccedil;)(?:õ|&otilde;)es/i;

/** The edge's or the site's refusal in place of the reply, if the body is one. */
function refusal(body: string, status: number): Error | null {
  const head = body.slice(0, 64_000);
  if (TOO_MANY.test(head)) return new RateLimitedError(PROVIDER, undefined, 'Total Express refused the lookup as too many requests', { status });
  if (CHALLENGE.test(head) || NO_AGENT.test(head)) return new ChallengeError(PROVIDER, 'Total Express refused the lookup', { status });
  return null;
}

function json(body: string, status: number): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw refusal(body, status) ?? new SchemaError(PROVIDER, 'Total Express returned a reply that is not JSON', { cause });
  }
}

export class TotalExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeTotalExpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const get = async (path: string, query: Record<string, string>) => {
        const { response, bytes } = await fetchBounded(`${TOTAL_EXPRESS_API}/${path}?${new URLSearchParams(query)}`, { signal, headers: {
          Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
        } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxBytes: TOTAL_EXPRESS_MAX_BYTES,
          redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410, 500] });
        const body = decodeText(bytes);
        if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'Total Express redirected its tracking lookup');
        // The tracker reads a missing parcel from its search; a 404 is a moved route.
        if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'Total Express tracking lookup is unavailable');
        if (response.status === 403) throw refusal(body, 403) ?? new ChallengeError(PROVIDER, 'Total Express refused the lookup', { status: 403 });
        if (response.status === 400) throw refusal(body, 400) ?? new TransportError(PROVIDER, 'Total Express rejected the tracking lookup', { status: 400 });
        return { status: response.status, body };
      };

      // One read for a parcel the tracker knows.
      const detail = await get('order-data', { awb: number, language: 'pt' });
      if (detail.status === 200) return parseTotalExpress(json(detail.body, 200), number);
      // An AWB the tracker does not know fails with HTTP 500, as can one it
      // knows; the page's search tells the two apart.
      const search = await get('basic', { code: number, limit: '10', page: '1' });
      if (search.status !== 200) throw new IndeterminateError(PROVIDER, 'Total Express could not search for the shipment', { status: search.status });
      parseTotalExpressSearch(json(search.body, 200), number);
      throw new IndeterminateError(PROVIDER, 'Total Express could not read the shipment it found', { status: detail.status });
    };
    return runSteps({ carrier: 'total-express', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TotalExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'total-express', recordsSteps: true, steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeTotalExpressNumber(number))),
  };
};
