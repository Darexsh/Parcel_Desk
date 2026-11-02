import { accepted, recognizeFromBrowserLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, TransportError, UpstreamHttpError, UpstreamNetworkError, type CarrierError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { EMIRATES_POST_MAX_BYTES, emiratesPostUrl, normalizeEmiratesPostNumber, parseEmiratesPost, PROVIDER } from './parser.js';

const SERVICE_MS = 30_000;

function browserFailure(error: unknown): CarrierError | null {
  if (!(error instanceof UpstreamHttpError) || error.status !== 500) return null;
  let body: unknown;
  try { body = JSON.parse(error.diagnostics?.body_excerpt ?? ''); } catch { return null; }
  if (!isRecord(body) || body.error !== 'Max tier reached without success' || !Array.isArray(body.timings)) return null;
  const last: unknown = body.timings.at(-1);
  if (!isRecord(last) || (last.tier !== 2 && last.tier !== 3)) return null;
  if (last.statusCode === 429) {
    const headers = isRecord(last.responseHeaders) ? last.responseHeaders : {};
    const retry = headers['retry-after'];
    return new RateLimitedError(PROVIDER, typeof retry === 'string' && /^\d{1,6}$/.test(retry) ? Number(retry) * 1000 : undefined);
  }
  return last.status === 'blocked' ? new ChallengeError(PROVIDER, 'Emirates Post did not pass its browser verification',
    { ...(typeof last.statusCode === 'number' ? { status: last.statusCode } : {}) }) : null;
}

export class EmiratesPostTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeEmiratesPostNumber(raw);
    return runSteps({ carrier: 'emirates-post', budgetMs: context.budgetMs ?? SERVICE_MS + TRAWL_TRANSPORT_ALLOWANCE_MS,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'trawl', run: async ({ signal, remainingMs }) => {
        const trawl = this.options.trawl;
        if (!trawl) throw new ChallengeError(PROVIDER, 'Emirates Post requires the browser tracking service');
        const timeoutMs = Math.floor(Math.min(SERVICE_MS, remainingMs - 2000));
        if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        try {
          const page = await trawl.scrape({ url: emiratesPostUrl(number), skipHttp: true, maxTier: 3, maxTimeout: timeoutMs },
            { provider: `TRAWL while fetching ${PROVIDER}`, timeoutMs, signal, fetcher: this.options.fetcher,
              maxBytes: 4 * EMIRATES_POST_MAX_BYTES });
          signal.throwIfAborted();
          return parseEmiratesPost(page.html, number);
        } catch (error) {
          const failure = browserFailure(error);
          if (failure) throw failure;
          // The browser response can contain party details, cookies and clearance.
          if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
            throw new TransportError(PROVIDER, 'The browser tracking service is unavailable', { status: error.status });
          }
          if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
          if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
          throw error;
        }
      } },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new EmiratesPostTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'emirates-post', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context),
    recognizeWithBrowser: (number, context) => accepted(() => normalizeEmiratesPostNumber(number))
      ? recognizeFromBrowserLookup(() => tracker.fetch(number, context)) : Promise.resolve({ known: false, lastActivityAt: null }) };
};
