import type { BrowserContext, Page, Request, Response as BrowserResponse } from 'playwright-core';
import { carrierErrorKind, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { isRecord } from '../../core/types.js';
import { OLD_DOMINION_API, OLD_DOMINION_ORIGIN, OLD_DOMINION_TRACE_PATH, oldDominionPro, oldDominionTraceUrl,
  parseOldDominionReply, type OldDominionReply } from './parser.js';

const PROVIDER = 'Old Dominion';
const MAX_BYTES = 1_000_000;
/** Kept back from the lookup's budget so the browser context closes inside it. */
export const CLEANUP_MS = 1_500;
/** The page answers in seconds; a page that never loads or never calls must not hold the shared browser. */
export const NAVIGATION_LIMIT_MS = 15_000;
export const CAPTURE_LIMIT_MS = 25_000;

/**
 * Whether a request is the trace page's own tracking call. A call for anything
 * but exactly this PRO means the page changed, and fails the lookup.
 */
function traceCall(request: Request, page: Page, pro: string): boolean {
  if (request.url() !== OLD_DOMINION_API || request.method() !== 'POST' || request.frame() !== page.mainFrame()) return false;
  let body: unknown;
  try { body = request.postDataJSON(); } catch { body = undefined; }
  if (!isRecord(body) || body.referenceType !== 'PRO' || !Array.isArray(body.referenceNumbers)
    || body.referenceNumbers.length !== 1 || body.referenceNumbers[0] !== pro) {
    throw new SchemaError(PROVIDER, 'The trace page submitted a different reference');
  }
  return true;
}

/**
 * Observes the page's tracking call for one PRO while `trigger` loads the
 * page. The page obtains its own reCAPTCHA token for that call; the token and
 * the request headers stay in the browser. The first reply is the answer: the
 * page neither repeats nor verifies the call.
 */
export async function captureOldDominionReply(page: Page, pro: string, signal: AbortSignal, timeoutMs: number,
  trigger: () => Promise<void>): Promise<OldDominionReply> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))]);
  deadline.throwIfAborted();
  let active = true;
  let answered = false;
  let resolve!: (reply: OldDominionReply) => void;
  let reject!: (error: unknown) => void;
  const reply = new Promise<OldDominionReply>((yes, no) => { resolve = yes; reject = no; });
  void reply.catch(() => {});
  const fail = (error: unknown) => { if (active) reject(error); };
  const received = (response: BrowserResponse) => {
    if (!active || answered) return;
    void (async () => {
      if (!traceCall(response.request(), page, pro)) return;
      answered = true;
      const headers = response.headers();
      const length = headers['content-length'] === undefined ? 0 : Number(headers['content-length']);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES) {
        throw new SchemaError(PROVIDER, 'Old Dominion returned excessive tracking data');
      }
      const body = await response.body();
      if (body.byteLength > MAX_BYTES) throw new SchemaError(PROVIDER, 'Old Dominion returned excessive tracking data');
      if (active) resolve({ status: response.status(), contentType: headers['content-type'] ?? '',
        retryAfter: headers['retry-after'] ?? null, body: body.toString('utf8') });
    })().catch(error => fail(carrierErrorKind(error) ? error : new TransportError(PROVIDER, 'Old Dominion tracking reply could not be read')));
  };
  const failed = (request: Request) => {
    try {
      if (traceCall(request, page, pro)) fail(new TransportError(PROVIDER, 'Old Dominion tracking request failed'));
    } catch (error) { fail(error); }
  };
  const aborted = () => fail(signal.aborted ? signal.reason : new TransportError(PROVIDER, 'Old Dominion trace page sent no tracking request in time'));
  page.on('response', received);
  page.on('requestfailed', failed);
  deadline.addEventListener('abort', aborted, { once: true });
  try {
    deadline.throwIfAborted();
    await Promise.race([trigger(), reply.then(() => {})]);
    return await reply;
  } finally {
    active = false;
    page.off('response', received);
    page.off('requestfailed', failed);
    deadline.removeEventListener('abort', aborted);
  }
}

function pageFailure(status: number, retryAfter: string | undefined): Error | null {
  if (status === 200) return null;
  if (status === 429) return new RateLimitedError(PROVIDER, retryAfter && /^\d{1,6}$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined);
  if ([401, 403].includes(status)) return new ChallengeError(PROVIDER);
  if ([404, 410].includes(status)) return new TransportError(PROVIDER, 'Old Dominion trace page is unavailable', { status });
  return new UpstreamHttpError(PROVIDER, status);
}

/** Closes a context without letting a hung close outlast the time kept for it. */
async function close(context: BrowserContext): Promise<void> {
  const limit = AbortSignal.timeout(CLEANUP_MS);
  let done!: () => void;
  const expired = new Promise<void>(resolve => { done = resolve; });
  limit.addEventListener('abort', () => done(), { once: true });
  await Promise.race([context.close().catch(() => {}), expired]);
}

/**
 * Opens the public trace page for the PRO in a fresh context and reads the
 * tracking reply the page requests for itself.
 */
export function fetchOldDominionInBrowser(number: string, executablePath: string, signal: AbortSignal,
  timeoutMs: number): Promise<CarrierResult> {
  return withLocalBrowser({ provider: PROVIDER, executablePath, signal, timeoutMs,
    args: ['--disable-blink-features=AutomationControlled'] }, async ({ browser, signal: session, remainingMs }) => {
    let context: BrowserContext | undefined;
    try {
      const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
        : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
      const major = browser.version().split('.')[0];
      context = await browser.newContext({ locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block',
        userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` });
      session.throwIfAborted();
      const page = await context.newPage();
      session.throwIfAborted();
      const window = () => Math.max(1, remainingMs() - CLEANUP_MS);
      const reply = await captureOldDominionReply(page, oldDominionPro(number), session, Math.min(CAPTURE_LIMIT_MS, window()), async () => {
        // The page submits a PRO given in its address on load.
        const response = await page.goto(oldDominionTraceUrl(number), { waitUntil: 'domcontentloaded',
          timeout: Math.min(NAVIGATION_LIMIT_MS, window()) });
        session.throwIfAborted();
        if (!response) throw new TransportError(PROVIDER, 'Old Dominion trace page is unavailable');
        const failure = pageFailure(response.status(), response.headers()['retry-after']);
        if (failure) throw failure;
        const landed = new URL(page.url());
        if (landed.origin !== OLD_DOMINION_ORIGIN || landed.pathname !== OLD_DOMINION_TRACE_PATH) {
          throw new SchemaError(PROVIDER, 'Old Dominion redirected away from its trace page');
        }
      });
      session.throwIfAborted();
      return parseOldDominionReply(reply, number);
    } catch (error) {
      session.throwIfAborted();
      if (carrierErrorKind(error)) throw error;
      // Browser diagnostics can quote request URLs, headers or page content.
      throw new TransportError(PROVIDER, 'Old Dominion browser tracking failed');
    } finally {
      if (context) await close(context);
    }
  });
}
