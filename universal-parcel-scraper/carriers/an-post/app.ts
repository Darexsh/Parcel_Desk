import { BudgetExceededError, CarrierError, ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { AN_POST, isAnPostItemNumber, normalizeAnPostNumber, parseAnPostEvents, parseAnPostReference, parseAnPostSummary, type AnPostSummary } from './parser.js';

/** The guest tracking service of the An Post app (ie.anpost.app), behind Azure API Management. */
export const AN_POST_APP_API = 'https://apim-anpost-anpostmobileapp.anpost.com/TTServicePublic';
const MAX_BYTES = 256_000;
// Shared guest-tracking application key, distributed with the maintainer's approval.
const APPLICATION_KEY = '71cb89d5d5c74cf49942cee3447f30f9';

export async function readAnPostApp(raw: string, options: {
  fetcher?: typeof fetch; userAgent?: string; signal: AbortSignal; timeoutMs: number;
}): Promise<CarrierResult> {
  const number = normalizeAnPostNumber(raw);
  const deadline = performance.now() + options.timeoutMs;
  const post = async (operation: 'GetItemSummary' | 'GetCustItemSummary' | 'GetEvents', body: unknown): Promise<unknown> => {
    const left = Math.floor(deadline - performance.now());
    if (left < 1) throw new BudgetExceededError(AN_POST, options.timeoutMs);
    const { response, bytes } = await fetchBounded(`${AN_POST_APP_API}/${operation}`, {
      method: 'POST', signal: options.signal, body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json',
        'Ocp-Apim-Subscription-Key': APPLICATION_KEY, 'User-Agent': userAgentOf(options.userAgent) },
    }, { provider: AN_POST, maxBytes: MAX_BYTES, timeoutMs: left, fetcher: options.fetcher, allowHttpStatuses: [401, 403, 404, 410] });
    const text = decodeText(bytes).replace(/^\uFEFF/, '');
    const page = /^\s*</.test(text) || /\bhtml\b/i.test(response.headers.get('content-type') ?? '');
    // API Management answers a spent call quota with a JSON 403 and a retry
    // window, unlike the gateway firewall's HTML 403.
    if (response.status === 403 && !page && quotaSpent(response, text)) {
      throw new RateLimitedError(AN_POST, retryAfterMs(response.headers.get('retry-after')), 'An Post tracking quota is spent', { status: 403 });
    }
    // A missing or refused key is a JSON 401; the firewall's block is a 403.
    if ([401, 403].includes(response.status)) throw new ChallengeError(AN_POST, 'An Post refused the tracking request');
    // An unknown operation is a 404 from the gateway, not an unknown item.
    if ([404, 410].includes(response.status)) throw new TransportError(AN_POST, 'An Post tracking API is unavailable', { status: response.status });
    if (page) throw new ChallengeError(AN_POST, 'An Post answered with a web page');
    try { return JSON.parse(text) as unknown; } catch { throw new SchemaError(AN_POST, 'An Post returned invalid tracking JSON'); }
  };
  // Like the website, a number no item has is then asked as a sender's reference; an S10 number is an item's own.
  const summarize = async (): Promise<AnPostSummary> => {
    const asked = await post('GetItemSummary', { getItemSummary: { trackingItems: [number] } });
    try { return parseAnPostSummary(asked, number); } catch (error) {
      if (!(error instanceof NotFoundError) || isAnPostItemNumber(number)) throw error;
    }
    return parseAnPostReference(await post('GetCustItemSummary', { getCustItemSummary: { customerNumbers: [number] } }), number);
  };
  try {
    const summary = await summarize();
    // The history echoes no identity, and answers only the canonical number.
    return parseAnPostEvents(await post('GetEvents', { getEvents: { barcodeItem: summary.number } }), summary);
  } catch (error) {
    // The step's deadline is the budget running out; a cancellation keeps the caller's reason.
    if (options.signal.aborted) {
      if (isTimeout(options.signal.reason)) throw new BudgetExceededError(AN_POST, options.timeoutMs);
      throw options.signal.reason;
    }
    if (error instanceof UpstreamNetworkError && isTimeout(error.cause) && performance.now() >= deadline - 1) {
      throw new BudgetExceededError(AN_POST, options.timeoutMs);
    }
    // Transport diagnostics carry the key and the request body; keep only the classification.
    if (error instanceof UpstreamHttpError) {
      throw new CarrierError(error.kind, AN_POST, `An Post returned HTTP ${error.status}`, { status: error.status, retryAfterMs: error.retryAfterMs });
    }
    // A network error holds the request even when it has no cause.
    if (error instanceof UpstreamNetworkError || !(error instanceof CarrierError)) throw new TransportError(AN_POST, 'An Post tracking API request failed');
    if (error.cause === undefined) throw error;
    throw new CarrierError(error.kind, AN_POST, `An Post tracking failed (${error.kind})`, {
      status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
    });
  }
}

const isTimeout = (reason: unknown) => reason instanceof DOMException && reason.name === 'TimeoutError';

function quotaSpent(response: Response, text: string): boolean {
  if (response.headers.has('retry-after')) return true;
  try {
    const body: unknown = JSON.parse(text);
    return isRecord(body) && typeof body.message === 'string' && /\bquota\b/i.test(body.message);
  } catch { return false; }
}

/** Retry-After as seconds or an HTTP date. */
function retryAfterMs(header: string | null): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const delay = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
