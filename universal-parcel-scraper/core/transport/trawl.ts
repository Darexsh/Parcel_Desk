/**
 * One client for the private TRAWL browser service (a FlareSolverr-compatible
 * API). Adapters that need a real browser to get past a challenge, or to
 * capture an in-page API response, ask this client instead of building the
 * request themselves.
 *
 * Two endpoints exist on the service: the native `/scrape` API (tiers,
 * response capture, cookies, user agent) and the legacy `/v1` command API
 * (`request.get`). Both are bounded like every other provider call.
 */
import { CarrierError, ChallengeError, UpstreamHttpError, type CarrierErrorOptions } from '../errors/index.js';
import { decodeText, fetchBounded, parseJsonBytes } from './boundedFetch.js';
import { cleanScalar } from './text.js';
import { isRecord, type JsonObject } from '../types.js';

export interface TrawlScrapeRequest extends JsonObject {
  url: string;
  /** Skip the plain HTTP tier and go straight to a browser. */
  skipHttp?: boolean;
  /** 1 = HTTP client, 2 = headless browser, 3 = full browser with challenge solving. */
  maxTier?: 1 | 2 | 3;
  /** Milliseconds the service may spend before answering. */
  maxTimeout?: number;
  /** In-page API URLs whose responses the browser should capture. */
  captureResponses?: string[];
  settleTimeout?: number;
  /** Wait for a visible result marker before reading a client-rendered page. */
  contentWaitForSelector?: string;
}

export interface TrawlCapturedResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
  truncated: boolean;
  base64Encoded: boolean;
  error: string | null;
  /** 17TRACK's matching browser request included the supplied delivery postcode. */
  postcodeSubmitted?: boolean;
  /** A carrier helper bound this response's request to one whole tracking number. */
  trackingNumberSubmitted?: string;
}

export interface TrawlScrapeResponse {
  url: string;
  html: string;
  cookies: JsonObject[];
  userAgent: string | null;
  tier: number;
  statusCode: number;
  capturedResponses: TrawlCapturedResponse[];
  /** The whole decoded payload, for adapters that read fields not modelled here. */
  raw: JsonObject;
}

export interface TrawlCallOptions {
  /** Label used in errors and diagnostics, for example "TRAWL while fetching UPS". */
  provider: string;
  timeoutMs: number;
  maxBytes?: number;
  fetcher?: typeof fetch;
  /** Cancel the service request and all readiness/recovery requests together. */
  signal?: AbortSignal;
  /** Require a solved browser tier (2 or 3) with HTTP 200. Default true. */
  requireSolved?: boolean;
  /** Which bounded capture window to retain. Defaults to the first 50 responses. */
  captureWindow?: 'first' | 'last';
  /** Page statuses to return with their page instead of raising, for a caller that reads the page. */
  allowHttpStatuses?: readonly number[];
}

export class TrawlError extends CarrierError {
  constructor(provider: string, message: string, options?: CarrierErrorOptions) {
    super('transport', provider, message, options);
    this.name = 'TrawlError';
  }
}

const DEFAULT_MAX_BYTES = 10_000_000;
/**
 * How long a request to the browser service may outlast the time the service
 * was given, so its own timeout answer still arrives. A lookup whose budget is
 * its default leaves this much room after the service's time.
 */
export const TRAWL_TRANSPORT_ALLOWANCE_MS = 15_000;
const TRANSPORT_ALLOWANCE_MS = TRAWL_TRANSPORT_ALLOWANCE_MS;

function pageHttpError(provider: string, status: number, headers: unknown): UpstreamHttpError {
  const retryHeader = isRecord(headers)
    ? Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1] : undefined;
  const retryAfterMs = typeof retryHeader !== 'string' ? undefined : /^\d+$/.test(retryHeader.trim())
    ? Number(retryHeader) * 1_000 : Date.parse(retryHeader) - Date.now();
  return new UpstreamHttpError(provider, status, Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs!) : undefined);
}

/**
 * End the call when its signal has aborted. A cancellation is rethrown as the
 * caller gave it. A deadline is a browser service that did not answer in
 * time: the request's own failure when there is one, typed either way.
 */
function throwIfEnded(options: TrawlCallOptions, failure?: unknown): void {
  const signal = options.signal;
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (!(reason instanceof DOMException && reason.name === 'TimeoutError')) throw reason;
  throw failure instanceof CarrierError ? failure
    : new TrawlError(options.provider, 'The browser service did not answer before the deadline', { cause: reason });
}

export function trawlEndpoint(configured: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(configured.trim());
  } catch (error) {
    throw new TypeError('FLARESOLVERR_URL must be an HTTP(S) URL', { cause: error });
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.host) {
    throw new TypeError('FLARESOLVERR_URL must be an HTTP(S) URL');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/(?:v1|scrape)\/?$/, '').replace(/\/$/, '');
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

function captured(value: unknown, window: 'first' | 'last' = 'first'): TrawlCapturedResponse[] {
  if (!Array.isArray(value)) return [];
  const records = value.filter(isRecord);
  return (window === 'last' ? records.slice(-50) : records.slice(0, 50)).map((entry) => ({
    url: typeof entry.url === 'string' ? entry.url : '',
    status: Number.isInteger(entry.status) ? Number(entry.status) : 0,
    headers: isRecord(entry.headers)
      ? Object.fromEntries(Object.entries(entry.headers).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
      : {},
    body: typeof entry.body === 'string' ? entry.body : null,
    truncated: entry.truncated === true,
    base64Encoded: entry.base64Encoded === true,
    error: typeof entry.error === 'string' ? entry.error : entry.error ? 'error' : null,
    ...(entry.postcodeSubmitted === true ? { postcodeSubmitted: true } : {}),
    ...(typeof entry.trackingNumberSubmitted === 'string' && /^[A-Z0-9]{6,40}$/.test(entry.trackingNumberSubmitted)
      ? { trackingNumberSubmitted: entry.trackingNumberSubmitted } : {}),
  }));
}

/**
 * Decode the several shapes TRAWL releases use for a captured body: a string,
 * a byte array, a serialized Node Buffer, or an index-keyed object.
 * This does not decompress wire bytes. Tier1's html is already decoded text;
 * browser response bodies are separate from their rendered DOM snapshots.
 */
export function trawlBody(value: JsonObject, maxBytes = DEFAULT_MAX_BYTES): string {
  if (typeof value.body === 'string') return value.body;
  const rawBody = value.body;
  let bytes: number[] | null = null;
  const byteLike = (entry: unknown): boolean => Number.isInteger(entry) && Number(entry) >= 0 && Number(entry) <= 255;
  if (Array.isArray(rawBody)) {
    bytes = rawBody.length <= maxBytes && rawBody.every(byteLike) ? rawBody as number[] : null;
  } else if (isRecord(rawBody) && rawBody.type === 'Buffer' && Array.isArray(rawBody.data)) {
    bytes = rawBody.data.length <= maxBytes && rawBody.data.every(byteLike) ? rawBody.data as number[] : null;
  } else if (isRecord(rawBody)) {
    const entries = Object.entries(rawBody);
    if (entries.length > 0 && entries.length <= maxBytes) {
      entries.sort((left, right) => Number(left[0]) - Number(right[0]));
      const sequential = entries.every(([key, entry], index) => String(index) === key && byteLike(entry));
      if (sequential) bytes = entries.map(([, entry]) => Number(entry));
    }
  }
  return bytes ? decodeText(Uint8Array.from(bytes)) : '';
}

export class TrawlClient {
  readonly endpoint: URL;

  constructor(configured: string, private readonly fetcher?: typeof fetch) {
    this.endpoint = trawlEndpoint(configured);
  }

  /** The client for `FLARESOLVERR_URL`, or null when no browser service is configured. */
  static fromEnvironment(env: Record<string, string | undefined> = process.env, fetcher?: typeof fetch): TrawlClient | null {
    const configured = (env.FLARESOLVERR_URL ?? '').trim();
    return configured ? new TrawlClient(configured, fetcher) : null;
  }

  private withPath(segment: string): URL {
    const url = new URL(this.endpoint);
    // A bare origin normalizes its pathname back to "/", so strip it before appending.
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${segment}`;
    return url;
  }

  scrapeUrl(): URL {
    return this.withPath('scrape');
  }

  commandUrl(): URL {
    return this.withPath('v1');
  }

  private requestFetcher(options: TrawlCallOptions): typeof fetch {
    const fetcher = options.fetcher ?? this.fetcher ?? fetch;
    if (!options.signal) return fetcher;
    return (input, init) => {
      options.signal!.throwIfAborted();
      return fetcher(input, { ...init, signal: AbortSignal.any([
        options.signal!, ...(init?.signal ? [init.signal] : []),
      ]) });
    };
  }

  /** Native API: load a page in a browser tier, optionally capturing in-page API responses. */
  async scrape(request: TrawlScrapeRequest, options: TrawlCallOptions): Promise<TrawlScrapeResponse> {
    throwIfEnded(options);
    const deadline = performance.now() + options.timeoutMs + TRANSPORT_ALLOWANCE_MS;
    try { return await this.scrapeOnce(request, options); }
    catch (error) {
      throwIfEnded(options, error);
      // Retry only an identified dead browser, never maintenance, challenges or arbitrary 500s.
      if (!(error instanceof UpstreamHttpError) || error.status < 500
        || !/Target page, context or browser has been closed/.test(error.diagnostics?.body_excerpt ?? '')
        || deadline - performance.now() < TRANSPORT_ALLOWANCE_MS + 3_000) throw error;
      try {
        const { bytes } = await fetchBounded(this.withPath('health'), {}, {
          provider: 'TRAWL readiness', timeoutMs: 2_000, maxBytes: 16_384,
          fetcher: this.requestFetcher(options),
        });
        throwIfEnded(options, error);
        const health = parseJsonBytes(bytes, 'TRAWL readiness');
        if (!isRecord(health) || health.status !== 'ok' || !isRecord(health.pool)
          || Number(health.pool.live) < 1 || Number(health.pool.available) < 1) throw error;
      } catch { throwIfEnded(options, error); throw error; }
      const remaining = Math.floor(deadline - performance.now() - TRANSPORT_ALLOWANCE_MS);
      if (remaining < 1_000) throw error;
      return this.scrapeOnce({ ...request, maxTimeout: Math.min(request.maxTimeout ?? options.timeoutMs, remaining) },
        { ...options, timeoutMs: remaining });
    }
  }

  private async scrapeOnce(request: TrawlScrapeRequest, options: TrawlCallOptions): Promise<TrawlScrapeResponse> {
    throwIfEnded(options);
    const { bytes, response } = await fetchBounded(this.scrapeUrl(), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }, {
      provider: options.provider,
      timeoutMs: options.timeoutMs + TRANSPORT_ALLOWANCE_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      fetcher: this.requestFetcher(options),
      // An HTTP-only lookup has exactly one upstream outcome. TRAWL wraps its
      // blocked responses in HTTP 500, including upstream 429 and HTTP 200 walls.
      allowHttpStatuses: request.maxTier === 1 ? [500] : undefined,
    });
    throwIfEnded(options);
    let value: unknown;
    try { value = parseJsonBytes(bytes, options.provider); }
    catch (error) {
      if (response.status === 500) throw new UpstreamHttpError(options.provider, 500);
      throw error;
    }
    if (!isRecord(value)) throw new TrawlError(options.provider, 'The browser service returned an invalid response');
    if (request.maxTier === 1 && value.error === 'Max tier reached without success'
      && Array.isArray(value.timings) && value.timings.length === 1) {
      const attempt: unknown = value.timings[0];
      if (isRecord(attempt) && attempt.tier === 1 && ['blocked', 'needs-js', 'error'].includes(String(attempt.status))) {
        if (Number.isInteger(attempt.statusCode) && Number(attempt.statusCode) >= 400) {
          throw pageHttpError(options.provider, Number(attempt.statusCode), attempt.responseHeaders);
        }
        if (attempt.statusCode === 200 && ['blocked', 'needs-js'].includes(String(attempt.status))) {
          throw new ChallengeError(options.provider, 'The tracking page requires browser verification');
        }
      }
    }
    if (response.status === 500) throw new UpstreamHttpError(options.provider, 500);
    if (value.error) {
      throw new TrawlError(options.provider, cleanScalar(value.error, 200) || 'The browser service could not fetch the page');
    }
    const statusCode = Number(value.statusCode);
    if (Number.isInteger(statusCode) && statusCode >= 400 && !options.allowHttpStatuses?.includes(statusCode)) {
      throw pageHttpError(options.provider, statusCode, value.responseHeaders);
    }
    const tier = Number(value.tier);
    if ((options.requireSolved ?? true) && (![2, 3].includes(tier) || statusCode !== 200)) {
      throw new TrawlError(options.provider, 'The browser service did not solve the page');
    }
    if (typeof value.html !== 'string') throw new TrawlError(options.provider, 'The browser service returned no page');
    return {
      url: typeof value.url === 'string' ? value.url : request.url,
      html: value.html,
      cookies: Array.isArray(value.cookies) ? value.cookies.filter(isRecord) : [],
      userAgent: typeof value.userAgent === 'string' ? value.userAgent : null,
      tier,
      statusCode,
      capturedResponses: captured(value.capturedResponses, options.captureWindow),
      raw: value,
    };
  }

  /** Legacy command API (`request.get`): returns the solved page HTML. */
  async solve(url: string, options: TrawlCallOptions): Promise<string> {
    throwIfEnded(options);
    const { bytes } = await fetchBounded(this.commandUrl(), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      // TRAWL 1.9 stopped solving a page's embedded form widgets on this API unless asked; earlier
      // releases ignore the field and solve them anyway.
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: options.timeoutMs, solveEmbeddedCaptchas: true }),
    }, {
      provider: options.provider,
      timeoutMs: options.timeoutMs + TRANSPORT_ALLOWANCE_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      fetcher: this.requestFetcher(options),
    });
    throwIfEnded(options);
    const payload = parseJsonBytes(bytes, options.provider);
    const solution = isRecord(payload) && isRecord(payload.solution) ? payload.solution : {};
    if (isRecord(payload) && payload.status === 'ok' && [200, 302].includes(Number(solution.status))
      && typeof solution.response === 'string') {
      return solution.response;
    }
    throw new TrawlError(options.provider, 'The browser service did not solve the page');
  }
}
