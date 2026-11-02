import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, Locator, Page, Request, Response as BrowserResponse } from 'playwright-core';
import { carrierErrorKind, ChallengeError, IndeterminateError, MaintenanceError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withLocalBrowser, withRemoteBrowser } from '../../core/transport/localBrowser.js';
import { isRecord } from '../../core/types.js';
import { parseRoyalMailTrackingResponse, royalMailEventsApiUrl, royalMailSummaryApiUrl, royalMailTrackingUrl, royalMailUnconfirmed } from './parser.js';
import { royalMailVisionRecovery, type RoyalMailVisionContext } from './vision.js';

const PROVIDER = 'Royal Mail';
const ORIGIN = 'https://www.royalmail.com';
const MAX_BYTES = 2_000_000;
// The page keeps this frame hidden off-screen until hCaptcha wants a person to solve it.
const CAPTCHA_CHALLENGE = 'iframe[src*="hcaptcha.com"][src*="frame=challenge"]:visible';

export async function royalMailBrowserUserAgent(browser: Browser, remote: boolean): Promise<string> {
  const major = browser.version().split('.')[0];
  if (remote) {
    // Use the browser's OS, rather than the calling server's platform.
    const cdp = await browser.newBrowserCDPSession();
    try {
      const version = await cdp.send('Browser.getVersion');
      if (!/^Mozilla\/5\.0 [\x20-\x7E]{20,300}$/.test(version.userAgent)) throw new SchemaError(PROVIDER);
      return version.userAgent.replace(/HeadlessChrome\/[\d.]+/, `Chrome/${major}.0.0.0`);
    } finally { await cdp.detach(); }
  }
  const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
// The consent manager parks the address of a frame it blocks in `data-ta-src`.
const CAPTCHA_WITHHELD = 'iframe[data-hcaptcha-widget-id][data-ta-src]';

// While the tracking application is down, its address answers 200 with this
// page in place of the form.
const OUTAGE = /^\s*Service temporarily unavailable\s*$/i;

/** The tracking form, or a maintenance error as soon as the application shows its outage page instead. */
export async function royalMailTrackingForm(page: Page, timeoutMs: number): Promise<Locator> {
  const input = page.locator('#barcode-input');
  const outage = page.locator('h1').filter({ hasText: OUTAGE });
  await input.or(outage).first().waitFor({ state: 'visible', timeout: timeoutMs });
  if (await outage.first().isVisible()) throw new MaintenanceError(PROVIDER, 'Royal Mail tracking is temporarily unavailable');
  return input;
}

/** The destination the full-history reply adds to the summary, and nothing else from it. */
export function royalMailDestination(summary: unknown): { summary?: { destinationCountryCode: string } } {
  const code = isRecord(summary) ? summary.destinationCountryCode : undefined;
  return typeof code === 'string' && /^[A-Z]{2}$/.test(code) ? { summary: { destinationCountryCode: code } } : {};
}

/** Observe the application's request; its issued session stays in the browser. */
export async function captureRoyalMailReply(page: Page, url: string, number: string, phase: 'summary' | 'events',
  signal: AbortSignal, timeoutMs: number, trigger: () => Promise<void>,
  recover?: (signal: AbortSignal, remainingMs: number) => Promise<boolean>): Promise<Record<string, unknown>> {
  const expires = performance.now() + timeoutMs;
  const finished = new AbortController();
  const deadline = AbortSignal.any([signal, finished.signal, AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))]);
  deadline.throwIfAborted();
  let active = true;
  let refresh = false;
  let bytes = 0;
  let count = 0;
  let interactive = false;
  let resolve!: (piece: Record<string, unknown>) => void;
  let reject!: (error: unknown) => void;
  const reply = new Promise<Record<string, unknown>>((yes, no) => { resolve = yes; reject = no; });
  void reply.catch(() => {});
  const matches = (request: Request) => active && request.url() === url && request.method() === 'GET'
    && ['xhr', 'fetch'].includes(request.resourceType()) && request.frame() === page.mainFrame();
  // The edge refuses a session it scores as automated by resetting the request's
  // stream, while the page and its scripts load normally.
  const failed = (request: Request) => {
    if (!matches(request)) return;
    reject(request.failure()?.errorText === 'net::ERR_HTTP2_PROTOCOL_ERROR'
      ? new ChallengeError(PROVIDER, "Royal Mail's edge refused the tracking request")
      : new TransportError(PROVIDER, 'Royal Mail tracking request failed'));
  };
  const aborted = () => reject(signal.aborted ? signal.reason : interactive
    ? new ChallengeError(PROVIDER, 'Royal Mail verification did not yield tracking history')
    : new TransportError(PROVIDER, 'Royal Mail tracking response timed out'));
  const received = (response: BrowserResponse) => {
    if (!matches(response.request())) return;
    void (async () => {
      if (++count > 3) throw new SchemaError(PROVIDER, 'Royal Mail returned too many tracking replies');
      const status = response.status();
      const headers = response.headers();
      if (status === 429) {
        const retry = headers['retry-after'];
        throw new RateLimitedError(PROVIDER, retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : undefined);
      }
      if (status === 403) throw new ChallengeError(PROVIDER);
      if (status === 410) throw new TransportError(PROVIDER, 'Royal Mail tracking endpoint is unavailable');
      if (![200, 401, 404].includes(status)) throw new UpstreamHttpError(PROVIDER, status);
      const invalid = () => status === 401 ? new ChallengeError(PROVIDER)
        : status === 404 ? new TransportError(PROVIDER, 'Royal Mail tracking endpoint is unavailable') : new SchemaError(PROVIDER);
      const length = headers['content-length'] === undefined ? 0 : Number(headers['content-length']);
      if (!(headers['content-type'] ?? '').includes('application/json') || !Number.isSafeInteger(length)
        || length < 0 || length > MAX_BYTES) throw invalid();
      // The page already buffers its XHR. Bound both the declared and decoded
      // capture, plus repeated replies, before parsing anything for the result.
      const body = await response.body();
      if (!active) return;
      bytes += body.byteLength;
      if (body.byteLength > MAX_BYTES || bytes > 2 * MAX_BYTES) throw new SchemaError(PROVIDER);
      let data: unknown;
      try { data = JSON.parse(body.toString('utf8')) as unknown; } catch { throw invalid(); }
      if (!isRecord(data)) throw new SchemaError(PROVIDER);
      const errors = Array.isArray(data.errors) ? data.errors.filter(isRecord) : [];
      const denied = errors.some(error => error.errorCode === 'E0015' || error.code === 'E0015');
      if (status === 401 && denied && !refresh) { refresh = true; return; }
      if (status === 401 || denied) throw new ChallengeError(PROVIDER);
      const unconfirmed = royalMailUnconfirmed(errors);
      if (unconfirmed) throw unconfirmed;
      if (status === 404) throw new TransportError(PROVIDER, 'Royal Mail tracking endpoint is unavailable');
      if (status !== 200) throw new UpstreamHttpError(PROVIDER, status);
      if (data.errors !== undefined || data.error !== undefined || data.httpCode !== undefined) throw new IndeterminateError(PROVIDER);
      const piece = data.mailPieces;
      if (!isRecord(piece) || piece.mailPieceId !== number
        || (phase === 'summary' ? !isRecord(piece.summary) : !Array.isArray(piece.events) || piece.events.length > 500)) {
        throw new SchemaError(PROVIDER, 'Royal Mail did not return the requested parcel history');
      }
      // Drop proof, recipient and credential fields before merging the replies.
      resolve(phase === 'summary' ? { mailPieceId: number, summary: piece.summary, estimatedDelivery: piece.estimatedDelivery }
        : { mailPieceId: number, events: piece.events, ...royalMailDestination(piece.summary),
          ...(isRecord(piece.estimatedDelivery) ? { estimatedDelivery: { date: piece.estimatedDelivery.date } } : {}) });
    })().catch(error => { if (active) reject(carrierErrorKind(error) ? error : new TransportError(PROVIDER)); });
  };
  // A visible CAPTCHA waits for a person, and the page sends no request until it is solved.
  // Nor does it send one while the consent manager withholds the CAPTCHA.
  const watchChallenge = async () => {
    let recovered = false;
    while (active && !deadline.aborted) {
      if (await page.locator(CAPTCHA_CHALLENGE).count().catch(() => 0)) {
        interactive = true;
        if (!recovered) {
          if (recover && await recover(deadline, Math.max(0, expires - performance.now()))) recovered = true;
          else {
            if (active) reject(new ChallengeError(PROVIDER, 'Royal Mail asked for an interactive CAPTCHA'));
            return;
          }
        }
      }
      if (await page.locator(CAPTCHA_WITHHELD).count().catch(() => 0)) {
        if (active) reject(new SchemaError(PROVIDER, "Royal Mail's cookie consent withheld its CAPTCHA"));
        return;
      }
      await delay(500, undefined, { signal: deadline });
    }
  };
  page.on('response', received);
  page.on('requestfailed', failed);
  deadline.addEventListener('abort', aborted, { once: true });
  try {
    deadline.throwIfAborted();
    void watchChallenge().catch(error => {
      if (active) reject(carrierErrorKind(error) ? error : new ChallengeError(PROVIDER, 'Royal Mail verification did not complete'));
    });
    await Promise.race([trigger(), reply.then(() => {})]);
    return await reply;
  } finally {
    active = false;
    page.off('response', received);
    page.off('requestfailed', failed);
    deadline.removeEventListener('abort', aborted);
    finished.abort();
  }
}

export function fetchRoyalMailInBrowser(number: string, executablePath: string, signal: AbortSignal,
  timeoutMs: number, fullHistory: boolean, proxy: string | null = null, endpoint: string | null = null,
  vision?: RoyalMailVisionContext): Promise<CarrierResult> {
  const withBrowser = endpoint ? withRemoteBrowser : withLocalBrowser;
  return withBrowser({ provider: PROVIDER, executablePath, signal, timeoutMs, proxy, endpoint: endpoint ?? '',
    args: ['--disable-blink-features=AutomationControlled'] }, async ({ browser, signal: session, remainingMs }) => {
    let recovery: ReturnType<typeof royalMailVisionRecovery> | undefined;
    let historyReturned = false;
    try {
      const userAgent = await royalMailBrowserUserAgent(browser, endpoint !== null);
      const context = await browser.newContext({ locale: 'en-GB', acceptDownloads: false, serviceWorkers: 'block',
        userAgent });
      session.throwIfAborted();
      const page = await context.newPage();
      recovery = vision ? royalMailVisionRecovery(page, vision, session, remainingMs) : undefined;
      const timeout = () => Math.min(10_000, remainingMs());
      // The consent manager withholds hCaptcha's frame unless functional cookies
      // are allowed, and the tracking application sends nothing without its token.
      // Allow that category alone.
      const consent = async () => {
        const choose = page.locator('#truste-show-consent');
        await choose.waitFor({ state: 'visible', timeout: Math.min(3_000, remainingMs()) }).catch(() => {});
        session.throwIfAborted();
        if (!await choose.isVisible()) return;
        await choose.click({ timeout: timeout() });
        const dialog = page.getByRole('dialog', { name: /cookies/i });
        const functional = page.getByRole('checkbox', { name: 'Functional choice', exact: true });
        await dialog.locator('label').filter({ has: functional }).waitFor({ state: 'visible', timeout: timeout() });
        // The dialog saves once every category has a choice, so each switch is set explicitly.
        for (const toggle of await dialog.locator('label').filter({ has: page.getByRole('checkbox') }).all()) {
          const box = toggle.getByRole('checkbox');
          const allow = await toggle.filter({ has: functional }).count() > 0;
          if (await box.isChecked() === allow) await toggle.click({ timeout: timeout() });
          await toggle.click({ timeout: timeout() });
          if (await box.isChecked() !== allow) throw new SchemaError(PROVIDER, "Royal Mail's cookie preferences did not change");
        }
        // Saving reloads the document and would clear a number already typed.
        const reload = page.waitForEvent('domcontentloaded', { timeout: Math.min(4_000, remainingMs()) }).catch(() => {});
        await dialog.getByRole('button', { name: /^Saves? preferences$/i }).click({ timeout: timeout() });
        await reload;
        session.throwIfAborted();
      };
      // Ordinary navigation lets the public site initialize its anonymous edge
      // session before the tracking application starts.
      const response = await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: timeout() });
      session.throwIfAborted();
      if (!response) throw new TransportError(PROVIDER);
      if ([401, 403].includes(response.status())) throw new ChallengeError(PROVIDER);
      if ([404, 410].includes(response.status())) throw new TransportError(PROVIDER, 'Royal Mail tracking page is unavailable');
      if (response.status() !== 200) throw new UpstreamHttpError(PROVIDER, response.status());
      if (new URL(page.url()).origin !== ORIGIN) throw new SchemaError(PROVIDER);
      await consent();
      const link = page.locator('a').filter({ hasText: /^\s*Track your item\s*$/i }).first();
      await link.waitFor({ state: 'visible', timeout: timeout() });
      const href = await link.getAttribute('href');
      const target = new URL(href ?? '', ORIGIN);
      if (target.origin !== ORIGIN || target.pathname !== '/track-your-item') throw new SchemaError(PROVIDER);
      // The site's fixed navigation can cover this link. Follow its validated
      // public destination with the same browser context instead of waiting on an overlay.
      const trackingPage = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: timeout() });
      session.throwIfAborted();
      if (!trackingPage) throw new TransportError(PROVIDER);
      if ([401, 403].includes(trackingPage.status())) throw new ChallengeError(PROVIDER);
      if ([404, 410].includes(trackingPage.status())) throw new TransportError(PROVIDER, 'Royal Mail tracking page is unavailable');
      if (trackingPage.status() !== 200) throw new UpstreamHttpError(PROVIDER, trackingPage.status());
      const input = await royalMailTrackingForm(page, timeout());
      await consent();
      await input.waitFor({ state: 'visible', timeout: timeout() });
      const landed = new URL(page.url());
      if (landed.origin !== ORIGIN || landed.pathname !== '/track-your-item') throw new SchemaError(PROVIDER);
      await input.click({ timeout: timeout() });
      await input.pressSequentially(number, { delay: 80, timeout: timeout() });
      session.throwIfAborted();
      const summary = await captureRoyalMailReply(page, royalMailSummaryApiUrl(number), number, 'summary', session,
        Math.min(15_000, remainingMs()), async () => {
          if (await input.inputValue() !== number) throw new TransportError(PROVIDER, 'Royal Mail tracking form was reset');
          await page.locator('#submit:not(:disabled)').click({ timeout: timeout() });
        }, recovery?.solve);
      // The summary issues an API session. The application's details handler
      // uses it, or performs its own CAPTCHA refresh when the session expires.
      parseRoyalMailTrackingResponse({ mailPieces: summary }, number);
      const history = fullHistory ? await captureRoyalMailReply(page, royalMailEventsApiUrl(number), number, 'events', session,
        Math.min(15_000, remainingMs()), () => page.locator('#btn-more-details').click({ timeout: timeout() }), recovery?.solve) : undefined;
      session.throwIfAborted();
      const result = { ...parseRoyalMailTrackingResponse({ mailPieces: { ...summary, ...(history ?? {}),
        summary: { ...(summary.summary as Record<string, unknown>), ...(history?.summary as Record<string, unknown> | undefined) } } }, number),
        tracking_url: royalMailTrackingUrl(number), tracking_source: 'structured-web-response' };
      historyReturned = fullHistory && Array.isArray(history?.events) && history.events.length > 0;
      return result;
    } catch (error) {
      session.throwIfAborted();
      if (carrierErrorKind(error)) throw error;
      // Native browser diagnostics can contain request URLs or page contents.
      throw new TransportError(PROVIDER, 'Royal Mail browser tracking failed');
    } finally { recovery?.finish(historyReturned); }
  });
}
