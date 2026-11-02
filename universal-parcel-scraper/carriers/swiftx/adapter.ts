import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient, type TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { normalizeSwiftxNumber, parseSwiftx, PROVIDER, SWIFTX_API, SWIFTX_MAX_BYTES, swiftxTrackingUrl } from './parser.js';

export { normalizeSwiftxNumber, parseSwiftx, swiftxTrackingUrl, swiftxWording } from './parser.js';

/** What the browser service may spend on one lookup; the page's checks take a few seconds when they pass. */
const SERVICE_MS = 30_000;
const SETTLE_MS = 10_000;
/** The service's capture helper ends a page that never asked for the number with this reason. */
const NO_QUERY = `${PROVIDER} produced no tracking response after submission`;

/**
 * Whether the browser service's HTTP 500 says its last browser tier stood at
 * a check it could not pass: a challenge wall, or a page that never sent its
 * query because its Turnstile widget or puzzle was not passed. The tiers ran
 * out, or the deadline did while the next tier was still trying. Any other
 * failure keeps its own kind.
 */
function trawlChallenged(error: unknown): boolean {
  if (!(error instanceof UpstreamHttpError) || error.status !== 500) return false;
  let reply: unknown;
  try { reply = JSON.parse(error.diagnostics?.body_excerpt ?? ''); } catch { return false; }
  if (!isRecord(reply) || !Array.isArray(reply.timings)
    || (reply.error !== 'Max tier reached without success' && reply.error !== 'Scrape deadline exceeded')) return false;
  const last: unknown = reply.timings.at(-1);
  return isRecord(last) && (last.tier === 2 || last.tier === 3)
    && (last.status === 'blocked' || (last.status === 'error' && last.reason === NO_QUERY));
}

/**
 * The tracking reply the page's own request received. The capture helper keeps
 * only the page's query for the whole number; the newest reply is final.
 */
export function parseSwiftxCapture(page: TrawlScrapeResponse, number: string, readAt = Date.now()): CarrierResult {
  const rows = page.capturedResponses.filter((row) => row.url === SWIFTX_API);
  const reply = rows.at(-1);
  if (!reply || rows.length > 10) throw new ChallengeError(PROVIDER, 'SwiftX returned no tracking reply in the browser');
  if (reply.status === 429) {
    const retryAfter = reply.headers['retry-after'];
    throw new RateLimitedError(PROVIDER, retryAfter && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined);
  }
  if (reply.status === 401 || reply.status === 403) throw new ChallengeError(PROVIDER, 'SwiftX refused the browser tracking request', { status: reply.status });
  if (reply.status >= 400) throw new UpstreamHttpError(PROVIDER, reply.status);
  if (reply.status !== 200 || reply.error || reply.truncated || reply.base64Encoded || reply.body === null) {
    throw new TransportError(PROVIDER, 'SwiftX returned an incomplete browser response');
  }
  if (reply.body.length > SWIFTX_MAX_BYTES) throw new SchemaError(PROVIDER, 'SwiftX returned excessive tracking data');
  // A page in place of the reply is the edge's challenge, not a missing parcel.
  if (/^\s*</.test(reply.body)) throw new ChallengeError(PROVIDER, 'SwiftX returned a browser challenge');
  let payload: unknown;
  try { payload = JSON.parse(reply.body); } catch (error) { throw new SchemaError(PROVIDER, 'SwiftX returned unreadable tracking JSON', { cause: error }); }
  return parseSwiftx(payload, number, readAt);
}

/**
 * One lookup through the browser service: the tracking page passes
 * Cloudflare's check and its own Turnstile widget, asks its GraphQL endpoint
 * for the number and the service's capture helper returns that reply.
 */
export async function swiftxBrowser(trawl: TrawlClient, raw: string, signal: AbortSignal, remainingMs: number,
  fetcher?: typeof fetch): Promise<CarrierResult> {
  const number = normalizeSwiftxNumber(raw);
  const timeoutMs = Math.floor(Math.min(SERVICE_MS, remainingMs - 2000));
  if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
  let page: TrawlScrapeResponse;
  try {
    page = await trawl.scrape({ url: swiftxTrackingUrl(number), skipHttp: true, maxTier: 3,
      maxTimeout: timeoutMs, captureResponses: [SWIFTX_API], settleTimeout: SETTLE_MS },
    { provider: `TRAWL while fetching ${PROVIDER}`, timeoutMs, signal, fetcher, maxBytes: 4 * SWIFTX_MAX_BYTES });
  } catch (error) {
    if (trawlChallenged(error)) throw new ChallengeError(PROVIDER, 'SwiftX\'s tracking page did not pass its verification in the browser', { cause: error });
    throw error;
  }
  signal.throwIfAborted();
  return parseSwiftxCapture(page, number);
}

export class SwiftxTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeSwiftxNumber(raw);
    const trawl = this.options.trawl;
    // Cloudflare challenges the tracker and its API for other clients, and the query needs the page's verification.
    if (!trawl) throw new ChallengeError(PROVIDER, 'SwiftX requires the browser tracking service');
    return runSteps({ carrier: 'swiftx', budgetMs: context.budgetMs ?? SERVICE_MS + TRAWL_TRANSPORT_ALLOWANCE_MS,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => swiftxBrowser(trawl, number, signal, remainingMs, this.options.fetcher) },
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SwiftxTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'swiftx', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
