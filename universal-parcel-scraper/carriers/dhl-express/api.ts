import { setTimeout as delay } from 'node:timers/promises';
import type { AdapterEnvironment, LookupBudget } from '../../core/adapter/index.js';
import { NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { fetchBounded, parseJsonBytes } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { isRecord } from '../../core/types.js';

const PROVIDER = 'DHL Express';
export const API = 'https://api-eu.dhl.com/track/shipments';
/** DHL lets an app call the API once every five seconds. */
export const SPACING_MS = 5_000;
/** The longest a lookup waits for the key's next turn before it asks DHL another way. */
export const MAX_WAIT_MS = 10_000;
/** Time left for DHL's reply once the turn comes. */
const REPLY_MS = 3_000;
/** How long a key is left alone after a rate limit without a retry window, or after DHL refuses it. */
export const PAUSE_MS = 60 * 60_000;
const MAX_PAUSE_MS = 24 * 60 * 60_000;

/** The API not asked: the key is paused, or its next turn comes too late for the lookup. */
export class ApiPacedError extends RateLimitedError {
  constructor(retryAfterMs: number) {
    super(PROVIDER, retryAfterMs, 'DHL tracking API was asked as often as the key allows', { reason: 'self_paced' });
    this.name = 'ApiPacedError';
  }
}

/** DHL's answer for a number none of its divisions knows, from the API and the global page alike. */
export function isMissingShipment(payload: unknown): boolean {
  return isRecord(payload) && payload.status === 404 && payload.title === 'No result found'
    && payload.detail === 'No shipment with given tracking number found.';
}

function retryAfterMs(header: string | null): number | null {
  const value = header?.trim() ?? '';
  const ms = /^\d+$/.test(value) ? Number(value) * 1_000 : /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(value) ? Date.parse(value) - Date.now() : NaN;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_PAUSE_MS) : null;
}

/**
 * When a key may next be asked through one transport: its next turn, and the end of a pause
 * DHL's answer began. Every adapter instance in the process that sends through the same
 * fetcher with the same key shares it, as a host's several registries do. A restart forgets it.
 */
interface KeyState { nextAt: number; pausedUntil: number }
const states = new WeakMap<object, Map<string, KeyState>>();
const GLOBAL_FETCH = {};

function keyState(fetcher: typeof fetch | undefined, key: string): KeyState {
  const transport = transportOf(fetcher) ?? GLOBAL_FETCH;
  let keys = states.get(transport);
  if (!keys) states.set(transport, keys = new Map<string, KeyState>());
  let state = keys.get(key);
  if (!state) keys.set(key, state = { nextAt: 0, pausedUntil: 0 });
  return state;
}

/**
 * DHL's Shipment Tracking Unified API, under the consumer's own key in `DHL_API_KEY`. The key
 * never leaves this file: failures carry no request details.
 */
export class DhlTrackingApi {
  private readonly key: string | null;
  private readonly state: KeyState | null;

  constructor(private readonly environment: AdapterEnvironment) {
    this.key = environment.env.DHL_API_KEY?.trim() || null;
    this.state = this.key ? keyState(environment.fetcher, this.key) : null;
  }

  get configured(): boolean {
    return this.key !== null;
  }

  /** Whether DHL's last answer paused the key, so a lookup would fail without a request. */
  paused(): boolean {
    return !!this.state && this.state.pausedUntil > Date.now();
  }

  /**
   * DHL's shipments for one tracking number or piece. Calls through a key take turns five
   * seconds apart; a lookup whose turn would come after `MAX_WAIT_MS`, or too late for its
   * budget, fails as paced without a request. A rate limit pauses the key for DHL's retry
   * window, or `PAUSE_MS` without one; a refused key pauses it for `PAUSE_MS`.
   */
  async shipments(number: string, budget: LookupBudget): Promise<unknown> {
    const state = this.state;
    if (!this.key || !state) throw new TransportError(PROVIDER, 'DHL tracking API needs DHL_API_KEY');
    const now = Date.now();
    if (state.pausedUntil > now) throw new ApiPacedError(state.pausedUntil - now);
    const turn = Math.max(now, state.nextAt);
    if (turn - now > Math.min(MAX_WAIT_MS, budget.remainingMs() - REPLY_MS)) throw new ApiPacedError(turn - now);
    state.nextAt = turn + SPACING_MS;
    if (turn > now) await delay(turn - now, undefined, { signal: budget.signal });
    budget.signal.throwIfAborted();
    let reply: Awaited<ReturnType<typeof fetchBounded>>;
    try {
      reply = await fetchBounded(`${API}?${new URLSearchParams({ trackingNumber: number, language: 'en' })}`, {
        signal: budget.signal, headers: { accept: 'application/json', 'DHL-API-Key': this.key },
      }, { provider: PROVIDER, timeoutMs: budget.remainingMs(), maxBytes: 1_000_000, fetcher: this.environment.fetcher, allowHttpError: true });
    } catch (error) {
      // fetchBounded keeps the request, and so the key, on a network failure.
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
    const { response, bytes } = reply;
    budget.signal.throwIfAborted();
    if (response.status === 429) {
      const pauseMs = retryAfterMs(response.headers.get('retry-after')) ?? PAUSE_MS;
      state.pausedUntil = Date.now() + pauseMs;
      throw new RateLimitedError(PROVIDER, pauseMs, 'DHL tracking API is rate limiting the key');
    }
    if (response.status === 401 || response.status === 403) {
      state.pausedUntil = Date.now() + PAUSE_MS;
      throw new TransportError(PROVIDER, 'DHL tracking API refused the key', { status: response.status, reason: 'credentials_rejected' });
    }
    if (response.status === 404) {
      let missing: unknown;
      try { missing = parseJsonBytes(bytes, PROVIDER); } catch { /* An arbitrary 404 is not a shipment answer. */ }
      if (isMissingShipment(missing)) throw new NotFoundError(PROVIDER);
      throw new TransportError(PROVIDER, 'DHL tracking API endpoint is unavailable', { status: 404 });
    }
    if (response.status >= 500) throw new UpstreamHttpError(PROVIDER, response.status);
    if (response.status !== 200) throw new TransportError(PROVIDER, `DHL tracking API returned HTTP ${response.status}`, { status: response.status });
    try { return parseJsonBytes(bytes, PROVIDER); }
    catch (error) { throw new SchemaError(PROVIDER, 'DHL tracking API returned invalid JSON', { cause: error }); }
  }
}
