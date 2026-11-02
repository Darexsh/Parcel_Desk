import { ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { withRemoteBrowser } from '../../core/transport/localBrowser.js';
import { API, MAX_BYTES, ORIGIN, PROVIDER } from './parser.js';

interface Reply { url: string; status: number; retryAfter: string | null; body: string | null; truncated: boolean }
interface GuestResult { replies: Reply[]; verification?: { status: number; retryAfter: string | null } }

/** Runs in the carrier page. CAPTCHA credentials never leave this function. */
export async function wanbGuestFlow({ number, timeoutMs, maxBytes }: { number: string; timeoutMs: number; maxBytes: number }): Promise<GuestResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  const result: GuestResult = { replies: [] };
  const body = async (response: Response): Promise<{ body: string | null; truncated: boolean }> => {
    if (Number(response.headers.get('content-length')) > maxBytes) {
      void response.body?.cancel().catch(() => {}); return { body: null, truncated: true };
    }
    const reader = response.body?.getReader();
    if (!reader) return { body: '', truncated: false };
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > maxBytes) { void reader.cancel().catch(() => {}); return { body: null, truncated: true }; }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { body: new TextDecoder().decode(bytes), truncated: false };
  };
  const track = async () => {
    const response = await fetch('/TrackPoints/Track?TrackingNumber=' + encodeURIComponent(number), { credentials: 'same-origin', signal });
    const reply: Reply = { url: response.url, status: response.status, retryAfter: response.headers.get('retry-after'), body: null, truncated: false };
    result.replies.push(reply);
    if (response.status === 200) Object.assign(reply, await body(response));
    else void response.body?.cancel().catch(() => {});
    return reply;
  };
  const first = await track();
  if (first.status !== 200 || !first.body || first.truncated) return result;
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  let initial: unknown;
  try { initial = JSON.parse(first.body); } catch { return result; }
  if (!record(initial) || initial.Succeeded !== false || !record(initial.Error) || initial.Error.Code !== '0x110012') return result;
  const version = document.querySelector<HTMLInputElement>('#showCaptchaVersion')?.value;
  const key = document.querySelector<HTMLInputElement>('#sitekey')?.value;
  if (version !== 'V3' || !/^[A-Za-z0-9_-]{30,100}$/.test(key ?? '')) return result;
  const win = window as Window & { grecaptcha?: { ready(callback: () => void): void; execute(key: string, options: { action: string }): Promise<string> }; ___grecaptcha_cfg?: unknown };
  try {
    delete win.grecaptcha; delete win.___grecaptcha_cfg;
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://www.recaptcha.net/recaptcha/api.js?render=' + encodeURIComponent(key!);
      script.onload = () => resolve(); script.onerror = () => reject(new Error('Verification script unavailable'));
      document.head.appendChild(script);
    });
    await new Promise<void>(resolve => win.grecaptcha!.ready(resolve));
    const token = await win.grecaptcha!.execute(key!, { action: 'submit' });
    signal.throwIfAborted();
    const response = await fetch('/Home/CaptchaVerify?token=' + encodeURIComponent(token) + '&version=V3', { credentials: 'same-origin', signal });
    result.verification = { status: response.status, retryAfter: response.headers.get('retry-after') };
    if (response.status !== 200) { void response.body?.cancel().catch(() => {}); return result; }
    const verification = await body(response);
    if (!verification.truncated && verification.body) {
      const accepted: unknown = JSON.parse(verification.body);
      if (record(accepted) && accepted.Succeeded === true) await track();
    }
  } catch { /* The initial rejection remains authoritative when verification cannot complete. */ }
  return result;
}

function checkStatus(status: number, retryAfter: string | null): void {
  if ([401, 403, 428].includes(status)) throw new ChallengeError(PROVIDER);
  if (status === 429) {
    const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
    throw new RateLimitedError(PROVIDER, Number.isFinite(delay) ? Math.max(0, delay) : undefined);
  }
  if (status >= 500) throw new UpstreamHttpError(PROVIDER, status);
  if (status >= 400) throw new TransportError(PROVIDER, 'WanbExpress browser endpoint is unavailable', { status });
}

/** The final tracking reply for the requested parcel, after the page's verification; the adapter parses it. */
export function fetchWanbInBrowser(number: string, endpoint: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  return withRemoteBrowser({ provider: PROVIDER, endpoint, signal, timeoutMs }, async ({ browser, signal: stopped, remainingMs }) => {
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    const navigation = await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: Math.min(10_000, remainingMs()) });
    if (!navigation) throw new TransportError(PROVIDER, 'WanbExpress tracking page is unavailable');
    checkStatus(navigation.status(), navigation.headers()['retry-after'] ?? null);
    if (navigation.status() !== 200 || new URL(navigation.url()).origin !== ORIGIN) throw new SchemaError(PROVIDER, 'WanbExpress returned an unexpected tracking page');
    const result = await page.evaluate(wanbGuestFlow, { number, timeoutMs: remainingMs(), maxBytes: MAX_BYTES });
    stopped.throwIfAborted();
    if (result.verification) checkStatus(result.verification.status, result.verification.retryAfter);
    const reply = result.replies.at(-1);
    if (!reply || result.replies.length > 2 || reply.url !== `${API}?TrackingNumber=${encodeURIComponent(number)}`) throw new SchemaError(PROVIDER, 'WanbExpress returned an unrelated browser response');
    checkStatus(reply.status, reply.retryAfter);
    if (reply.truncated || reply.body === null) throw new TransportError(PROVIDER, 'WanbExpress returned an incomplete browser response');
    if (reply.status !== 200) throw new SchemaError(PROVIDER);
    try { return JSON.parse(reply.body) as unknown; } catch { throw new SchemaError(PROVIDER, 'WanbExpress returned invalid browser JSON'); }
  });
}
