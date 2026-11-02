import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { parseCorreios } from './parser.js';

const PROVIDER = 'Correios';
export const CORREIOS_PAGE = 'https://rastreamento.correios.com.br/app/index.php';
const API = 'https://rastreamento.correios.com.br/app/resultado.php';
const MAX_BYTES = 1_000_000;

/**
 * The tracker's own search through the browser service: its share link fills in the number, and the
 * page searches once Cloudflare Turnstile has given it a token. The service keeps the one reply whose
 * request carried this number, the same JSON the direct query read.
 */
export async function correiosBrowser(trawl: TrawlClient, number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
  const timeoutMs = Math.floor(remainingMs - 2000);
  if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
  const page = await trawl.scrape({ url: `${CORREIOS_PAGE}?objetos=${number}`, skipHttp: true, maxTier: 3,
    captureResponses: [API], maxTimeout: timeoutMs, settleTimeout: timeoutMs },
  { provider: PROVIDER, timeoutMs, signal, requireSolved: false, captureWindow: 'last', maxBytes: 3 * MAX_BYTES });
  signal.throwIfAborted();
  const response = page.capturedResponses.filter(row => row.url === API && row.trackingNumberSubmitted === number).at(-1);
  if (!response) {
    if (page.statusCode >= 500) throw new UpstreamHttpError(PROVIDER, page.statusCode);
    throw new ChallengeError(PROVIDER, 'Correios gave no tracking reply after its Turnstile check');
  }
  if (response.status === 429) throw new RateLimitedError(PROVIDER);
  // The tracker answers 403 when it refuses the Turnstile token.
  if ([400, 401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Correios refused the Turnstile check');
  if (response.status >= 400) throw new UpstreamHttpError(PROVIDER, response.status);
  if (response.status !== 200 || response.error || response.truncated || response.base64Encoded || !response.body) {
    throw new TransportError(PROVIDER, 'Correios returned an incomplete browser response');
  }
  let payload: unknown;
  try { payload = JSON.parse(response.body); }
  catch (cause) { throw new SchemaError(PROVIDER, 'Correios returned invalid tracking JSON', { cause }); }
  return parseCorreios(payload, number);
}
