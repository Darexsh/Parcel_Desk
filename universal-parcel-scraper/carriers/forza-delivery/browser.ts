import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { withRemoteBrowser } from '../../core/transport/localBrowser.js';
import { FORZA_MAX_BYTES, parseForzaReply, PROVIDER } from './parser.js';
import { FORZA_API, FORZA_ORIGIN, forzaLookupBody } from './request.js';

interface BrowserReply { url: string; status: number; retryAfter: string | null; body: string | null; truncated: boolean }

/** Runs in the official origin, with one bounded, nonredirecting guest request. */
export async function forzaGuestLookup({ body, timeoutMs, maxBytes }: { body: string; timeoutMs: number; maxBytes: number }): Promise<BrowserReply> {
  const response = await fetch('/fd2/Home.aspx/API', { method: 'POST', credentials: 'same-origin', redirect: 'error',
    headers: { 'Content-Type': 'application/json; charset=utf-8' }, body, signal: AbortSignal.timeout(timeoutMs) });
  const reply: BrowserReply = { url: response.url, status: response.status, retryAfter: response.headers.get('retry-after'), body: null, truncated: false };
  if (response.status !== 200 || Number(response.headers.get('content-length')) > maxBytes) {
    reply.truncated = response.status === 200;
    void response.body?.cancel().catch(() => {});
    return reply;
  }
  const reader = response.body?.getReader();
  if (!reader) return reply;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maxBytes) { reply.truncated = true; void reader.cancel().catch(() => {}); return reply; }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  reply.body = new TextDecoder().decode(bytes);
  return reply;
}

function checkStatus(status: number, retryAfter: string | null): void {
  if ([401, 403, 428].includes(status)) throw new ChallengeError(PROVIDER);
  if (status === 429) {
    const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
    throw new RateLimitedError(PROVIDER, Number.isFinite(delay) ? Math.max(0, delay) : undefined);
  }
  if ([404, 410].includes(status)) throw new TransportError(PROVIDER, 'Forza tracking endpoint is unavailable');
  if (status !== 200) throw new UpstreamHttpError(PROVIDER, status);
}

export function fetchForzaInBrowser(number: string, endpoint: string, signal: AbortSignal, timeoutMs: number) {
  return withRemoteBrowser({ provider: PROVIDER, endpoint, signal, timeoutMs }, async ({ browser, signal: stopped, remainingMs }) => {
    const left = () => {
      stopped.throwIfAborted();
      const remaining = remainingMs() - 1000;
      if (remaining < 1) throw new BudgetExceededError(PROVIDER, timeoutMs);
      return remaining;
    };
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    const body = forzaLookupBody(number);
    // The page's assets may load, but only our exact guest request may be posted.
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      const allowed = url.origin === FORZA_ORIGIN && !url.username && !url.password
        && (request.method() === 'GET' || (url.href === FORZA_API && request.method() === 'POST' && request.postData() === body));
      return allowed ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const navigation = await page.goto(`${FORZA_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: left() });
    if (!navigation) throw new TransportError(PROVIDER, 'Forza tracking page is unavailable');
    checkStatus(navigation.status(), navigation.headers()['retry-after'] ?? null);
    if (page.url() !== `${FORZA_ORIGIN}/`) throw new SchemaError(PROVIDER, 'Forza returned an unexpected tracking page');
    const reply = await page.evaluate(forzaGuestLookup, { body, timeoutMs: left(), maxBytes: FORZA_MAX_BYTES });
    stopped.throwIfAborted();
    if (reply.url !== FORZA_API) throw new SchemaError(PROVIDER, 'Forza returned an unrelated browser response');
    checkStatus(reply.status, reply.retryAfter);
    if (reply.truncated || reply.body === null || Buffer.byteLength(reply.body) > FORZA_MAX_BYTES) {
      throw new TransportError(PROVIDER, 'Forza returned an incomplete browser response');
    }
    // Closing the shared browser connection disposes this lookup's context on every exit.
    return parseForzaReply(reply.body, number);
  });
}
