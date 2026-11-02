import { load } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { normalizeEkartNumber, parseEkart } from './parser.js';

const BASE = 'https://ekartlogistics.com';
const ENDPOINT = `${BASE}/ekartlogistics-web-routes-api/ekartlogistics-web-proxy/trackings/v2`;

export class EkartTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeEkartNumber(raw);
    const budgetMs = context.budgetMs ?? 15_000;
    return runSteps({ carrier: 'ekart', signal: context.signal, budgetMs, recorder: this.options.recorder ?? NOOP_RECORDER },
      [{ id: 'direct', run: async ({ signal, remainingMs }) => {
        const deadline = performance.now() + remainingMs;
        // Each lookup owns the CSRF token and cookies that were issued together.
        const fetcher = makeFetchCookie(this.options.fetcher ?? fetch, new CookieJar());
        const read = async (url: string, init: RequestInit, maxBytes: number) => {
          signal.throwIfAborted();
          const left = deadline - performance.now();
          if (left <= 0) throw new BudgetExceededError('Ekart', budgetMs);
          try {
            const result = await fetchBounded(url, { ...init, signal }, { provider: 'Ekart', timeoutMs: Math.max(1, Math.floor(left)), maxBytes, fetcher });
            if (result.response.status === 205) throw new ChallengeError('Ekart', 'Ekart requires a fresh tracking session');
            return result.bytes;
          } catch (error) {
            if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) throw new TransportError('Ekart', 'Ekart tracking endpoint is unavailable', { cause: error });
            throw error;
          }
        };
        const userAgent = userAgentOf(this.options.userAgent);
        const html = decodeText(await read(`${BASE}/ekartlogistics-web/shipmenttrack/${number}`, { headers: { 'User-Agent': userAgent } }, 500_000));
        const $ = load(html);
        const tokens = $('meta[name="csrf-token"]');
        const token = tokens.attr('content');
        if (tokens.length !== 1 || !token || token.length > 2000) throw new SchemaError('Ekart', 'Ekart returned no tracking session token');
        const bytes = await read(ENDPOINT, { method: 'POST', headers: { 'User-Agent': userAgent, 'Content-Type': 'application/json',
          'X-User-Agent': `${userAgent} EKCL/website/1`, 'csrf-token': token }, body: JSON.stringify({ tracking_ids: number }) }, 1_000_000);
        return parseEkart(parseJsonBytes(bytes, 'Ekart'), number);
      } }]);
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new EkartTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'ekart', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context),
    // A parcel's history says Ekart knows the number; its empty answer for one it does not know stays inconclusive.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => normalizeEkartNumber(number))),
  };
};
