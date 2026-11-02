/**
 * FedEx's official Track API, for a deployment that has its own FedEx developer
 * project. `FEDEX_API_KEY` and `FEDEX_SECRET_KEY` are that project's API key and
 * secret key; `FEDEX_API_URL` points them at the sandbox instead of
 * `https://apis.fedex.com`. The keys buy an OAuth token
 * (`POST /oauth/token`, client credentials) that reads
 * `POST /track/v1/trackingnumbers`. Neither call is bot-gated.
 *
 * The keys and the token never leave this file: failures carry no request or
 * response details, and a reply that does not parse is not kept.
 */
import { RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

export const FEDEX_API_URL = 'https://apis.fedex.com';
const PROVIDER = 'FedEx';
const MAX_BYTES = 10_000_000;
// Tokens last an hour; one is renewed this long before it ends.
const RENEW_MS = 60_000;
const DEFAULT_LIFETIME_S = 3_600;
const MAX_LIFETIME_S = 86_400;
// A token request is shared by the lookups waiting on it, so it runs on its own clock.
const TOKEN_TIMEOUT_MS = 10_000;
// Keys FedEx refused are not offered again for this long.
const REFUSAL_MEMORY_MS = 10 * 60_000;

export interface FedExApiCredentials {
  readonly key: string;
  readonly secret: string;
  /** The API's origin; empty when `FEDEX_API_URL` is not an https URL. */
  readonly url: string;
}

/** The deployment's API project, or null without both keys. */
export function fedexApiCredentials(env: Readonly<Record<string, string | undefined>>): FedExApiCredentials | null {
  const key = env.FEDEX_API_KEY?.trim();
  const secret = env.FEDEX_SECRET_KEY?.trim();
  if (!key || !secret) return null;
  const configured = env.FEDEX_API_URL?.trim();
  if (!configured) return { key, secret, url: FEDEX_API_URL };
  try {
    const url = new URL(configured);
    return { key, secret, url: url.protocol === 'https:' ? url.origin : '' };
  } catch {
    return { key, secret, url: '' };
  }
}

/** FedEx refused the project's keys, or the project lacks the Track API. */
function refused(status: number): TransportError {
  return new TransportError(PROVIDER, `FedEx refused the API credentials (HTTP ${status})`, { status, reason: 'credentials_rejected' });
}

/** A reply other than 200, without the request that holds the keys or the token. */
function httpFailure(response: Response): Error {
  const { status } = response;
  if (status === 401 || status === 403) return refused(status);
  if (status === 429) {
    const header = response.headers.get('retry-after')?.trim() ?? '';
    const delay = /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : NaN;
    return new RateLimitedError(PROVIDER, Number.isFinite(delay) ? Math.max(0, delay) : undefined);
  }
  if (status >= 500) return new UpstreamHttpError(PROVIDER, status);
  return new TransportError(PROVIDER, `FedEx API returned HTTP ${status}`, { status });
}

function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeText(bytes));
  } catch {
    throw new SchemaError(PROVIDER, 'FedEx API returned a reply that is not JSON');
  }
}

/** `shared`, for as long as the lookup waiting on it is live: its own signal ends the wait, not the shared work. */
async function whileLive<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let leave!: () => void;
  const left = new Promise<never>((_resolve, reject) => { leave = () => reject(signal.reason); });
  signal.addEventListener('abort', leave, { once: true });
  try {
    return await Promise.race([shared, left]);
  } finally {
    signal.removeEventListener('abort', leave);
  }
}

export class FedExApiClient {
  readonly #credentials: FedExApiCredentials;
  readonly #fetcher: typeof fetch | undefined;
  #token: { value: string; renewAt: number } | null = null;
  #issuing: Promise<string> | null = null;
  #refusal: { error: Error; until: number } | null = null;

  constructor(credentials: FedExApiCredentials, fetcher?: typeof fetch) {
    this.#credentials = credentials;
    this.#fetcher = fetcher;
  }

  /** The Track API's reply for one number, with its detailed scans. */
  async track(number: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    if (!this.#credentials.url) throw new TransportError(PROVIDER, 'FEDEX_API_URL is not an https URL');
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.#accessToken(signal);
      const { response, bytes } = await this.#post('/track/v1/trackingnumbers', {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-locale': 'en_US',
      }, JSON.stringify({ includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber: number } }] }), signal, left());
      if (response.status === 200) return json(bytes);
      // A token FedEx no longer accepts is replaced once; refused again, the keys are.
      if (response.status === 401 && attempt === 0) {
        if (this.#token?.value === token) this.#token = null;
        continue;
      }
      const failure = httpFailure(response);
      if (response.status === 401) this.#refusal = { error: failure, until: Date.now() + REFUSAL_MEMORY_MS };
      throw failure;
    }
  }

  async #accessToken(signal: AbortSignal): Promise<string> {
    if (this.#token && Date.now() < this.#token.renewAt) return this.#token.value;
    if (this.#refusal && Date.now() < this.#refusal.until) throw this.#refusal.error;
    this.#issuing ??= this.#issue().finally(() => { this.#issuing = null; });
    return await whileLive(this.#issuing, signal);
  }

  async #issue(): Promise<string> {
    const { response, bytes } = await this.#post('/oauth/token', {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    }, new URLSearchParams({
      grant_type: 'client_credentials', client_id: this.#credentials.key, client_secret: this.#credentials.secret,
    }).toString(), AbortSignal.timeout(TOKEN_TIMEOUT_MS), TOKEN_TIMEOUT_MS);
    if (response.status !== 200) {
      const failure = httpFailure(response);
      if (response.status === 401 || response.status === 403) {
        this.#refusal = { error: failure, until: Date.now() + REFUSAL_MEMORY_MS };
      }
      throw failure;
    }
    const payload = json(bytes);
    const value = isRecord(payload) && typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
    if (!value) throw new SchemaError(PROVIDER, 'FedEx API issued no access token');
    const lifetime = isRecord(payload) && typeof payload.expires_in === 'number' && payload.expires_in > 0
      ? Math.min(payload.expires_in, MAX_LIFETIME_S) : DEFAULT_LIFETIME_S;
    this.#token = { value, renewAt: Date.now() + Math.max(0, lifetime * 1000 - RENEW_MS) };
    this.#refusal = null;
    return value;
  }

  async #post(path: string, headers: Record<string, string>, body: string, signal: AbortSignal, timeoutMs: number) {
    try {
      return await fetchBounded(`${this.#credentials.url}${path}`, { method: 'POST', headers, body, signal }, {
        provider: PROVIDER, timeoutMs, maxBytes: MAX_BYTES, fetcher: this.#fetcher, allowHttpError: true,
      });
    } catch (error) {
      // fetchBounded keeps the request on a network failure; it holds the keys or the token.
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}
