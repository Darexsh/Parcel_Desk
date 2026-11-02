import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { CARRIER_DEFINITIONS, carrierDefinition } from '../core/catalog/index.js';
import { detectCarrierMatch, normalizeTrackingNumber, validTrackingNumber } from '../core/detection/index.js';
import { InputRequiredError } from '../core/errors/index.js';
import type { FailureHint } from '../core/errors/hint.js';
import { createTracker, TrackingError, type ParcelInput, type Tracker, type TrackerOptions, type TrackingAttempt, type TrackingResponse } from '../facade/index.js';
import { CARRIER_CATALOG, type CarrierId } from '../generated/catalog.js';
import { demoPage } from './page.js';

export interface TrackingServerOptions extends TrackerOptions {
  token?: string;
  demoPage?: boolean;
  tracker?: Tracker;
  /** Requests each client may make per minute. */
  rateLimit?: number;
  /** How long an answer is shared; a carrier's own minimum refresh interval extends it. */
  cacheMs?: number;
  /**
   * How long a failed lookup is shared, so repeats do not reach the carrier again. The
   * upstream's retry advice, up to `cacheMs`, and the wait a carrier asks for after a
   * failure extend it.
   */
  failureCacheMs?: number;
  /** Lookups in progress at once, across all clients. */
  maxConcurrent?: number;
  /**
   * Reverse proxies in front of the server that append to `X-Forwarded-For`.
   * Zero trusts no header and limits by socket address; behind proxies that
   * leaves every client in one bucket.
   */
  trustedProxies?: number;
  /** Receives route names and status only; input and error objects never enter logs. */
  log?: (record: { method: string; route: string; status: number; durationMs: number }) => void;
  now?: () => number;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1) throw new TypeError(`Invalid ${name}`);
  return value;
}

/** What the cache holds for one lookup: its answer, or the failure it ended in. */
interface Remembered { until: number; value?: TrackingResponse; error?: TrackingError | InputRequiredError }

/** Attempts that are no failure of the source: it answered, or the lookup ran out of time. */
const SPARED: ReadonlySet<TrackingAttempt['kind']> = new Set(['ok', 'not_found', 'invalid_input', 'budget']);

/** The wait a carrier asks for after a failed lookup; a universal provider is not in the catalog and asks for none. */
function afterFailureMs(source: string): number {
  const refresh = Object.hasOwn(CARRIER_DEFINITIONS, source) ? CARRIER_DEFINITIONS[source as CarrierId].tracking.refresh : undefined;
  return (refresh?.afterFailureMinutes ?? 0) * 60_000;
}

/** A peer as proxies write it: `address`, `address:port` or `[address]:port`. Empty when it is none of them. */
function forwardedAddress(entry: string): string {
  const bare = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(entry)?.[1]
    ?? /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(entry)?.[1]
    ?? entry;
  return isIP(bare) ? bare : '';
}

/**
 * How a failed lookup is answered; the status follows what the caller can do about it.
 * `retryAfterMs` is the wait the header and the hint both advertise: the upstream's own
 * advice unless the server knows when it will ask again.
 */
function failure(error: TrackingError, retryAfterMs = error.hint.retryAfterMs): { status: number; retryAfterMs?: number; body: { error: string; attempts: TrackingError['attempts']; hint: FailureHint } } {
  const status = error.hint.kind === 'not_found' ? 404 : error.hint.kind === 'rate_limited' ? 429
    : error.hint.kind === 'invalid_input' ? 400 : 502;
  return { status, retryAfterMs, body: { error: error.message, attempts: error.attempts,
    hint: retryAfterMs === undefined ? error.hint : { ...error.hint, retryAfterMs } } };
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'Use application/json');
  const limit = 16_384;
  if (Number(request.headers['content-length']) > limit) throw new HttpError(413, 'Request body is too large');
  const chunks: Buffer[] = [];
  let length = 0;
  const stream: AsyncIterable<unknown> = request;
  for await (const chunk of stream) {
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) throw new HttpError(400, 'Invalid request body');
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(bytes);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Supply a JSON object');
  return parsed as Record<string, unknown>;
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** Shared, bounded memory only: no accounts, parcel store, scheduler or database. */
export function createTrackingServer(options: TrackingServerOptions = {}) {
  const tracker = options.tracker ?? createTracker({ ...options, providerSpacingMs: options.providerSpacingMs ?? 1_000 });
  const now = options.now ?? Date.now;
  const rateLimit = positive(options.rateLimit ?? 30, 'rate limit');
  const maxConcurrent = positive(options.maxConcurrent ?? 8, 'concurrency');
  const cacheMs = positive(options.cacheMs ?? 600_000, 'cache interval');
  const failureCacheMs = positive(options.failureCacheMs ?? 60_000, 'failure cache interval');
  const trustedProxies = options.trustedProxies ?? 0;
  if (!Number.isInteger(trustedProxies) || trustedProxies < 0 || trustedProxies > 8) throw new TypeError('Invalid trusted proxy count');
  const clients = new Map<string, { until: number; count: number }>();
  const cache = new Map<string, Remembered>();
  /** When repeating a held failure can next get a new answer. */
  const retryAt = new WeakMap<TrackingError, number>();
  const pending = new Map<string, Promise<TrackingResponse>>();
  const routes = new Set(['/v1/carriers', '/v1/detect', '/v1/recognize', '/v1/track', '/health', '/openapi.json', '/', '/assets/scraper.js']);
  let active = 0;

  /**
   * The address rate limits count. Each trusted proxy appended the peer it
   * saw, so the client is that many entries from the right; anything further
   * left was written by the client and is never read.
   */
  function clientAddress(request: IncomingMessage): string {
    const socket = request.socket.remoteAddress ?? 'unknown';
    if (trustedProxies === 0) return socket;
    const header = request.headers['x-forwarded-for'];
    const forwarded = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map(value => value.trim()).filter(Boolean);
    const address = forwarded.at(-trustedProxies);
    return (address && forwardedAddress(address)) || socket;
  }

  function limited(request: IncomingMessage): boolean {
    const client = clientAddress(request);
    const time = now();
    if (clients.size >= 10_000 && !clients.has(client)) {
      for (const [key, value] of clients) if (value.until <= time) clients.delete(key);
      if (clients.size >= 10_000) return true;
    }
    let window = clients.get(client);
    if (!window || window.until <= time) { window = { until: time + 60_000, count: 0 }; clients.set(client, window); }
    return ++window.count > rateLimit;
  }

  /** One online lookup, a tracking or a recognition, within the server's concurrency. */
  async function admitted<T>(run: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) throw new HttpError(429, 'Tracking is busy; retry later');
    active++;
    try { return await run(); }
    finally { active--; }
  }

  async function tracked(input: ParcelInput, budgetMs?: number): Promise<TrackingResponse> {
    if (typeof input.number !== 'string' || input.number.length > 80 || !validTrackingNumber(input.number)) throw new TypeError('Invalid tracking number');
    if (input.carrier !== undefined && (typeof input.carrier !== 'string' || !input.carrier)) throw new TypeError('Invalid carrier');
    const number = normalizeTrackingNumber(input.number);
    // Detection reads the number as printed, and so does the tracker's recognition of it.
    const detected = detectCarrierMatch(input.number);
    input = { ...input, carrier: input.carrier ?? (detected.confidence === 'high' ? detected.carrier : undefined) };
    // Without a carrier, the printed form decides which carriers recognition asks.
    const key = createHash('sha256').update(JSON.stringify([number, input.carrier ?? detected.candidates, input.postcode, input.postcodeCountry, input.trackingUrl, input.countryHint, input.language])).digest('hex');
    const previous = cache.get(key);
    if (previous && previous.until > now()) {
      if (previous.error) throw previous.error;
      return previous.value!;
    }
    if (previous) cache.delete(key);
    // A caller waits on a lookup already running only when it runs on the same budget.
    const flight = `${key}:${budgetMs ?? ''}`;
    const inFlight = pending.get(flight);
    if (inFlight) return await inFlight;
    const remember = (entry: Remembered) => {
      if (cache.size >= 1_000) {
        // Entries past their time go first; a live one is given up only when none is.
        const time = now();
        for (const [stored, held] of cache) if (held.until <= time) cache.delete(stored);
        if (cache.size >= 1_000) cache.delete(cache.keys().next().value!);
      }
      cache.set(key, entry);
    };
    const operation = admitted(async () => {
      try {
        const value = await tracker.track(input, { budgetMs });
        const refresh = (carrierDefinition(value.carrier).tracking as { refresh?: { minMinutes: number } }).refresh;
        // An answer the caller's own budget cut short, such as a carrier summary whose provider
        // history was still loading, is not what the next caller would get either.
        if (budgetMs === undefined || !value.attempts.some(attempt => attempt.kind === 'budget')) {
          remember({ until: now() + Math.max(cacheMs, (refresh?.minMinutes ?? 0) * 60_000), value });
        }
        return value;
      } catch (error) {
        // A failure is remembered only when the lookup ran on the server's own budget and did not
        // spend it: the key carries no budget, and how long one caller waited says nothing about
        // what the next one would get.
        if (budgetMs === undefined && error instanceof TrackingError && error.hint.kind !== 'budget') {
          const time = now();
          const retry = error.hint.retryAfterMs ?? 0;
          // A carrier that failed is left alone for the wait it asks for, whatever a fallback then said.
          const hold = Math.max(failureCacheMs, Math.min(cacheMs, retry),
            ...error.attempts.filter(attempt => !SPARED.has(attempt.kind)).map(attempt => afterFailureMs(attempt.source)));
          remember({ until: time + hold, error });
          // No wait changes the answer for a number the carrier does not issue.
          if (error.hint.kind !== 'invalid_input') retryAt.set(error, time + Math.max(hold, retry));
        } else if (budgetMs === undefined && error instanceof InputRequiredError) {
          // Every candidate carrier was asked before the choice was left to the caller.
          remember({ until: now() + failureCacheMs, error });
        }
        throw error;
      }
    });
    pending.set(flight, operation);
    try { return await operation; }
    finally { pending.delete(flight); }
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = performance.now();
    let route = 'unknown';
    response.on('finish', () => {
      try { options.log?.({ method: request.method ?? 'unknown', route, status: response.statusCode, durationMs: Math.round(performance.now() - started) }); }
      catch { /* Logging cannot change an answer. */ }
    });
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      route = routes.has(path) ? path : 'unknown';
      if (request.method === 'GET' && path === '/health') { json(response, 200, { ok: true }); return; }
      if (request.method === 'GET' && options.demoPage && path === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
        response.end(demoPage); return;
      }
      if (request.method === 'GET' && options.demoPage && path === '/assets/scraper.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        response.end(await readFile(new URL('../browser/scraper.js', import.meta.url))); return;
      }
      if (!authorized(request, options.token)) { json(response, 401, { error: 'Authentication required' }); return; }
      if (limited(request)) { response.setHeader('Retry-After', '60'); json(response, 429, { error: 'Rate limit exceeded' }); return; }
      if (request.method === 'GET' && path === '/v1/carriers') { json(response, 200, CARRIER_CATALOG); return; }
      if (request.method === 'GET' && path === '/openapi.json') {
        json(response, 200, JSON.parse(await readFile(new URL('./openapi.json', import.meta.url), 'utf8'))); return;
      }
      if (!['/v1/detect','/v1/recognize','/v1/track'].includes(path)) { json(response, 404, { error: 'Not found' }); return; }
      if (request.method !== 'POST') { json(response, 405, { error: 'Use POST' }); return; }
      const input = await body(request);
      const allowed = path === '/v1/detect' ? ['text'] : path === '/v1/recognize' ? ['number','budgetMs']
        : ['number','carrier','postcode','postcodeCountry','trackingUrl','countryHint','language','budgetMs'];
      if (Object.keys(input).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unknown request field');
      if (path === '/v1/detect') { json(response, 200, tracker.detect(input.text as string)); return; }
      if (input.budgetMs !== undefined && (typeof input.budgetMs !== 'number' || !Number.isInteger(input.budgetMs) || input.budgetMs < 1 || input.budgetMs > 120_000)) throw new HttpError(400, 'Invalid lookup budget');
      if (path === '/v1/recognize') { json(response, 200, await admitted(() => tracker.recognize(input.number as string, { budgetMs: input.budgetMs as number | undefined }))); return; }
      const result = await tracked({ number: input.number as string, carrier: input.carrier as string | undefined,
        postcode: input.postcode as string | null | undefined, postcodeCountry: input.postcodeCountry as string | null | undefined, trackingUrl: input.trackingUrl as string | null | undefined, countryHint: input.countryHint as string | null | undefined,
        language: input.language as string | null | undefined }, input.budgetMs);
      json(response, 200, result);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 429) response.setHeader('Retry-After', '60');
        json(response, error.status, { error: error.message });
      } else if (error instanceof TrackingError) {
        const at = retryAt.get(error);
        const answer = failure(error, at === undefined ? undefined : Math.max(0, at - now()));
        if (answer.retryAfterMs !== undefined) response.setHeader('Retry-After', String(Math.ceil(answer.retryAfterMs / 1_000)));
        json(response, answer.status, answer.body);
      } else if (error instanceof InputRequiredError) {
        json(response, 400, { error: 'Additional carrier input required', field: error.field });
      } else if (error instanceof TypeError || error instanceof RangeError) {
        json(response, 400, { error: 'Invalid tracking input' });
      } else {
        json(response, 502, { error: 'Tracking is temporarily unavailable' });
      }
    }
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => response.destroy());
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
