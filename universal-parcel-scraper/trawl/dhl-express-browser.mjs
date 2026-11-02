const ORIGIN = 'https://www.dhl.com';
const PAGE = '/global-en/home/tracking/tracking-parcel.html';
const API = `${ORIGIN}/utapi`;
const MAX_BODY = 1_000_000;

export function dhlExpressBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const number = url.searchParams.get('tracking-id') ?? '';
  const waybill = /^\d{10}$/.test(number) && Number(number.slice(0, 9)) % 7 === Number(number[9]);
  // An Express piece identifier, which the page resolves to its waybill.
  const piece = /^JD01\d{16}$/.test(number);
  if (url.origin !== ORIGIN || url.username || url.password || url.pathname !== PAGE || url.hash
    || [...url.searchParams].length !== 2 || url.searchParams.get('submit') !== '1' || !(waybill || piece)
    || capture.captureResponses?.length !== 1 || capture.captureResponses[0] !== API) return null;
  return number;
}

/** Let the public page finish its own SEC-CPT verification in one isolated context. */
export async function runDhlExpressBrowser({ url, handle, tier, maxTimeout, capture, installPolicy }) {
  const number = dhlExpressBrowserNumber(url, capture);
  if (!number) return undefined;
  const start = Date.now();
  let context, page, timer, onResponse;
  let expired = false;
  let accepting = true;
  let responseCount = 0;
  let totalBytes = 0;
  let statusCode = 0;
  const entries = [];
  const remaining = () => Math.max(1, Math.floor(maxTimeout - (Date.now() - start)));
  const close = async target => {
    let closed = false, cleanupTimer;
    try {
      await Promise.race([
        Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { cleanupTimer = setTimeout(resolve, 1500); }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
      if (!closed) handle.requestBrowserReplacement?.('DHL Express context cleanup failed');
    }
  };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start,
    // TRAWL requires a body or HTML to forward captures. Omit the rendered page,
    // whose recipient details are unrelated to the requested tracking evidence.
    effectiveUrl: url, html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: entries });
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1) throw new Error('No browser budget');
    return await Promise.race([
      (async () => {
        const created = await handle.browser.newContext();
        handle.noteTemporaryContext?.();
        if (expired) { await close(created); throw new Error('Browser context arrived too late'); }
        context = created;
        page = await context.newPage();
        if (expired) throw new Error('Browser page arrived too late');
        await installPolicy?.(page);
        if (expired) throw new Error('Browser setup exceeded its budget');
        let finish;
        const terminal = new Promise(resolve => { finish = resolve; });
        onResponse = response => {
          if (!accepting) return;
          let responseUrl;
          try { responseUrl = new URL(response.url()); } catch { return; }
          if (responseUrl.origin + responseUrl.pathname !== API || responseUrl.username || responseUrl.password
            || responseUrl.searchParams.getAll('trackingNumber').length !== 1
            || responseUrl.searchParams.get('trackingNumber') !== number || response.request().method() !== 'GET'
            || response.status() === 204) return;
          if (++responseCount > 10) {
            entries.at(-1).error = 'DHL tracking response limit exceeded'; accepting = false; finish(); return;
          }
          const headers = response.headers();
          const entry = { url: response.url(), status: response.status(), body: null,
            headers: Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key])
              .map(key => [key, headers[key].slice(0, 100)])), truncated: false, base64Encoded: false, error: null };
          entries.push(entry);
          // The page receives a 428, runs its own proof of work, verifies it,
          // then repeats tracking. Keep the status, never the challenge tokens.
          if (entry.status === 428) return;
          if (entry.status !== 200 && entry.status !== 404) { finish(); return; }
          const length = Number(headers['content-length'] ?? 0);
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || totalBytes >= 3 * MAX_BODY) {
            entry.truncated = true; finish(); return;
          }
          void response.body().then(body => {
            if (!accepting) return;
            totalBytes += body.length;
            if (body.length > MAX_BODY || totalBytes > 3 * MAX_BODY) entry.truncated = true;
            else entry.body = body.toString('utf8');
            finish();
          }).catch(() => {
            if (accepting) { entry.error = 'DHL tracking response could not be read'; finish(); }
          });
        };
        page.on('response', onResponse);
        const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        await terminal;
        return result();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Browser deadline')); }, maxTimeout);
      }),
    ]);
  } catch {
    // Preserve an observed challenge at the deadline for adapter classification.
    if (entries.length) return result();
    return { tier, status: 'error', durationMs: Date.now() - start,
      reason: expired ? 'DHL Express browser budget exhausted' : 'DHL Express browser retrieval failed' };
  } finally {
    accepting = false;
    expired = true;
    clearTimeout(timer);
    if (page && onResponse) page.off('response', onResponse);
    if (context) await close(context);
  }
}
