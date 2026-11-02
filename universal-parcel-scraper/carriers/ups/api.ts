/**
 * UPS's official Track API, for a deployment that has its own app on
 * developer.ups.com. `UPS_CLIENT_ID` and `UPS_CLIENT_SECRET` are that app's
 * credentials; `UPS_API_URL` points them at UPS's Customer Integration
 * Environment instead of `https://onlinetools.ups.com`. They buy an OAuth
 * token (`POST /security/v1/oauth/token`, client credentials over Basic auth)
 * that reads `GET /api/track/v1/details/{number}`. Neither call is bot-gated.
 *
 * The credentials and the token never leave this file: failures carry no
 * request or response details, and a reply that does not parse is not kept.
 */
import { randomUUID } from 'node:crypto';
import {
  InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError,
} from '../../core/errors/index.js';
import { isValidUpsTrackingNumber } from '../../core/detection/ups.js';
import { cleanScalar, decodeText, fetchBounded } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

export const UPS_API_URL = 'https://onlinetools.ups.com';
const PROVIDER = 'UPS';
const MAX_BYTES = 10_000_000;
// Tokens last four hours; one is renewed this long before it ends.
const RENEW_MS = 60_000;
const DEFAULT_LIFETIME_S = 14_399;
const MAX_LIFETIME_S = 86_400;
// A token request is shared by the lookups waiting on it, so it runs on its own clock.
const TOKEN_TIMEOUT_MS = 10_000;
// Credentials UPS refused are not offered again for this long.
const REFUSAL_MEMORY_MS = 10 * 60_000;
// Names the calling application to UPS; `transId` names each request.
const TRANSACTION_SOURCE = 'universal-parcel-scraper';

export interface UPSApiCredentials {
  readonly id: string;
  readonly secret: string;
  /** The API's origin; empty when `UPS_API_URL` is not an https URL. */
  readonly url: string;
}

/** The deployment's API app, or null without both credentials. */
export function upsApiCredentials(env: Readonly<Record<string, string | undefined>>): UPSApiCredentials | null {
  const id = env.UPS_CLIENT_ID?.trim();
  const secret = env.UPS_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  const configured = env.UPS_API_URL?.trim();
  if (!configured) return { id, secret, url: UPS_API_URL };
  try {
    const url = new URL(configured);
    return { id, secret, url: url.protocol === 'https:' ? url.origin : '' };
  } catch {
    return { id, secret, url: '' };
  }
}

/** UPS refused the app's credentials, or the app lacks the Tracking API. */
function refused(status: number): TransportError {
  return new TransportError(PROVIDER, `UPS refused the API credentials (HTTP ${status})`, { status, reason: 'credentials_rejected' });
}

function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeText(bytes));
  } catch {
    throw new SchemaError(PROVIDER, 'UPS API returned a reply that is not JSON');
  }
}

/** The `code` and `message` of each error in UPS's error reply, or of each warning on its shipments. */
export function upsApiNotices(payload: unknown): { code: string; message: string }[] {
  const lists = [];
  if (isRecord(payload) && isRecord(payload.response)) lists.push(payload.response.errors);
  const shipments = isRecord(payload) && isRecord(payload.trackResponse) ? payload.trackResponse.shipment : null;
  if (Array.isArray(shipments)) lists.push(...shipments.filter(isRecord).map((shipment) => shipment.warnings));
  return lists.flatMap((list) => (Array.isArray(list) ? list.filter(isRecord) : [])).map((notice) => ({
    code: cleanScalar(notice.code, 16).toUpperCase(),
    message: cleanScalar(notice.message, 200),
  }));
}

/** UPS's answer that it has no tracking for the number: warning TW0001, "Tracking Information Not Found". */
export function upsApiNotFound(notices: readonly { code: string; message: string }[]): boolean {
  return notices.some((notice) => notice.code === 'TW0001' || /^tracking information not found\.?$/i.test(notice.message));
}

/** A reply other than 200, without the request that holds the credentials or the token. */
function httpFailure(response: Response, bytes: Uint8Array, number: string): Error {
  const { status } = response;
  if (status === 401 || status === 403) return refused(status);
  if (status === 429) {
    const header = response.headers.get('retry-after')?.trim() ?? '';
    const delay = /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : NaN;
    return new RateLimitedError(PROVIDER, Number.isFinite(delay) ? Math.max(0, delay) : undefined);
  }
  if (status >= 500) return new UpstreamHttpError(PROVIDER, status);
  let notices: { code: string; message: string }[] = [];
  try {
    notices = upsApiNotices(JSON.parse(decodeText(bytes)));
  } catch {
    // A reply that is not UPS's error JSON says nothing about the parcel.
  }
  if (status === 404 && upsApiNotFound(notices)) return new NotFoundError(PROVIDER);
  if (status === 400 && !isValidUpsTrackingNumber(number)) {
    return new InvalidInputError(PROVIDER, 'UPS rejected the number: its check digit does not match', { reason: 'wrong_number' });
  }
  const codes = notices.map((notice) => notice.code).filter((code) => /^[A-Z0-9]+$/.test(code));
  return new TransportError(PROVIDER, `UPS API returned HTTP ${status}${codes.length ? ` (${codes.join(', ')})` : ''}`, { status });
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

export class UPSApiClient {
  readonly #credentials: UPSApiCredentials;
  readonly #fetcher: typeof fetch | undefined;
  #token: { value: string; renewAt: number } | null = null;
  #issuing: Promise<string> | null = null;
  #refusal: { error: Error; until: number } | null = null;

  constructor(credentials: UPSApiCredentials, fetcher?: typeof fetch) {
    this.#credentials = credentials;
    this.#fetcher = fetcher;
  }

  /** The Track API's reply for one number. Its not-found and check-digit answers are thrown as such. */
  async track(number: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    if (!this.#credentials.url) throw new TransportError(PROVIDER, 'UPS_API_URL is not an https URL');
    const deadline = performance.now() + timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const query = new URLSearchParams({ locale: 'en_US', returnSignature: 'false', returnMilestones: 'false', returnPOD: 'false' });
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.#accessToken(signal);
      const { response, bytes } = await this.#request(`/api/track/v1/details/${encodeURIComponent(number)}?${query}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          transId: randomUUID().replaceAll('-', ''),
          transactionSrc: TRANSACTION_SOURCE,
        },
      }, signal, left());
      if (response.status === 200) return json(bytes);
      // A token UPS no longer accepts is replaced once; refused again, the credentials are.
      if (response.status === 401 && attempt === 0) {
        if (this.#token?.value === token) this.#token = null;
        continue;
      }
      const failure = httpFailure(response, bytes, number);
      if (response.status === 401) {
        this.#token = null;
        this.#refusal = { error: failure, until: Date.now() + REFUSAL_MEMORY_MS };
      }
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
    const { id, secret } = this.#credentials;
    const { response, bytes } = await this.#request('/security/v1/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    }, AbortSignal.timeout(TOKEN_TIMEOUT_MS), TOKEN_TIMEOUT_MS);
    if (response.status !== 200) {
      // UPS answers credentials it does not know with 400 or 401, a blocked app with 403.
      if ([400, 401, 403].includes(response.status)) {
        const failure = refused(response.status);
        this.#refusal = { error: failure, until: Date.now() + REFUSAL_MEMORY_MS };
        throw failure;
      }
      throw httpFailure(response, new Uint8Array(), '');
    }
    const payload = json(bytes);
    const value = isRecord(payload) && typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
    if (!value) throw new SchemaError(PROVIDER, 'UPS API issued no access token');
    // UPS writes the lifetime as a string of seconds.
    const stated = isRecord(payload) ? Number(payload.expires_in) : NaN;
    const lifetime = Number.isFinite(stated) && stated > 0 ? Math.min(stated, MAX_LIFETIME_S) : DEFAULT_LIFETIME_S;
    this.#token = { value, renewAt: Date.now() + Math.max(0, lifetime * 1000 - RENEW_MS) };
    this.#refusal = null;
    return value;
  }

  async #request(path: string, init: RequestInit, signal: AbortSignal, timeoutMs: number) {
    try {
      return await fetchBounded(`${this.#credentials.url}${path}`, { ...init, signal }, {
        provider: PROVIDER, timeoutMs, maxBytes: MAX_BYTES, fetcher: this.#fetcher, allowHttpError: true,
      });
    } catch (error) {
      // fetchBounded keeps the request on a network failure; it holds the credentials or the token.
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}
