const ORIGIN = 'https://tracking.ozon.ru';
const API_PATH = '/p-api/ozon-track-bff/tracking/';
const POSTING = /^(?:\d{8}|\d{10})-\d{4}-\d$/;

export function ozonBrowserRequest(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const numbers = url.searchParams.getAll('track');
  if (url.origin !== ORIGIN || url.username || url.password || url.pathname !== '/' || url.hash
    || [...url.searchParams.keys()].length !== 1 || numbers.length !== 1 || !POSTING.test(numbers[0])) return null;
  const posting = numbers[0], api = `${ORIGIN}${API_PATH}${posting}`;
  if (capture.captureResponses?.length !== 1 || capture.captureResponses[0] !== api) return null;
  return { posting, number: posting.replace(/-/g, ''), api };
}

/** Runs inside the page: the browser decodes compression while the stream stays byte-bounded. */
export async function readOzonPageApi({ path, timeoutMs, maxBytes }) {
  if (!/^\/p-api\/ozon-track-bff\/tracking\/(?:\d{8}|\d{10})-\d{4}-\d$/.test(path)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) {
    return { status: 0, body: null, error: 'invalid-request' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetch(path, { headers: { Accept: 'application/json, text/plain, */*',
      'x-o3-app-name': 'tpl-ui-ozon-track' }, credentials: 'same-origin', signal: controller.signal });
    const actual = new URL(response.url, location.origin);
    if (actual.origin !== location.origin || actual.pathname !== path) {
      await response.body?.cancel();
      return { status: response.status, body: null, error: 'different-response' };
    }
    const headers = { 'content-type': response.headers.get('content-type') ?? '' };
    const retry = response.headers.get('retry-after');
    if (retry && retry.length <= 100) headers['retry-after'] = retry;
    if (response.status !== 200 && response.status !== 404) {
      await response.body?.cancel();
      return { status: response.status, headers, body: null, error: null };
    }
    if (!response.body) return { status: response.status, headers, body: '', error: null };
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, body = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { status: response.status, headers, body: null, error: 'response-too-large', truncated: true };
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    let payload;
    try { payload = JSON.parse(body); } catch { /* A schema failure carries no raw page text. */ }
    if (/^\s*</.test(body) || payload?.challengeURL || payload?.incidentId) {
      return { status: response.status, headers, body: null, error: 'challenge' };
    }
    let projected = null;
    if (response.status === 404) {
      const message = `Постинг ${path.split('/').at(-1)} не найден`;
      projected = payload?.message === message ? { message } : {};
    } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      projected = { deliveryType: payload.deliveryType, deliveryDateBegin: payload.deliveryDateBegin,
        deliveryDateEnd: payload.deliveryDateEnd, items: Array.isArray(payload.items)
          ? payload.items.map(row => row && typeof row === 'object' ? { event: row.event, moment: row.moment } : null) : null };
    }
    return { status: response.status, headers, body: JSON.stringify(projected), error: null };
  } catch {
    return { status: 0, body: null, error: controller.signal.aborted ? 'deadline' : 'response-unreadable' };
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}

/** Let the official guest page initialize, then make its same-origin tracking GET once. */
export async function runOzonBrowser({ url, capture, handle, tier, maxTimeout, installPolicy, signal }) {
  const request = ozonBrowserRequest(url, capture);
  if (!request) return undefined;
  const started = Date.now(), entries = [];
  let context, page, timer, abort, observer, responseObserver, expired = false, observed = false, statusCode = 0;
  const remaining = () => {
    const left = Math.floor(maxTimeout - (Date.now() - started));
    if (expired || left < 1 || signal?.aborted) throw new Error('Ozon browser ended');
    return left;
  };
  const close = async target => {
    let closed = false, timeout;
    try {
      await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { timeout = setTimeout(resolve, 1500); })]);
    } finally {
      clearTimeout(timeout);
      if (!closed) handle.requestBrowserReplacement?.('Ozon context cleanup failed');
    }
  };
  const result = () => ({ tier, status: statusCode || entries.length ? 'success' : 'error', statusCode,
    durationMs: Date.now() - started, effectiveUrl: url, html: '', body: new Uint8Array(), cookies: [],
    capturedResponses: entries, ...(!statusCode && !entries.length ? { reason: 'Ozon guest tracking did not answer' } : {}) });
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1 || signal?.aborted) return result();
    return await Promise.race([
      (async () => {
        const created = await handle.browser.newContext();
        handle.noteTemporaryContext?.();
        if (expired) { await close(created); return result(); }
        context = created;
        page = await context.newPage();
        if (expired) return result();
        await installPolicy?.(page);
        observer = incoming => {
          if (expired || incoming.method() !== 'GET') return;
          if (incoming.url() === request.api) observed = true;
        };
        responseObserver = incoming => {
          if (expired || incoming.request().method() !== 'GET') return;
          let target;
          try { target = new URL(incoming.url()); } catch { return; }
          if (target.origin !== ORIGIN || target.pathname !== new URL(request.api).pathname) return;
          // Retain refusals and redirects, including an automatic verification retry.
          // Only the bounded in-page read below can attach a body.
          if (entries.length === 8) entries.shift();
          entries.push({ url: request.api, status: incoming.status(), headers: {}, body: null,
            error: 'response-unreadable', truncated: false, base64Encoded: false,
            trackingNumberSubmitted: request.number });
        };
        page.on('request', observer);
        page.on('response', responseObserver);
        const navigation = await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        // Ozon's ordinary page script can navigate from its initial response to this form.
        await page.locator('input[placeholder="Введите трек-номер отправления"]').waitFor({ state: 'visible', timeout: remaining() });
        statusCode = 200;
        const response = await page.evaluate(readOzonPageApi,
          { path: new URL(request.api).pathname, timeoutMs: remaining(), maxBytes: 1_000_000 });
        if (expired || !observed) return result();
        const latest = entries.at(-1);
        if (!response.status && latest) {
          latest.error = response.error;
          return result();
        }
        if (latest?.status === response.status) entries.pop();
        if (entries.length === 8) entries.shift();
        entries.push({ url: request.api, status: response.status, headers: response.headers ?? {},
          body: response.body, error: response.error, truncated: response.truncated === true,
          base64Encoded: false, trackingNumberSubmitted: request.number });
        return result();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('Ozon browser deadline')); }, maxTimeout);
        abort = () => { expired = true; reject(new Error('Ozon browser cancelled')); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } catch {
    return result();
  } finally {
    expired = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (page && observer) page.off('request', observer);
    if (page && responseObserver) page.off('response', responseObserver);
    if (context) await close(context);
  }
}
