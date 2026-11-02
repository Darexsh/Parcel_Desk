import { BudgetExceededError, ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSagawaNumber, parseSagawaWidget, PROVIDER, sagawaRejection } from './parser.js';

/** The widget refresh of the official app (jp.co.sagawa.SagawaOfficialApp). */
export const SAGAWA_WIDGET_API = 'https://www.e-service.sagawa-exp.co.jp/o/wtx/rest/apiOfficialApp/UpdateWidget';
/** The app's OkHttp client, sent instead of a host User-Agent that names a browser. */
export const SAGAWA_APP_USER_AGENT = 'okhttp/3.10.0';
const MAX_BYTES = 64_000;
// Shared guest-tracking application key, distributed with the maintainer's approval.
export const SAGAWA_APP_KEY = 'WTS';
const BROWSER = /^Mozilla\/5\.0 \((?!compatible;)/;
const timedOut = (reason: unknown) => reason instanceof DOMException && reason.name === 'TimeoutError';

/** The Akamai edge in front of the app API has refused browser User-Agents. */
export function sagawaUserAgent(configured: string | undefined): string {
  const host = userAgentOf(configured);
  return BROWSER.test(host) ? SAGAWA_APP_USER_AGENT : host;
}

function retryAfterMs(header: string | null): number | undefined {
  const value = header?.trim() ?? '';
  const delay = /^\d+$/.test(value) ? Number(value) * 1_000 : value ? Date.parse(value) - Date.now() : Number.NaN;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export async function readSagawaWidget(raw: string, options: {
  fetcher?: typeof fetch; userAgent?: string; signal: AbortSignal; timeoutMs: number;
}): Promise<CarrierResult> {
  const number = normalizeSagawaNumber(raw);
  const userAgent = sagawaUserAgent(options.userAgent);
  let response: Response;
  let bytes: Uint8Array;
  try {
    // callType 2 is the widget's periodic refresh, which also answers for delivered parcels.
    ({ response, bytes } = await fetchBounded(SAGAWA_WIDGET_API, { method: 'POST', signal: options.signal,
      body: JSON.stringify({ trackingNo: number, callType: '2' }), headers: { 'X-Api-Key': SAGAWA_APP_KEY,
        'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent } }, {
      provider: PROVIDER, maxBytes: MAX_BYTES, timeoutMs: options.timeoutMs, fetcher: options.fetcher, allowHttpError: true,
    }));
  } catch (error) {
    // A cancellation keeps the caller's reason; the step's deadline, or the request's own, is the budget running out.
    if (options.signal.aborted && !timedOut(options.signal.reason)) throw options.signal.reason;
    if (options.signal.aborted || (error instanceof Error && timedOut(error.cause))) throw new BudgetExceededError(PROVIDER, options.timeoutMs);
    if (error instanceof IndeterminateError) throw error;
    // Request diagnostics carry the application key; keep only the failure kind.
    throw new TransportError(PROVIDER, 'Sagawa Express app API request failed');
  }
  const { status } = response;
  // The edge answers a refused key or client with an HTML Access Denied page under 403.
  if (status === 401 || status === 403) throw new ChallengeError(PROVIDER, 'Sagawa Express refused the app request');
  if (status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')));
  if (status === 404 || status === 410) throw new TransportError(PROVIDER, 'Sagawa Express app API is unavailable', { status });
  // Error and maintenance pages keep their HTTP kind, so a 503 stays maintenance whatever its body.
  if (status !== 200 && status !== 422) throw new UpstreamHttpError(PROVIDER, status, retryAfterMs(response.headers.get('retry-after')));
  const body = decodeText(bytes).replace(/^\uFEFF/, '');
  // An HTML page in place of the widget's JSON answer is the edge, not the widget.
  if (/^\s*</.test(body) || /\bhtml\b/i.test(response.headers.get('content-type') ?? '')) {
    throw new ChallengeError(PROVIDER, 'Sagawa Express refused the app request');
  }
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new SchemaError(PROVIDER, 'Sagawa Express returned invalid widget JSON'); }
  return status === 422 ? sagawaRejection(payload) : parseSagawaWidget(payload, number);
}
