import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { BudgetExceededError, CarrierError, ChallengeError, NotFoundError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARGUS, normalizeCargusNumber, parseCargus } from './parser.js';

/** The guest parcel trace of the Cargus app (com.cargus.cma). */
export const CARGUS_APP_API = 'https://cmacwabackend.azurewebsites.net/api/Awbs/ShortTrace';
const MAX_BYTES = 256_000;

/**
 * The app proves itself with a fresh random message encrypted under the key
 * it ships: AES-128-CBC, the ciphertext in `k` and its IV in `seed`.
 */
function appHeaders(key: string): Record<string, string> {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'hex'), iv);
  const message = randomUUID().replaceAll('-', '').slice(0, 12);
  return { k: Buffer.concat([cipher.update(message, 'utf8'), cipher.final()]).toString('base64'), seed: iv.toString('hex'), s: 'M' };
}

export async function readCargusApp(raw: string, options: {
  key: string; fetcher?: typeof fetch; userAgent?: string; signal: AbortSignal; timeoutMs: number;
}): Promise<CarrierResult> {
  const number = normalizeCargusNumber(raw);
  const deadline = performance.now() + options.timeoutMs;
  try {
    const url = new URL(CARGUS_APP_API);
    // English wording; the service also speaks Romanian.
    url.search = new URLSearchParams({ BarCode: number, lang: 'EN' }).toString();
    const { response, bytes } = await fetchBounded(url, {
      signal: options.signal,
      headers: { Accept: 'application/json', 'User-Agent': userAgentOf(options.userAgent), ...appHeaders(options.key) },
    }, { provider: CARGUS, maxBytes: MAX_BYTES, timeoutMs: Math.max(1, Math.floor(options.timeoutMs)), fetcher: options.fetcher,
      allowHttpStatuses: [400, 401, 403, 404, 410] });
    // A missing or wrong key gets a bare 400.
    if ([400, 401, 403].includes(response.status)) throw new ChallengeError(CARGUS, 'Cargus refused the tracking request');
    // An unknown route is a 404 from the host, not an unknown parcel.
    if ([404, 410].includes(response.status)) throw new TransportError(CARGUS, 'Cargus tracking service is unavailable', { status: response.status });
    const text = decodeText(bytes).replace(/^\uFEFF/, '');
    // An AWB the service does not know is an empty 204.
    if (response.status === 204 || !text.trim()) throw new NotFoundError(CARGUS, 'Cargus has no record of the AWB');
    if (/^\s*</.test(text) || /\bhtml\b/i.test(response.headers.get('content-type') ?? '')) {
      throw new ChallengeError(CARGUS, 'Cargus answered with a web page');
    }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new SchemaError(CARGUS, 'Cargus returned invalid tracking JSON'); }
    return parseCargus(payload, number);
  } catch (error) {
    // The step's deadline is the budget running out; a cancellation keeps the caller's reason.
    if (options.signal.aborted) {
      if (isTimeout(options.signal.reason)) throw new BudgetExceededError(CARGUS, options.timeoutMs);
      throw options.signal.reason;
    }
    if (error instanceof UpstreamNetworkError && isTimeout(error.cause) && performance.now() >= deadline - 1) {
      throw new BudgetExceededError(CARGUS, options.timeoutMs);
    }
    // Transport diagnostics carry the request headers; keep only the classification.
    if (error instanceof UpstreamHttpError) {
      throw new CarrierError(error.kind, CARGUS, `Cargus returned HTTP ${error.status}`, { status: error.status, retryAfterMs: error.retryAfterMs });
    }
    if (error instanceof UpstreamNetworkError || !(error instanceof CarrierError)) throw new TransportError(CARGUS, 'Cargus tracking request failed');
    if (error.cause === undefined) throw error;
    throw new CarrierError(error.kind, CARGUS, `Cargus tracking failed (${error.kind})`, {
      status: error.status, retryAfterMs: error.retryAfterMs, reason: error.reason,
    });
  }
}

const isTimeout = (reason: unknown) => reason instanceof DOMException && reason.name === 'TimeoutError';
