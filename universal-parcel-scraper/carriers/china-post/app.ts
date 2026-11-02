import { createHmac } from 'node:crypto';
import type { LookupBudget } from '../../core/adapter/index.js';
import { BudgetExceededError, CarrierError, ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { decodeText, fetchBounded } from '../../core/transport/index.js';
import { checkChinaPostGate, PROVIDER } from './parser.js';

/** The EMS app's (com.kun.ems) guest mail-trace API. */
export const CHINA_POST_APP_API = 'https://ec.ems.com.cn/ect-web';
export const CHINA_POST_CHECK_PATH = '/mail/getGisTraces/checkMail';
export const CHINA_POST_TRACE_PATH = '/mail/getGisTraces/subjection/v3';
const APP_VERSION = '6.2.5';
const MAX_BYTES = 1_000_000;
const MAX_REQUEST_MS = 10_000;
// Shared guest-tracking application key, distributed with the maintainer's approval.
const APPLICATION_KEY = 'wsQ565RjVK0fGQfvxetzJJ8uRQ3mUwp6';

/** The app's USER-SIGN header: HMAC-SHA256 over the path after /ect-web and the JSON body. */
export function chinaPostSignature(path: string, body: string, key: string): string {
  return createHmac('sha256', key).update(`${path}?json=${body}`, 'utf8').digest('base64');
}

export interface ChinaPostAppOptions {
  fetcher?: typeof fetch;
  userAgent: string;
  /** The lookup's budget; its signal joins the caller's. */
  budget: LookupBudget;
  callerSignal?: AbortSignal;
}

function json(bytes: Uint8Array): unknown {
  const text = decodeText(bytes).replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch {
    // A page or a page fragment (a script redirect, a bare body) in place of
    // JSON is a gate, not tracking data.
    if (/<(?:!doctype\s+html|html|head|body|script)\b/i.test(text)) throw new ChallengeError(PROVIDER, 'China Post answered with a web page instead of tracking data');
    throw new SchemaError(PROVIDER, 'China Post returned invalid tracking JSON');
  }
}

async function post(path: string, body: string, options: ChinaPostAppOptions): Promise<unknown> {
  // When the budget ends before the request's own limit, the budget's signal
  // must abort first so the lookup reports the spent budget, not a timeout.
  const remainingMs = options.budget.remainingMs();
  const { response, bytes } = await fetchBounded(`${CHINA_POST_APP_API}${path}`, { method: 'POST', signal: options.budget.signal, body, headers: {
    'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', 'USER-CHANNEL': 'APP', 'APP-VERSION': APP_VERSION,
    'USER-SIGN': chinaPostSignature(path, body, APPLICATION_KEY), 'User-Agent': options.userAgent,
  } }, { provider: PROVIDER, maxBytes: MAX_BYTES, timeoutMs: remainingMs > MAX_REQUEST_MS ? MAX_REQUEST_MS : remainingMs + 1_000,
    fetcher: options.fetcher, allowHttpStatuses: [401, 403, 404, 405, 410] });
  if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'China Post refused the tracking request');
  if ([404, 410].includes(response.status)) throw new TransportError(PROVIDER, 'China Post tracking API is unavailable', { status: response.status });
  // The ems.com.cn web application firewall blocks with an HTML page and HTTP 405.
  if (response.status === 405) {
    if (/访问被阻断|应用防火墙/.test(decodeText(bytes))) throw new ChallengeError(PROVIDER, 'China Post\'s firewall blocked the tracking request');
    throw new UpstreamHttpError(PROVIDER, response.status);
  }
  return json(bytes);
}

/**
 * The app's two calls: the check step opens the trace for this number (the
 * trace answers 600001 without it), then the trace returns the mail record.
 */
export async function readChinaPostTraces(number: string, options: ChinaPostAppOptions): Promise<unknown> {
  const body = JSON.stringify({ mailNo: number });
  try {
    checkChinaPostGate(await post(CHINA_POST_CHECK_PATH, body, options));
    // Node's fetch frees the check's connection a turn after its body ends.
    // Sent at once, the trace opens a second TLS connection to China, which
    // costs most of a second.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return await post(CHINA_POST_TRACE_PATH, body, options);
  } catch (error) {
    options.callerSignal?.throwIfAborted();
    const { budget } = options;
    if (budget.signal.aborted || performance.now() >= budget.deadline) throw new BudgetExceededError(PROVIDER, budget.budgetMs);
    // Transport diagnostics hold the signed headers and the reply body. Keep
    // the failure's meaning without forwarding them or their causes.
    if (error instanceof UpstreamHttpError || error instanceof UpstreamNetworkError) {
      throw new CarrierError(error.kind, PROVIDER, `China Post tracking failed (${error.kind})`, {
        status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
      });
    }
    if (error instanceof CarrierError) throw error;
    throw new TransportError(PROVIDER, 'China Post tracking request failed');
  }
}
