const ORIGIN = 'https://www.track123.com';
const PAGE = `${ORIGIN}/carriers/fedex`;
const QUERY = `${ORIGIN}/tk/api/v2/anonymous/track/query-track-nos`;
const POLL = `${ORIGIN}/tk/api/v2/anonymous/track/polling-waybill`;
const MAX_BODY = 2_000_000;

export function track123Number(raw, capture = {}) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const values = new URLSearchParams(url.hash.slice(1));
  const number = values.get('trawl-number');
  return url.origin === ORIGIN && url.pathname === '/carriers/fedex' && !url.search
    && !url.username && !url.password && [...values].length === 1
    && /^\d{12}$|^\d{15}$|^\d{20}$/.test(number ?? '')
    && capture.captureResponses?.length === 2 && capture.captureResponses[0] === QUERY
    && capture.captureResponses[1] === POLL ? number : null;
}

function containsNumber(value, number, depth = 0) {
  return value === number || (depth < 6 && value && typeof value === 'object'
    && Object.values(value).some(item => containsNumber(item, number, depth + 1)));
}

/** Only public history fields leave the browser; no verification or recipient data. */
export function track123Data(payload) {
  const pick = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) : null;
  return { code: typeof payload?.code === 'string' && /^[A-Z0-9_]{1,30}$/.test(payload.code) ? payload.code : null,
    data: { landWaybillLists: Array.isArray(payload?.data?.landWaybillLists)
      ? payload.data.landWaybillLists.slice(0, 10).map(value => ({
        ...pick(value, ['trackingNo', 'localProviderCode', 'querying', 'hasTrackingDetails']),
        localDetails: Array.isArray(value.localDetails) ? value.localDetails.slice(0, 1001).map(event =>
          pick(event, ['trackingNo', 'eventTime', 'eventTimeUtc', 'timezone', 'eventDetail', 'desc', 'address'])) : null,
      })) : null } };
}

/** Submit once; the page owns its guest verification and bounded history polling. */
export async function runTrack123Browser({ url, capture, handle, tier, maxTimeout, installPolicy }) {
  const number = track123Number(url, capture);
  if (!number) return undefined;
  const started = Date.now();
  let context, page, timer, wake, expired = false, submitted = false, statusCode = 200;
  let pending = 0, bytes = 0, lastActivity = started;
  const entries = [], requests = new WeakSet(), completed = new WeakSet();
  const remaining = () => Math.max(1, maxTimeout - (Date.now() - started));
  const changed = () => { lastActivity = Date.now(); wake?.(); };
  const result = () => ({ tier, status: 'success', statusCode, durationMs: Date.now() - started,
    // TRAWL requires a payload to return captures instead of escalating to another tier.
    effectiveUrl: PAGE, html: '<html><head><title>Track123 capture</title></head><body></body></html>', cookies: [], capturedResponses: [...entries, ...(pending > 0 ? [{ url: POLL, status: 0, headers: {}, body: null,
      error: 'track123-request-pending', trackingNumberSubmitted: number }] : [])].slice(-12) });
  const observe = request => {
    if (!submitted || request.method() !== 'POST' || ![QUERY, POLL].includes(request.url())) return;
    try {
      const body = request.postDataJSON();
      if (!containsNumber(body, number)) return;
      if (request.url() === QUERY && (body.logisticsCode !== 'fedex'
        || body.trackNos?.length !== 1 || body.trackNos[0] !== number)) return;
      requests.add(request); pending++; changed();
    } catch { /* Unbound requests never become history. */ }
  };
  const receive = async response => {
    if (!requests.has(response.request()) || completed.has(response.request()) || expired) return;
    completed.add(response.request());
    try {
      const entry = { url: response.url(), status: response.status(), headers: {}, body: null,
        truncated: false, base64Encoded: false, trackingNumberSubmitted: number };
      const length = Number(response.headers()['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY) entry.truncated = true;
      else if (entry.status === 200) {
        const body = await response.body();
        bytes += body.length;
        if (body.length > MAX_BODY || bytes > 2 * MAX_BODY) entry.truncated = true;
        else try { entry.body = JSON.stringify(track123Data(JSON.parse(body.toString('utf8')))); }
        catch { entry.error = 'track123-unreadable'; }
      }
      if (!expired) { entries.push(entry); if (entries.length > 12) entries.shift(); }
    } catch {
      if (!expired) entries.push({ url: response.url(), status: 0, headers: {}, body: null,
        truncated: true, error: 'track123-response-failed', trackingNumberSubmitted: number });
    } finally { pending--; changed(); }
  };
  try {
    return await Promise.race([ (async () => {
      context = await handle.browser.newContext();
      if (expired) { await context.close(); return result(); }
      handle.noteTemporaryContext?.();
      page = await context.newPage();
      await installPolicy?.(page);
      page.on('request', observe);
      page.on('response', receive);
      page.on('requestfailed', request => {
        if (requests.has(request) && !completed.has(request) && !expired) {
          completed.add(request);
          pending--; entries.push({ url: request.url(), status: 0, body: null, headers: {},
            error: 'track123-request-failed', trackingNumberSubmitted: number }); changed();
        }
      });
      const response = await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: remaining() });
      statusCode = response?.status() ?? 0;
      if (statusCode !== 200) return result();
      const field = page.locator('textarea[name="order-input"]');
      await field.fill(number, { timeout: remaining() });
      submitted = true;
      await page.locator('button.search-button').click({ timeout: remaining() });
      while (!expired) {
        const last = entries.at(-1);
        let payload;
        try { payload = JSON.parse(last?.body ?? 'null'); } catch { /* keep failure */ }
        const records = payload?.data?.landWaybillLists;
        const settled = last && (last.status !== 200 || !payload || payload.code !== '00000'
          || Array.isArray(records) && records.every(row => row.querying === false));
        if (settled && !pending && Date.now() - lastActivity >= 250) return result();
        let wait;
        try { await new Promise(resolve => { wake = resolve; wait = setTimeout(resolve, Math.min(250, remaining())); }); }
        finally { clearTimeout(wait); wake = undefined; }
      }
      return result();
    })(), new Promise(resolve => { timer = setTimeout(() => { expired = true; wake?.(); resolve(result()); }, Math.max(1, maxTimeout)); }) ]);
  } catch { return result(); }
  finally {
    expired = true; clearTimeout(timer); wake?.();
    if (context) {
      let cleanup;
      try { await Promise.race([context.close(), new Promise((_, reject) => {
        cleanup = setTimeout(() => reject(new Error('cleanup')), 1500);
      })]); } catch { handle.requestBrowserReplacement?.('Track123 context cleanup failed'); }
      finally { clearTimeout(cleanup); }
    }
  }
}
