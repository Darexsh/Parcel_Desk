const ORIGIN = 'https://ext-web.ltl-xpo.com';
const PAGE = '/public-app/shipments';
const API = 'https://api.ltl.xpo.com/public-tracking/1.0/shipments/';
const MAX_BODY = 1_000_000;

export function xpoBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const number = url.searchParams.get('referenceNumber') ?? '';
  if (url.origin !== ORIGIN || url.username || url.password || url.pathname !== PAGE || url.hash
    || [...url.searchParams].length !== 1 || !/^\d{9}$/.test(number)
    || Number(number.slice(0, 8)) % 7 !== Number(number[8])
    || capture.captureResponses?.length !== 1 || capture.captureResponses[0] !== `${API}${number}/tracking`) return null;
  return number;
}

/** Capture XPO's own guest tracking request after its visible checkbox verification. */
export async function runXpoBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, solveCaptcha }) {
  const number = xpoBrowserNumber(url, capture);
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
      if (!closed) handle.requestBrowserReplacement?.('XPO context cleanup failed');
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
          if (response.url() !== `${API}${number}/tracking` || responseUrl.username || responseUrl.password
            || response.request().method() !== 'GET'
            || response.status() === 204) return;
          if (++responseCount > 10) {
            entries.at(-1).error = 'XPO tracking response limit exceeded'; accepting = false; finish(); return;
          }
          const headers = response.headers();
          const entry = { url: response.url(), status: response.status(), body: null,
            headers: Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key])
              .map(key => [key, headers[key].slice(0, 100)])), truncated: false, base64Encoded: false, error: null };
          entries.push(entry);
          // Keep only the status of an intermediate verification response.
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
            if (accepting) { entry.error = 'XPO tracking response could not be read'; finish(); }
          });
        };
        page.on('response', onResponse);
        const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        if (solveCaptcha && remaining() > 5000 && !entries.some(entry => entry.status === 200)) {
          await page.locator('iframe[src*="recaptcha"][src*="anchor"][src*="size=normal"]').waitFor({ state: 'attached', timeout: Math.min(8000, remaining()) });
          // XPO also loads an invisible V3 widget. Scope the existing solver to
          // the visible checkbox and the challenge frame with the same key.
          const frames = page.frames().map(frame => frame.url());
          const anchor = frames.find(frame => frame.includes('/anchor?') && frame.includes('size=normal'));
          const key = anchor ? new URL(anchor).searchParams.get('k') : null;
          if (key && /^[A-Za-z0-9_-]{20,100}$/.test(key)) {
            const select = selector => selector.includes('anchor')
              ? 'iframe[src*="recaptcha"][src*="anchor"][src*="size=normal"]'
              : selector.includes('bframe') ? `iframe[src*="recaptcha"][src*="bframe"][src*="k=${key}"]` : selector;
            const scoped = new Proxy(page, { get(target, property) {
              if (property === 'frameLocator') return selector => target.frameLocator(select(selector));
              if (property === 'waitForSelector') return (selector, options) => target.waitForSelector(select(selector), options);
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            } });
            await Promise.race([solveCaptcha(scoped, Math.min(30000, remaining())), terminal]);
          }
        }
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
      reason: expired ? 'XPO browser budget exhausted' : 'XPO browser retrieval failed' };
  } finally {
    accepting = false;
    expired = true;
    clearTimeout(timer);
    if (page && onResponse) page.off('response', onResponse);
    if (context) await close(context);
  }
}
