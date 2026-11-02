import { BudgetExceededError, ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeMagyarPostaNumber, parseMagyarPostaApp, PROVIDER } from './parser.js';

/** The guest tracking API of the Posta app (hu.posta.uzletimobil). */
export const MAGYAR_POSTA_APP_API = 'https://net.posta.hu/mpl/public/api/mobile/guest';
/** Adds a number with a reCAPTCHA token (POST), or reads the numbers an application id holds (GET). */
export const MAGYAR_POSTA_APP_TRACKING = `${MAGYAR_POSTA_APP_API}/package/tracking`;
/** The app's widget page, where the browser service records Google's refusal. */
export const MAGYAR_POSTA_APP_PAGE = 'https://net.posta.hu/';
// The key the public app sends with every guest request, the same for every install.
const APP_KEY = '4ec65760-cac5-4344-bee8-316962adf443'; // gitleaks:allow
const APPLICATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 1_000_000;
const timedOut = (reason: unknown) => reason instanceof DOMException && reason.name === 'TimeoutError';

export interface MagyarPostaAppOptions {
  fetcher?: typeof fetch;
  userAgent?: string;
  signal: AbortSignal;
  timeoutMs: number;
}

function retryAfterMs(header: string | null | undefined): number | undefined {
  const value = header?.trim() ?? '';
  return /^\d{1,5}$/.test(value) ? Number(value) * 1000 : undefined;
}

/** A refused or failed reply from the guest API; the reply of a number the app would not add is the adapter's to read. */
export function magyarPostaAppFailure(status: number, retryAfter?: string | null): Error | null {
  if (status === 429) return new RateLimitedError(PROVIDER, retryAfterMs(retryAfter));
  // A missing or stale key, or a refused token.
  if (status === 401 || status === 403) return new ChallengeError(PROVIDER, 'Magyar Posta\'s app refused the request');
  if (status === 404 || status === 410) return new TransportError(PROVIDER, 'Magyar Posta\'s app API is unavailable', { status });
  return status === 200 ? null : new UpstreamHttpError(PROVIDER, status, retryAfterMs(retryAfter));
}

/** The JSON reply, or a schema error for anything else. */
export function magyarPostaAppJson(body: string): unknown {
  try { return JSON.parse(body.replace(/^\uFEFF/, '')); } catch { throw new SchemaError(PROVIDER, 'Magyar Posta\'s app returned invalid JSON'); }
}

async function request(url: string, options: MagyarPostaAppOptions): Promise<unknown> {
  let response: Response;
  let bytes: Uint8Array;
  try {
    ({ response, bytes } = await fetchBounded(url, { method: 'GET', signal: options.signal, headers: {
      'User-Agent': userAgentOf(options.userAgent), 'X-Internal-Key': APP_KEY, preview: 'true', Accept: 'application/json, text/plain, */*',
    } }, { provider: PROVIDER, maxBytes: MAX_BYTES, timeoutMs: options.timeoutMs, fetcher: options.fetcher, allowHttpError: true }));
  } catch (error) {
    // A cancellation keeps the caller's reason; the step's deadline, or the request's own, is the budget running out.
    if (options.signal.aborted && !timedOut(options.signal.reason)) throw options.signal.reason;
    if (options.signal.aborted || (error instanceof Error && timedOut(error.cause))) throw new BudgetExceededError(PROVIDER, options.timeoutMs);
    if (error instanceof IndeterminateError) throw error;
    // Request diagnostics carry the app key; keep only the failure kind.
    throw new TransportError(PROVIDER, 'Magyar Posta\'s app request failed');
  }
  const failure = magyarPostaAppFailure(response.status, response.headers.get('retry-after'));
  if (failure) throw failure;
  return magyarPostaAppJson(decodeText(bytes));
}

const query = (entries: Record<string, string>) => new URLSearchParams({ platform: 'android', preferredLanguage: 'hu', ...entries });

/** A new application id, as the app generates on its first start. Numbers added under it stay readable without a token. */
export async function magyarPostaApplicationId(options: MagyarPostaAppOptions): Promise<string> {
  const reply = await request(`${MAGYAR_POSTA_APP_API}/generateApplicationId?${query({})}`, options);
  const id = typeof reply === 'object' && reply !== null ? (reply as { data?: unknown }).data : undefined;
  if (typeof id !== 'string' || !APPLICATION.test(id)) throw new SchemaError(PROVIDER, 'Magyar Posta\'s app returned no application id');
  return id;
}

/** The address the browser service adds a number from, under an application id. */
export function magyarPostaAppTrackingUrl(applicationId: string, raw: string): string {
  if (!APPLICATION.test(applicationId)) throw new TypeError('Invalid Magyar Posta application id');
  return `${MAGYAR_POSTA_APP_TRACKING}?${new URLSearchParams({ applicationId, packageId: normalizeMagyarPostaNumber(raw) })}`;
}

/**
 * The app's refresh of a number added under the application id, which needs
 * no token. Null when the id does not hold the number.
 */
export async function readMagyarPostaApp(raw: string, applicationId: string, options: MagyarPostaAppOptions): Promise<CarrierResult | null> {
  const number = normalizeMagyarPostaNumber(raw);
  if (!APPLICATION.test(applicationId)) throw new TypeError('Invalid Magyar Posta application id');
  const params = query({ applicationId });
  params.append('packages[0][packageId]', number);
  return parseMagyarPostaApp(await request(`${MAGYAR_POSTA_APP_TRACKING}?${params}`, options), number);
}
