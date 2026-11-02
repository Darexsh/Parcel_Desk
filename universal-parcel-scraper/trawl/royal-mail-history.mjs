// Opt-in to the public application's separate summary and events requests.
// Tokens and cookies stay inside the browser; only these two exact replies leave it.
// TrustArc's public "Decline all" preferences contain no identity or session token.
export const ROYAL_MAIL_OPT_OUT = {
  notice_preferences: '0:',
  notice_gdpr_prefs: '0::implied,eu',
  cmapi_cookie_privacy: 'permit 1 required',
  cmapi_gtm_bl: 'ga-ms-ua-ta-asp-bzi-sp-awct-cts-csm-img-flc-fls-mpm-mpr-m6d-tc-tdc',
};

const RETRYABLE_NETWORK_ERRORS = new Set([
  'NS_ERROR_NET_RESET', 'NS_ERROR_NET_TIMEOUT',
  'net::ERR_CONNECTION_RESET', 'net::ERR_HTTP2_PROTOCOL_ERROR', 'net::ERR_TIMED_OUT',
]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function attachRoyalMailHistoryCapture(page, rawUrl, options) {
  const target = new URL(rawUrl);
  if (target.origin !== 'https://www.royalmail.com' || target.pathname !== '/track-your-item' || target.search) return undefined;
  const number = /^#\/tracking-results\/([A-Z]{2}\d{9}GB)\/?$/.exec(target.hash)?.[1];
  if (!number) return undefined;
  const summaryUrl = `https://api-web.royalmail.com/mailpieces/microsummary/v1/summary/${number}`;
  const eventsUrl = `https://api-web.royalmail.com/mailpieces/v3/${number}/events`;
  const requested = options.captureResponses ?? [];
  if (requested.length !== 2 || !requested.includes(summaryUrl) || !requested.includes(eventsUrl)) return undefined;
  await page.context().addCookies(Object.entries(ROYAL_MAIL_OPT_OUT).map(([name, value]) => ({
    name, value, domain: '.royalmail.com', path: '/', secure: true, sameSite: 'Lax',
  })));
  const entries = [];
  const waiters = new Set();
  const refreshes = new Set();
  let accepting = true;
  let terminal = false;
  let summaryReady = false;
  let trackingRequested = false;
  let summaryRequested = false;
  let networkFailure = false;
  let retryableFailure = false;
  let eventsRequested = false;
  let count = 0;
  let bytes = 0;
  let submissions = 0;
  const notify = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  const finish = () => { terminal = true; notify(); };
  const matches = request => accepting && [summaryUrl, eventsUrl].includes(request.url()) && request.method() === 'GET';
  const onRequest = request => {
    if (!matches(request)) return;
    trackingRequested = true;
    if (request.url() === summaryUrl) summaryRequested = true;
    else eventsRequested = true;
  };
  const onRequestFailed = request => {
    if (!matches(request)) return;
    networkFailure = true;
    // A single ordinary form retry is allowed only for a failed summary transport.
    retryableFailure = request.url() === summaryUrl && !summaryReady && !eventsRequested
      && RETRYABLE_NETWORK_ERRORS.has(request.failure()?.errorText);
    notify();
    if (!retryableFailure) finish();
  };
  const onResponse = async response => {
    if (!matches(response.request()) || ++count > 20) { if (count > 20) finish(); return; }
    const headers = response.headers();
    const entry = { url: response.url(), status: response.status(), body: null,
      headers: headers['retry-after'] ? { 'retry-after': headers['retry-after'].slice(0, 100) } : {},
      truncated: false, base64Encoded: false };
    entries.push(entry);
    const length = headers['content-length'] === undefined ? 0 : Number(headers['content-length']);
    if (!(headers['content-type'] ?? '').includes('application/json') || !Number.isSafeInteger(length)
      || length < 0 || length > 2_000_000 || bytes >= 4_000_000) {
      entry.error = 'unsupported or oversized tracking response'; finish(); return;
    }
    try {
      const body = await response.body();
      if (!accepting) return;
      bytes += body.length;
      if (body.length > 2_000_000 || bytes > 4_000_000) {
        entry.truncated = true; entry.error = 'tracking response budget exceeded'; finish(); return;
      }
      entry.body = body.toString('utf8');
      const data = JSON.parse(entry.body);
      if (entry.status === 401 && !refreshes.has(entry.url) && Array.isArray(data?.errors)
        && data.errors.some(error => error?.errorCode === 'E0015' || error?.code === 'E0015')) {
        // The application's own callback obtains the replacement token.
        refreshes.add(entry.url); notify(); return;
      }
      if (entry.status !== 200) { finish(); return; }
      if (entry.url === eventsUrl) { finish(); return; }
      const piece = data?.mailPieces;
      if (!record(piece) || piece.mailPieceId !== number || !record(piece.summary)) { finish(); return; }
      summaryReady = true;
      networkFailure = false;
      notify();
    } catch {
      entry.error = 'tracking response could not be read'; finish();
    }
  };
  page.on('response', onResponse);
  page.on('request', onRequest);
  page.on('requestfailed', onRequestFailed);

  const awaitState = async (predicate, deadline) => {
    while (accepting && !predicate() && Date.now() < deadline) {
      let timer;
      let wake;
      try {
        await new Promise(resolve => {
          wake = resolve;
          waiters.add(resolve);
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        });
      } finally { clearTimeout(timer); waiters.delete(wake); }
    }
  };
  return {
    async prepare(budgetMs) {
      const deadline = Date.now() + Math.max(0, Math.min(budgetMs, 30_000));
      const timeout = () => {
        const remaining = deadline - Date.now();
        if (!accepting || remaining <= 0) throw new Error('Royal Mail form preparation timed out');
        return remaining;
      };
      timeout();
      if (summaryRequested && submissions === 0) submissions = 1;
      const submit = async () => {
        const input = page.locator('#barcode-input');
        await input.waitFor({ state: 'visible', timeout: timeout() });
        const decline = page.getByText('Decline all', { exact: true });
        await decline.waitFor({ state: 'visible', timeout: Math.min(timeout(), 3_000) }).catch(() => {});
        if (await decline.isVisible()) {
          const reloaded = page.waitForEvent('domcontentloaded', { timeout: Math.min(timeout(), 3_000) }).catch(() => {});
          await decline.evaluate(element => element.click());
          await reloaded;
          await input.waitFor({ state: 'visible', timeout: timeout() });
        }
        // A hash-route lookup can start while the consent banner settles.
        if (summaryRequested && submissions === 0 && !networkFailure) { submissions = 1; return; }
        await input.press('ControlOrMeta+A', { timeout: timeout() });
        await input.press('Backspace', { timeout: timeout() });
        await input.pressSequentially(number, { timeout: timeout(), delay: 30 });
        const button = page.locator('#submit:not(:disabled)');
        await button.waitFor({ state: 'visible', timeout: timeout() });
        if (submissions >= 2) throw new Error('Royal Mail form retry limit exceeded');
        submissions++;
        const clicked = await button.evaluate((element, expected) => {
          if (element.ownerDocument.querySelector('#barcode-input')?.value !== expected || element.disabled) return false;
          element.click();
          return true;
        }, number, { timeout: timeout() });
        if (!clicked) throw new Error('Royal Mail input was reset before submission');
      };
      if (!summaryRequested && !terminal) await submit();
      await awaitState(() => summaryReady || terminal || networkFailure, deadline);
      if (!summaryReady && !terminal && retryableFailure && submissions < 2) {
        networkFailure = false; retryableFailure = false;
        await submit();
        await awaitState(() => summaryReady || terminal || networkFailure, deadline);
      }
      if (!summaryReady || terminal || eventsRequested || deadline <= Date.now()) return;
      const details = page.locator('#btn-more-details');
      await details.waitFor({ state: 'visible', timeout: timeout() });
      // Normal handler runs the separate token callback. No challenge widget is clicked.
      await details.evaluate(element => element.click(), undefined, { timeout: timeout() });
      await awaitState(() => terminal || networkFailure, deadline);
    },
    hasResponse() { return terminal; },
    hasTrackingRequest() { return trackingRequested; },
    async settle(budgetMs) {
      const duration = Math.max(0, Math.min(budgetMs, options.settleTimeout ?? 15_000, 30_000));
      await awaitState(() => terminal || networkFailure, Date.now() + duration);
    },
    async drain() {
      accepting = false;
      notify();
      page.off('response', onResponse);
      page.off('request', onRequest);
      page.off('requestfailed', onRequestFailed);
      if (!entries.length) {
        throw new Error(networkFailure ? 'Royal Mail tracking request failed: network failure'
          : 'Royal Mail produced no tracking response after submission');
      }
      return { capturedResponses: entries.map(entry => ({ ...entry })) };
    },
  };
}
