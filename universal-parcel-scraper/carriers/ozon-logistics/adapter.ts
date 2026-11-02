import { accepted, recognizeFromBrowserLookup, recognizeFromLookup, type AdapterEnvironment, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { MAX_BYTES, normalizeOzonNumber, ORIGIN, ozonApi, parseOzon, PROVIDER } from './parser.js';

function read(body: string, status: number, number: string): CarrierResult {
  if (status === 429) throw new RateLimitedError(PROVIDER);
  if ([301, 302, 307, 308, 401, 403, 428].includes(status) || /^\s*</.test(body)) throw new ChallengeError(PROVIDER, 'Ozon requires its guest browser verification');
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new SchemaError(PROVIDER, 'Ozon returned invalid JSON'); }
  if (isRecord(payload) && (payload.challengeURL || payload.incidentId)) throw new ChallengeError(PROVIDER);
  if (status === 404 && isRecord(payload) && payload.message === `Постинг ${number} не найден`) throw new NotFoundError(PROVIDER);
  if (status === 404 || status === 410) throw new SchemaError(PROVIDER, 'Ozon did not identify the missing posting');
  if (status >= 400) throw new UpstreamHttpError(PROVIDER, status);
  if (status !== 200) throw new TransportError(PROVIDER, 'Ozon returned no complete tracking response');
  return parseOzon(payload);
}

export class OzonTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async direct(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeOzonNumber(raw);
    const { bytes, response } = await fetchBounded(ozonApi(number), { signal: context.signal,
      headers: { Accept: 'application/json, text/plain, */*', 'x-o3-app-name': 'tpl-ui-ozon-track',
        'User-Agent': userAgentOf(this.environment.userAgent) } },
    { provider: PROVIDER, fetcher: this.environment.fetcher, timeoutMs: Math.max(1, context.budgetMs ?? 5000), maxBytes: MAX_BYTES,
      redirect: 'manual', allowHttpStatuses: [307, 401, 403, 404, 428] });
    if (response.url && response.url !== ozonApi(number)) throw new ChallengeError(PROVIDER, 'Ozon redirected its tracking request');
    return read(decodeText(bytes), response.status, number);
  }

  async browser(raw: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const number = normalizeOzonNumber(raw), api = ozonApi(number);
    if (!this.environment.trawl) throw new ChallengeError(PROVIDER, 'Ozon requires the browser tracking service');
    const timeoutMs = Math.floor(remainingMs - 2000);
    if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
    const page = await this.environment.trawl.scrape({ url: `${ORIGIN}/?track=${number}`, skipHttp: true, maxTier: 3,
      maxTimeout: timeoutMs, captureResponses: [api], settleTimeout: timeoutMs },
    { provider: PROVIDER, timeoutMs, signal, fetcher: this.environment.fetcher, requireSolved: false,
      maxBytes: 2 * MAX_BYTES, captureWindow: 'last' });
    signal.throwIfAborted();
    const matching = page.capturedResponses.filter(row => row.url === api);
    const response = matching.at(-1);
    if (!response) {
      if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
      if (page.statusCode >= 500) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      throw new ChallengeError(PROVIDER, 'Ozon returned no matching tracking response');
    }
    if (response.status === 429) throw new RateLimitedError(PROVIDER);
    if ([401, 403, 428].includes(response.status) || response.error === 'challenge') throw new ChallengeError(PROVIDER);
    if (response.status >= 500) throw new UpstreamHttpError(PROVIDER, response.status);
    if (matching.length > 8 || response.trackingNumberSubmitted !== number.replace(/-/g, '')) {
      throw new SchemaError(PROVIDER, 'Ozon browser response was not bound to the whole posting');
    }
    if (response.error || response.truncated || response.base64Encoded || response.body === null
      || new TextEncoder().encode(response.body).length > MAX_BYTES) throw new TransportError(PROVIDER, 'Ozon returned an incomplete browser response');
    return read(response.body, response.status, number);
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeOzonNumber(raw);
    return runSteps({ carrier: 'ozon-logistics', budgetMs: context.budgetMs ?? 35000, signal: context.signal, recorder: this.environment.recorder }, [
      { id: 'direct', enabled: !this.environment.trawl, run: ({ signal, remainingMs }) => this.direct(number, { signal, budgetMs: remainingMs }) },
      { id: 'trawl', enabled: !!this.environment.trawl, run: ({ signal, remainingMs }) => this.browser(number, signal, remainingMs) },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new OzonTracker(environment);
  return { id: 'ozon-logistics', recordsSteps: true, steps: ['direct', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.direct(number, context), () => accepted(() => normalizeOzonNumber(number))),
    recognizeWithBrowser: (number, context) => recognizeFromBrowserLookup(() => runSteps({ carrier: 'ozon-logistics',
      budgetMs: context?.budgetMs ?? 35000, signal: context?.signal, recorder: environment.recorder }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => tracker.browser(number, signal, remainingMs) },
    ])) };
};
