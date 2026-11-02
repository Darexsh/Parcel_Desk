const ORIGIN = 'https://tracking.wanbexpress.com';
const API = `${ORIGIN}/TrackPoints/Track`;
const MAX_BODY = 1_000_000;

export function wanbBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const number = url.searchParams.get('trackingNumbers') ?? '';
  return url.origin === ORIGIN && !url.username && !url.password && url.pathname === '/' && !url.hash
    && [...url.searchParams].length === 1 && /^WNB[A-Z]{2}\d{10}YQ$/.test(number)
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === API ? number : null;
}

/** Submit the public form and retain its response after server-side verification. */
export async function runWanbBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, solveCaptcha, signal }) {
  const number = wanbBrowserNumber(url, capture);
  if (!number) return undefined;
  const start = Date.now();
  const remaining = () => Math.max(1, Math.floor(maxTimeout - (Date.now() - start)));
  let context, page, timer, observer, abort;
  let expired = false, accepting = true, statusCode = 0, totalBytes = 0, verificationSeen = false, verificationStatus = 0, completed = false;
  const entries = [], reads = [];
  let finishTracking;
  const trackingWait = () => new Promise(resolve => { finishTracking = () => { completed = true; resolve(); }; });
  let trackingReady = trackingWait();
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: entries });
  const close = async target => {
    let closed = false, cleanup;
    try { await Promise.race([
      Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
      new Promise(resolve => { cleanup = setTimeout(resolve, 1500); }),
    ]); } finally { clearTimeout(cleanup); if (!closed) handle.requestBrowserReplacement?.('WanbExpress context cleanup failed'); }
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1) throw new Error('No browser budget');
    signal?.throwIfAborted();
    return await Promise.race([
      (async () => {
        const created = await handle.browser.newContext();
        handle.noteTemporaryContext?.();
        if (expired) { await close(created); throw new Error('Late browser context'); }
        context = created;
        page = await context.newPage();
        if (expired) throw new Error('Late browser page');
        await installPolicy?.(page);
        if (expired) throw new Error('Late browser setup');
        observer = response => {
          if (!accepting) return;
          let endpoint;
          try { endpoint = new URL(response.url()); } catch { return; }
          // This fresh context owns the form's token. Retain only the fact that
          // its callback ran, never the token-bearing verification URL or body.
          if (endpoint.origin === ORIGIN && endpoint.pathname === '/Home/CaptchaVerify'
            && response.request().method() === 'GET' && ['V2', 'V3'].includes(endpoint.searchParams.get('version'))) {
            verificationSeen = true;
            verificationStatus = response.status();
            return;
          }
          if (endpoint.origin + endpoint.pathname !== API || endpoint.username || endpoint.password
            || endpoint.searchParams.getAll('TrackingNumber').length !== 1
            || endpoint.searchParams.get('TrackingNumber') !== number || response.request().method() !== 'GET') return;
          if (entries.length >= 10) { entries.at(-1).error = 'WanbExpress response limit exceeded'; accepting = false; finishTracking(); return; }
          const headers = response.headers();
          const afterVerification = verificationSeen;
          const entry = { url: `${API}?TrackingNumber=${number}`, status: response.status(), body: null,
            headers: Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key]).map(key => [key, headers[key].slice(0, 100)])),
            truncated: false, base64Encoded: false, error: null };
          entries.push(entry);
          // Verification tokens and rejection pages never leave the context.
          if (entry.status !== 200) { finishTracking(); return; }
          const length = Number(headers['content-length'] ?? 0);
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || totalBytes >= 3 * MAX_BODY) { entry.truncated = true; finishTracking(); return; }
          reads.push(response.body().then(body => {
            if (!accepting) return;
            totalBytes += body.length;
            if (body.length > MAX_BODY || totalBytes > 3 * MAX_BODY) { entry.truncated = true; finishTracking(); return; }
            entry.body = body.toString('utf8');
            let payload;
            try { payload = JSON.parse(entry.body); } catch { finishTracking(); return; }
            // An initial challenge is intermediate. A repeat after the form's
            // verification callback is its final answer, including rejection.
            if (afterVerification || payload?.Succeeded !== false || payload?.Error?.Code !== '0x110012') finishTracking();
          }).catch(() => { if (accepting) { entry.error = 'WanbExpress response could not be read'; finishTracking(); } }));
        };
        page.on('response', observer);
        // The deep link selects the checkbox-only configuration; the blank form can advertise the passive guest flow.
        const navigation = await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        if (expired || statusCode !== 200) return result();
        const version = await page.evaluate(() => document.querySelector('#showCaptchaVersion')?.value);
        if (completed) { await Promise.all(reads); return result(); }
        const checkbox = async () => {
          // The blank form has no requested number. Submit exactly one through
          // React before solving so its callback can repeat that lookup.
          await page.locator('textarea.trackingNumberText').fill(number, { timeout: Math.min(5000, remaining()) });
          await page.getByRole('button', { name: 'Track', exact: true }).click({ timeout: Math.min(5000, remaining()) });
          if (expired) return result();
          const solved = solveCaptcha && remaining() > 5000 ? await solveCaptcha(page, Math.min(20000, remaining())) : false;
          if (expired) return result();
          // Google's checkbox can tick before the carrier accepts its token.
          // Wait for the page's own identity-bound tracking request to finish.
          if (solved || verificationSeen || completed) await trackingReady;
          await Promise.all(reads);
          return result();
        };
        if (version === 'V2') return await checkbox();
        // Run the old passive client only while the public page advertises V3.
        // Its checkbox client can already have loaded another reCAPTCHA instance.
        await page.evaluate(async requested => {
          const version = document.querySelector('#showCaptchaVersion')?.value;
          const key = document.querySelector('#sitekey')?.value;
          const read = () => fetch('/TrackPoints/Track?TrackingNumber=' + encodeURIComponent(requested), { credentials: 'same-origin' });
          const initial = await read();
          let payload;
          try { payload = await initial.json(); } catch { return; }
          if (payload?.Succeeded !== false || payload?.Error?.Code !== '0x110012') return;
          if (version !== 'V3' || !/^[A-Za-z0-9_-]{30,100}$/.test(key ?? '')) return;
          delete window.grecaptcha;
          delete window.___grecaptcha_cfg;
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://www.recaptcha.net/recaptcha/api.js?render=' + encodeURIComponent(key);
            script.onload = resolve; script.onerror = reject;
            document.head.appendChild(script);
          });
          await new Promise(resolve => window.grecaptcha.ready(resolve));
          const token = await window.grecaptcha.execute(key, { action: 'submit' });
          const verified = await fetch('/Home/CaptchaVerify?token=' + encodeURIComponent(token) + '&version=V3', { credentials: 'same-origin' });
          let verification;
          try { verification = await verified.json(); } catch { return; }
          if (verified.status === 200 && verification?.Succeeded === true) await read();
        }, number).catch(error => {
          // A failed passive SDK can leave a captured challenge for V2 to recover.
          // With no response, retain the browser failure instead.
          if (!entries.length) throw error;
        });
        await Promise.all(reads);
        // A valid V3 token can still be refused by the carrier. The public deep
        // link selects its checkbox flow; reload to restore that widget's SDK.
        const last = entries.at(-1);
        let challenge;
        try { challenge = last?.body ? JSON.parse(last.body) : null; } catch { /* Keep malformed data for the adapter. */ }
        if (!expired && remaining() > 8000 && verificationStatus < 400 && last?.status === 200
          && !last.error && !last.truncated && challenge?.Succeeded === false && challenge?.Error?.Code === '0x110012') {
          verificationSeen = false; verificationStatus = 0; completed = false; trackingReady = trackingWait();
          const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
          statusCode = navigation?.status() ?? 0;
          if (!expired && statusCode === 200
            && await page.evaluate(() => document.querySelector('#showCaptchaVersion')?.value) === 'V2') return await checkbox();
        }
        return result();
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Browser deadline')); }, maxTimeout); }),
      new Promise((_, reject) => {
        abort = () => { expired = true; reject(new Error('Browser interrupted')); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } catch {
    if (entries.length) return result();
    return { tier, status: 'error', durationMs: Date.now() - start,
      reason: expired ? 'WanbExpress browser budget exhausted' : 'WanbExpress browser verification failed' };
  } finally {
    accepting = false; expired = true; clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    if (page && observer) page.off('response', observer);
    if (context) await close(context);
  }
}
