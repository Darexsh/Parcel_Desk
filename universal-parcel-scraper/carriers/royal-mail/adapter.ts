import { recognizeFromBrowserLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { cleanScalar, TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fetchRoyalMailInBrowser, royalMailDestination } from './browser.js';
import type { RoyalMailCaptchaOptions, RoyalMailVerificationRecord } from './vision.js';
import { normalizeRoyalMailNumber, parseRoyalMailTrackingHtml, parseRoyalMailTrackingResponse,
  royalMailEventsApiUrl, royalMailSummaryApiUrl, royalMailTrackingUrl, royalMailUnconfirmed } from './parser.js';

export { normalizeRoyalMailNumber, parseRoyalMailTrackingHtml, parseRoyalMailTrackingResponse,
  royalMailEventsApiUrl, royalMailSummaryApiUrl, royalMailTrackingUrl } from './parser.js';

const MAX_BYTES = 10_000_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const SETTLE_TIMEOUT_MS = 15_000;
// A healthy lookup needs a fraction of this. A browser that is down fails every
// parcel the same way, and each failure must not hold a consumer's run for a minute.
const BROWSER_TIMEOUT_MS = 30_000;
// A fresh consent flow and the separate history request need time to complete.
const BROWSER_RETRY_MIN_MS = 15_000;
const MAX_CAPTURED = 20;

export interface RoyalMailTrackerOptions {
  /** Private Playwright WebSocket service; preferred when supplied. Keep its capability URL outside logs and Git. */
  browserWsEndpoint?: string | null;
  /** Fresh local Chromium, used when no private browser endpoint is supplied. */
  executablePath?: string | null;
  /** An `http://` or `socks5://` proxy for the local Chromium's traffic. */
  browserProxy?: string | null;
  timeoutMs?: number;
  /** The browser service, or null when none is configured. */
  trawl?: TrawlClient | null;
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  /** Request the page's separate events flow; summary-only calls remain the default. */
  fullHistory?: boolean;
  /** Optional Google vision recovery. Sends only the visible verification widget to Google. */
  captchaVision?: RoyalMailCaptchaOptions;
}

export class RoyalMailTracker {
  readonly timeoutMs: number;
  readonly #trawl: TrawlClient | null;
  readonly #fetcher: typeof fetch | undefined;
  readonly #recorder: StepRecorder;
  readonly #fullHistory: boolean;
  readonly #executablePath: string | null;
  readonly #browserProxy: string | null;
  readonly #browserWsEndpoint: string | null;
  readonly #captchaVision: RoyalMailCaptchaOptions | undefined;

  constructor(options: RoyalMailTrackerOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new TypeError('Royal Mail timeout must be positive');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#trawl = options.trawl ?? null;
    this.#fetcher = options.fetcher;
    this.#recorder = options.recorder ?? NOOP_RECORDER;
    this.#fullHistory = options.fullHistory ?? false;
    this.#executablePath = options.executablePath ?? null;
    this.#browserProxy = options.browserProxy?.trim() || null;
    this.#browserWsEndpoint = options.browserWsEndpoint?.trim() || null;
    this.#captchaVision = options.captchaVision;
  }

  async fetch(trackingNumber: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRoyalMailNumber(trackingNumber);
    if (this.#browserWsEndpoint || this.#executablePath) {
      const budgetMs = Math.min(BROWSER_TIMEOUT_MS, context.budgetMs ?? this.timeoutMs);
      const started = performance.now();
      const vision = this.#captchaVision ? { options: this.#captchaVision, attempt: { used: false } } : undefined;
      const run = ({ remainingMs, signal, attempt }: { remainingMs: number; signal: AbortSignal; attempt: number }) => {
        const args = [number, this.#executablePath ?? '', signal, remainingMs, this.#fullHistory,
          this.#browserProxy, this.#browserWsEndpoint] as const;
        return vision ? fetchRoyalMailInBrowser(...args, { ...vision,
          retryReserveMs: attempt === 1 ? BROWSER_RETRY_MIN_MS : 0 }) : fetchRoyalMailInBrowser(...args);
      };
      return runSteps<CarrierResult>({ carrier: 'royal-mail', budgetMs,
        signal: context.signal, recorder: this.#recorder }, [
        { id: 'browser', run },
        // Each call disposes its context before returning. A fresh session can
        // recover an intermittent edge refusal without retaining issued tokens.
        { id: 'retry', run, recovers: error => error instanceof ChallengeError
          && error.reason !== 'captcha_refused' && error.reason !== 'captcha_blocked'
          && budgetMs - (performance.now() - started) >= BROWSER_RETRY_MIN_MS },
      ]);
    }
    // The legacy service remains available through explicit tracker instances.
    const trawl = this.#trawl;
    if (!trawl) {
      throw new ChallengeError(
        'Royal Mail',
        'Royal Mail challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
      );
    }
    return runSteps<CarrierResult>({
      // Without a caller's budget the lookup leaves the service its own time and
      // the request the allowance to bring the answer back.
      carrier: 'royal-mail', budgetMs: context.budgetMs ?? this.timeoutMs + TRAWL_TRANSPORT_ALLOWANCE_MS, signal: context.signal,
      recorder: this.#recorder,
    }, [
      { id: 'trawl', run: ({ remainingMs, signal }) => this.#trawlResult(trawl, number, Math.max(1, Math.floor(Math.min(this.timeoutMs, remainingMs))), signal) },
    ]);
  }

  /**
   * A real browser loads the page and makes the tracking calls itself; the
   * service hands that reply back. The browser's session is never replayed
   * over plain HTTP: the edge accepts the call only from the session it
   * validated. The page the browser rendered only tells a challenge apart.
   */
  async #trawlResult(trawl: TrawlClient, number: string, timeoutMs: number, signal: AbortSignal): Promise<CarrierResult> {
    const summaryUrl = royalMailSummaryApiUrl(number);
    const eventsUrl = royalMailEventsApiUrl(number);
    const page = await trawl.scrape({
      url: royalMailTrackingUrl(number),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: timeoutMs,
      captureResponses: this.#fullHistory ? [summaryUrl, eventsUrl] : [summaryUrl],
      settleTimeout: SETTLE_TIMEOUT_MS,
    }, {
      provider: 'TRAWL while fetching Royal Mail',
      // A browser may validate its cached main document with 304 while the
      // freshly submitted tracking request still returns a normal JSON reply.
      requireSolved: false,
      timeoutMs,
      maxBytes: MAX_BYTES,
      fetcher: this.#fetcher,
      signal,
    });
    if (![2, 3].includes(page.tier) || ![200, 304].includes(page.statusCode)) {
      throw new TransportError('Royal Mail', 'The browser service did not load the Royal Mail tracking page');
    }
    let captureError: unknown;
    const readCaptured = (targetUrl: string): unknown => {
      // Newest first: a later reply is the page's final answer. The entry URL
      // itself carries the number, so only the exact requested call is read.
      for (const entry of page.capturedResponses.slice(0, MAX_CAPTURED).reverse()) {
        if (entry.url !== targetUrl) continue;
        if (entry.status === 429) {
          const retry = entry.headers['retry-after'];
          const retryMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1_000 : undefined;
          throw new RateLimitedError('Royal Mail', retryMs);
        }
        if ([401, 403].includes(entry.status)) throw new ChallengeError('Royal Mail');
        if (entry.status === 404 && entry.body && !entry.truncated && !entry.base64Encoded && !entry.error) {
          let payload: unknown;
          try { payload = JSON.parse(entry.body); } catch { /* Keep the HTTP failure below. */ }
          const unconfirmed = isRecord(payload) && Array.isArray(payload.errors) ? royalMailUnconfirmed(payload.errors) : null;
          if (unconfirmed) throw unconfirmed;
        }
        if ([404, 410].includes(entry.status)) throw new TransportError('Royal Mail', 'Royal Mail tracking endpoint is unavailable');
        if (entry.status >= 400) throw new UpstreamHttpError('Royal Mail', entry.status);
        if (entry.status !== 200 || entry.truncated || entry.base64Encoded || entry.error || entry.body === null) continue;
        try {
          return JSON.parse(entry.body) as unknown;
        } catch (error) {
          // An unreadable or unrelated reply; the rendered page may still name a challenge.
          if (!(error instanceof SyntaxError)) throw error;
          captureError = error;
        }
      }
      return undefined;
    };
    const summaryPayload = readCaptured(summaryUrl);
    if (summaryPayload !== undefined) {
      // Validate the summary independently before merging its status with history.
      const summaryResult = this.#structuredResult(number, summaryPayload);
      if (!this.#fullHistory) return summaryResult;
      const historyPayload = readCaptured(eventsUrl);
      if (historyPayload !== undefined) {
        if (!isRecord(historyPayload)) throw new SchemaError('Royal Mail', 'Royal Mail returned invalid tracking events');
        // Preserve the same error vocabulary as the summary endpoint.
        if (historyPayload.errors !== undefined || historyPayload.httpCode !== undefined) {
          parseRoyalMailTrackingResponse(historyPayload, number);
        }
        const historyPiece = historyPayload.mailPieces;
        if (!isRecord(historyPiece) || cleanScalar(historyPiece.mailPieceId).toUpperCase() !== number
          || !Array.isArray(historyPiece.events)) {
          throw new SchemaError('Royal Mail', 'Royal Mail did not return the requested parcel history');
        }
        const summaryPiece = (summaryPayload as { mailPieces: Record<string, unknown> }).mailPieces;
        return this.#structuredResult(number, { mailPieces: {
          mailPieceId: number, summary: { ...(summaryPiece.summary as Record<string, unknown>), ...royalMailDestination(historyPiece.summary).summary },
          estimatedDelivery: historyPiece.estimatedDelivery ?? summaryPiece.estimatedDelivery, events: historyPiece.events,
        } });
      }
    }
    if (parseRoyalMailTrackingHtml(page.html) === 'challenged') {
      throw new ChallengeError('Royal Mail', 'Royal Mail challenged the browser tracking session', { cause: captureError });
    }
    throw new TransportError('Royal Mail', 'TRAWL did not capture the Royal Mail tracking response', { cause: captureError });
  }

  #structuredResult(number: string, payload: unknown): CarrierResult {
    const result = parseRoyalMailTrackingResponse(payload, number);
    result.tracking_url = royalMailTrackingUrl(number);
    result.tracking_source = 'structured-web-response';
    return result;
  }
}

export const adapter: AdapterFactory = environment => {
  const endpoint = environment.env.ROYAL_MAIL_BROWSER_WS_ENDPOINT?.trim() || null;
  const apiKey = environment.env.ROYAL_MAIL_GEMINI_API_KEY?.trim();
  const onVerification = environment.env.ROYAL_MAIL_GEMINI_LOG_VERIFICATION === '1'
    ? (record: RoyalMailVerificationRecord) => { console.warn(JSON.stringify({ event: 'royal_mail.verification', ...record })); } : undefined;
  const tracker = new RoyalMailTracker({ executablePath: environment.browserExecutablePath,
    browserWsEndpoint: endpoint, browserProxy: environment.env.ROYAL_MAIL_BROWSER_PROXY, recorder: environment.recorder, fullHistory: true,
    ...(apiKey ? { captchaVision: { apiKey, fetcher: environment.fetcher, onVerification } } : {}) });
  return {
    id: 'royal-mail', recordsSteps: true, steps: ['browser', 'retry'],
    track: (input, context) => {
      normalizeRoyalMailNumber(input.number);
      if (!endpoint && !environment.browserExecutablePath) throw new ChallengeError('Royal Mail', 'Royal Mail requires TRACKING_CHROMIUM_PATH or ROYAL_MAIL_BROWSER_WS_ENDPOINT');
      return tracker.fetch(input.number, context);
    },
    recognizeWithBrowser: (number, context) => recognizeFromBrowserLookup(() => {
      normalizeRoyalMailNumber(number);
      if (!endpoint && !environment.browserExecutablePath) throw new ChallengeError('Royal Mail', 'Royal Mail requires TRACKING_CHROMIUM_PATH or ROYAL_MAIL_BROWSER_WS_ENDPOINT');
      return tracker.fetch(number, context);
    }),
  };
};
