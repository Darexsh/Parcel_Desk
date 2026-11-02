const ORIGIN = 'https://tools.usps.com';
const OUTAGE = 'https://www.usps.com/root/global/server_responses/anyapp_outage_apology.htm';

export function uspsCaptureNumber(raw, options = {}) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const number = /^\/tracking\/(\d{20}|\d{22}|\d{26}|[A-Z]{2}\d{9}[A-Z]{2})$/.exec(url.pathname)?.[1];
  return url.origin === ORIGIN && !url.username && !url.password && !url.search && !url.hash && number
    && options.contentWaitForSelector === '#trackingNum' && options.captureResponses?.length === 1
    && options.captureResponses[0] === raw ? number : null;
}

/** USPS's verification wrapper can hide the tracking request's outage redirect. */
export function attachUspsTrackingCapture(page, url, options) {
  const number = uspsCaptureNumber(url, options);
  if (!number) return undefined;
  const entries = [];
  let active = true, prepared, finish;
  const terminal = new Promise(resolve => { finish = resolve; });
  const received = response => {
    if (!active || entries.length >= 3 || response.url() !== url || response.status() !== 302) return;
    const request = response.request();
    if (request.method() !== 'GET' || !['document', 'xhr', 'fetch'].includes(request.resourceType())
      || response.headers().location !== OUTAGE) return;
    try { if (request.frame() !== page.mainFrame()) return; } catch { return; }
    entries.push({ url, status: 302, headers: { location: OUTAGE }, body: null, error: null,
      truncated: false, base64Encoded: false, trackingNumberSubmitted: number });
    finish();
  };
  page.on('response', received);
  const prepare = budgetMs => prepared ??= (async () => {
    if (!active || entries.length || budgetMs <= 0) return;
    // Keep the ordinary readiness bound. An explicit outage is terminal even
    // when its cross-origin redirect leaves the verification page blank.
    await Promise.race([terminal, page.waitForSelector('#trackingNum',
      { state: 'visible', timeout: Math.min(10_000, budgetMs) }).catch(() => {})]);
  })();
  return {
    prepare,
    settle: prepare,
    hasResponse: () => entries.length > 0,
    // prepare already performed the same bounded visibility wait.
    contentOptions: capture => prepared ? { ...capture, contentWaitForSelector: undefined } : capture,
    async drain() {
      active = false;
      finish();
      page.off('response', received);
      return { capturedResponses: entries };
    },
  };
}
