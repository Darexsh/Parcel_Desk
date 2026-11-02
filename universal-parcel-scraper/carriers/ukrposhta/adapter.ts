import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import type { Page, Response as BrowserResponse } from 'playwright-core';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { recoverableByDefault, runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchBounded } from '../../core/transport/boundedFetch.js';
import { isRecord } from '../../core/types.js';
import { normalizeUkrposhtaNumber, parseUkrposhtaHistory, parseUkrposhtaOverview, parseUkrposhtaStatuses } from './parser.js';

export const UKRPOSHTA_API = 'https://track.ukrposhta.ua/php/track_new.php';
export const UKRPOSHTA_STATUS_API = 'https://www.ukrposhta.ua/status-tracking/0.0.1/statuses';
const MAX_BYTES = 1_000_000;
const DIRECT_TIMEOUT_MS = 10_000;
// The Android app's shared application bearer is deliberately distributed with this adapter.
const APPLICATION_BEARER = 'c3e02b53-3b1d-386e-b676-141ffa054c57';

async function readStatuses(number: string, signal: AbortSignal, timeoutMs: number, userAgent = 'Mozilla/5.0', fetcher?: typeof fetch) {
  const url = new URL(UKRPOSHTA_STATUS_API);
  url.searchParams.set('barcode', number);
  url.searchParams.set('lang', 'en');
  const { response, bytes } = await fetchBounded(url, { signal, headers: { Accept: 'application/json', Authorization: `Bearer ${APPLICATION_BEARER}`, 'User-Agent': userAgent } }, {
    provider: 'ukrposhta', timeoutMs, maxBytes: MAX_BYTES, allowHttpStatuses: [401, 403, 404, 429], fetcher,
  });
  // The refusal of a credential is an HTML page; it says nothing about the parcel.
  if ([401, 403].includes(response.status)) throw new ChallengeError('ukrposhta', 'Ukrposhta refused the tracking API credential');
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    throw new RateLimitedError('ukrposhta', retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : undefined);
  }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch (cause) { throw new SchemaError('ukrposhta', 'Ukrposhta returned invalid tracking JSON', { cause }); }
  if (response.status === 404) {
    // The reply names no barcode, as on the portal: tracking does not read it as absence.
    if (isRecord(payload) && payload.message === 'Shipment not found') throw new IndeterminateError('ukrposhta', undefined, { reason: 'status_api_not_found' });
    throw new TransportError('ukrposhta', 'Ukrposhta tracking endpoint is unavailable', { status: 404 });
  }
  return parseUkrposhtaStatuses(payload, number);
}

export function ukrposhtaTrackingUrl(number: string): string {
  const url = new URL('https://track.ukrposhta.ua/en/');
  url.searchParams.set('barcode', number);
  return url.toString();
}

function httpFailure(status: number, retryAfterMs?: number): Error {
  const cause = new UpstreamHttpError('ukrposhta', status, retryAfterMs);
  return [404, 410].includes(status)
    ? new TransportError('ukrposhta', 'Ukrposhta tracking endpoint is unavailable', { cause, status }) : cause;
}

function requestMatches(response: BrowserResponse, page: Page, number: string): boolean {
  const request = response.request();
  let body: unknown;
  try { body = request.postDataJSON(); } catch { return false; }
  return response.url() === UKRPOSHTA_API && request.method() === 'POST'
    && request.frame() === page.mainFrame() && isRecord(body) && body.barcode === number && body.lang === 'EN';
}

async function readLookup(page: Page, number: string, deadline: number, signal: AbortSignal, budgetMs: number): Promise<unknown> {
  signal.throwIfAborted();
  const remainingMs = Math.floor(deadline - performance.now());
  if (remainingMs <= 0) throw new BudgetExceededError('ukrposhta', budgetMs);
  const captured = page.waitForResponse(response => response.url() === UKRPOSHTA_API && response.request().method() === 'POST', { timeout: remainingMs });
  void captured.catch(() => {});
  const navigation = await page.goto(ukrposhtaTrackingUrl(number), { waitUntil: 'domcontentloaded', timeout: remainingMs });
  signal.throwIfAborted();
  if (!navigation) throw new TransportError('ukrposhta', 'Ukrposhta tracking page is unavailable');
  if ([401, 403].includes(navigation.status())) throw new ChallengeError('ukrposhta');
  if (navigation.status() !== 200) throw httpFailure(navigation.status());
  const response = await captured;
  signal.throwIfAborted();
  if (!requestMatches(response, page, number)) throw new SchemaError('ukrposhta', 'The browser submitted a different tracking request');
  if ([401, 403].includes(response.status())) throw new ChallengeError('ukrposhta');
  if (response.status() !== 200) {
    const retryAfter = response.headers()['retry-after'];
    const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : undefined;
    throw httpFailure(response.status(), retryAfterMs);
  }
  if (Number(response.headers()['content-length']) > MAX_BYTES) throw new SchemaError('ukrposhta', 'Ukrposhta returned excessive tracking data');
  const bytes = await response.body();
  signal.throwIfAborted();
  if (bytes.length > MAX_BYTES) throw new SchemaError('ukrposhta', 'Ukrposhta returned excessive tracking data');
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch (cause) { throw new SchemaError('ukrposhta', 'Ukrposhta returned invalid tracking JSON', { cause }); }
}

function localBrowser(number: string, executablePath: string, signal: AbortSignal, timeoutMs: number) {
  return withLocalBrowser({ provider: 'ukrposhta', executablePath, signal, timeoutMs }, async ({ browser, signal: session, remainingMs }) => {
    // Waiting for the browser and launching it already spent part of the budget.
    const deadline = performance.now() + remainingMs();
    const context = await browser.newContext({ locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block' });
    session.throwIfAborted();
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      const allowed = url.protocol === 'https:' && ['track.ukrposhta.ua', 'www.google.com', 'www.gstatic.com', 'www.recaptcha.net'].includes(url.hostname);
      await (allowed ? route.continue() : route.abort());
    });
    session.throwIfAborted();
    const page = await context.newPage();
    session.throwIfAborted();
    // The native repeated-reference batch supplies a barcode-bound latest
    // scan and total count. Its single-reference mode supplies full history.
    const overview = parseUkrposhtaOverview(await readLookup(page, `${number},${number}`, deadline, session, timeoutMs), number);
    return parseUkrposhtaHistory(await readLookup(page, number, deadline, session, timeoutMs), overview);
  });
}

export class UkrposhtaTracker {
  constructor(private readonly options: { executablePath?: string | null; userAgent?: string; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeUkrposhtaNumber(raw);
    const budgetMs = context.budgetMs ?? 45_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 60_000) throw new TypeError('Ukrposhta budget must be between 1 and 60000 ms');
    const executablePath = this.options.executablePath;
    return runSteps({ carrier: 'ukrposhta', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct',
        run: ({ signal, remainingMs }) => readStatuses(number, signal, Math.max(1, Math.min(DIRECT_TIMEOUT_MS, Math.floor(remainingMs))), this.options.userAgent, this.options.fetcher) },
      // The portal reads the same domestic records, so it cannot improve on an unknown
      // domestic barcode. An international reference still gets its second source.
      { id: 'browser', enabled: Boolean(executablePath),
        recovers: error => recoverableByDefault(error) && (!(error instanceof IndeterminateError) || isValidS10TrackingNumber(number)),
        run: ({ signal, remainingMs }) => localBrowser(number, executablePath!, signal, Math.max(1, Math.floor(remainingMs))) },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const options = { userAgent: environment.userAgent, fetcher: environment.fetcher, recorder: environment.recorder };
  const tracker = new UkrposhtaTracker({ ...options, executablePath: environment.browserExecutablePath });
  // Recognition is plain HTTP: the status API alone. A recognition budget can be
  // longer than the minute a lookup takes at most.
  const statusApi = new UkrposhtaTracker({ ...options, executablePath: null });
  return { id: 'ukrposhta', recordsSteps: true, steps: ['direct', 'browser'], track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(async () => {
      try {
        return await statusApi.fetch(number, { ...context, budgetMs: Math.min(context?.budgetMs ?? 45_000, 60_000) });
      } catch (error) {
        // The portal reads the same domestic records, so the status API's miss means Ukrposhta
        // does not know a domestic barcode now. The portal can still know an international reference.
        if (error instanceof IndeterminateError && error.reason === 'status_api_not_found'
          && !isValidS10TrackingNumber(normalizeUkrposhtaNumber(number))) throw new NotFoundError('ukrposhta');
        throw error;
      }
    }, () => accepted(() => normalizeUkrposhtaNumber(number))) };
};
