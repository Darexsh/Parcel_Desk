const ORIGIN = 'https://track.asendia.com';
const API = `${ORIGIN}/api/1.0/branded-url/branded-parcel-search?sort=shipment_date`;
const MAX_BODY = 1_000_000;
const POSTCODE = /^(?=.{3,12}$)(?=.*[0-9])[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/;

function trackingData(bytes) {
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { return 'null'; }
  if (!payload || typeof payload !== 'object') return 'null';
  const pick = (row, keys) => row && typeof row === 'object' && !Array.isArray(row)
    ? Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])) : row;
  const data = Array.isArray(payload.data) ? payload.data.map(row => {
    const parcel = pick(row, ['tracking_id', 'upper_tracking_id', 'status', 'destination_country_name', 'events']);
    if (Array.isArray(parcel?.events)) parcel.events = parcel.events.map(event =>
      pick(event, ['event_time', 'labelBC', 'harmonized_label', 'location_name']));
    return parcel;
  }) : payload.data;
  const methods = payload.verification_methods;
  return JSON.stringify({ context_code: payload.context_code, data,
    ...(methods && typeof methods === 'object' ? { verification_methods: { postal_code: methods.postal_code === true } } : {}) });
}

/** The portal shows the status and offers the scans against the delivery postcode. */
function historyLocked(body, number) {
  let payload;
  try { payload = JSON.parse(body); } catch { return false; }
  return payload?.context_code === 1000 && payload.verification_methods?.postal_code === true
    && Array.isArray(payload.data) && payload.data.length === 1
    && [payload.data[0]?.tracking_id, payload.data[0]?.upper_tracking_id].some(value => typeof value === 'string' && value.toUpperCase() === number)
    && !Object.hasOwn(payload.data[0], 'events');
}

/** The delivery postcode travels in the fragment, which is never sent to the portal as a URL. */
export function asendiaBrowserPostcode(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (!url.hash) return null;
  const params = new URLSearchParams(url.hash.slice(1));
  const values = params.getAll('trawl-postcode');
  return [...params.keys()].length === 1 && values.length === 1 && POSTCODE.test(values[0]) ? values[0] : undefined;
}

export function asendiaBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const match = /^\/track\/([A-Z0-9]{8,40})$/.exec(url.pathname);
  if (url.origin !== ORIGIN || url.username || url.password || url.search || asendiaBrowserPostcode(rawUrl) === undefined
    || !match || !/\d/.test(match[1]) || capture.captureResponses?.length !== 1
    || capture.captureResponses[0] !== API) return null;
  return match[1];
}

/** Submit through the portal after its own Turnstile callback enables search. */
export async function runAsendiaBrowser({ url, capture, handle, tier, maxTimeout, installPolicy }) {
  const number = asendiaBrowserNumber(url, capture);
  if (!number) return undefined;
  const postcode = asendiaBrowserPostcode(url);
  const pageUrl = `${ORIGIN}/track/${number}`;
  const start = Date.now();
  let context, page, timer, onResponse;
  let expired = false, accepting = true, statusCode = 0, configStatus = 0, captchaEnabled = null;
  let responseCount = 0, totalBytes = 0, lastClick = 0;
  const entries = [];
  const remaining = () => Math.max(1, maxTimeout - (Date.now() - start));
  const close = async target => {
    let closed = false, cleanupTimer;
    try {
      await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { cleanupTimer = setTimeout(resolve, 1500); })]);
    } finally {
      clearTimeout(cleanupTimer);
      if (!closed) handle.requestBrowserReplacement?.('Asendia context cleanup failed');
    }
  };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start,
    effectiveUrl: pageUrl, html: '', body: new Uint8Array(), statusCode: configStatus >= 400 ? configStatus : statusCode,
    cookies: [], capturedResponses: entries });
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
        let finish, offer;
        const terminal = new Promise(resolve => { finish = resolve; });
        const offered = new Promise(resolve => { offer = resolve; });
        const nudge = async () => {
          const frame = page.frames().find(frame => frame.url().startsWith('https://challenges.cloudflare.com/'));
          if (!frame) return;
          lastClick = Date.now();
          const checkbox = frame.locator('[role="checkbox"], input[type="checkbox"], .ctp-checkbox-label').first();
          if (await checkbox.isVisible().catch(() => false)) {
            await checkbox.click({ timeout: Math.min(2000, remaining()) }).catch(() => {});
          } else {
            const element = await frame.frameElement().catch(() => null);
            const box = await element?.boundingBox().catch(() => null);
            if (box && box.width > 20 && box.height > 20) {
              await page.mouse.click(box.x + Math.min(24, box.width * 0.12), box.y + box.height / 2);
            }
          }
        };
        onResponse = response => {
          if (!accepting) return;
          if (response.url() === `${ORIGIN}/api/1.0/fe-tracking-configuration` && response.status() !== 200) {
            configStatus = response.status(); finish(); return;
          }
          if (response.url() === `${ORIGIN}/api/1.0/fe-tracking-configuration` && response.status() === 200) {
            void response.json().then(value => {
              if (accepting && typeof value?.data?.TRACKING?.ENABLE_CAPTCHA === 'boolean') captchaEnabled = value.data.TRACKING.ENABLE_CAPTCHA;
            }).catch(() => {});
          }
          const request = response.request();
          if (response.url() !== API || request.method() !== 'POST') return;
          let body;
          try { body = request.postDataJSON(); } catch { return; }
          if (!Array.isArray(body?.ids) || body.ids.length !== 1 || body.ids[0] !== number) return;
          const submitted = postcode !== null && body.tracking_id === number && body.postal_code === postcode;
          if (++responseCount > 10) {
            entries.at(-1).error = 'Asendia tracking response limit exceeded'; accepting = false; finish(); return;
          }
          const headers = response.headers();
          const entry = { url: API, status: response.status(), body: null, trackingNumberSubmitted: number,
            headers: Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key])
              .map(key => [key, headers[key].slice(0, 100)])), truncated: false, base64Encoded: false, error: null,
            ...(submitted ? { postcodeSubmitted: true } : {}) };
          entries.push(entry);
          // Refusals keep their status, never verification tokens or recipient details.
          if (entry.status !== 200) { finish(); return; }
          const length = Number(headers['content-length'] ?? 0);
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || totalBytes >= 3 * MAX_BODY) {
            entry.truncated = true; finish(); return;
          }
          void response.body().then(bytes => {
            if (!accepting) return;
            totalBytes += bytes.length;
            if (bytes.length > MAX_BODY || totalBytes > 3 * MAX_BODY) entry.truncated = true;
            else entry.body = trackingData(bytes);
            if (postcode !== null && !submitted && entry.body && historyLocked(entry.body, number)) offer(true);
            else finish();
          }).catch(() => { if (accepting) { entry.error = 'Asendia tracking response could not be read'; finish(); } });
        };
        page.on('response', onResponse);
        const navigation = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        const button = page.getByRole('button', { name: 'Track here', exact: true });
        // Hydration briefly enables the button before the CAPTCHA configuration arrives.
        // The callback owns its token; the hidden input is not a reliable solved flag.
        while (accepting && !expired && !entries.length && statusCode === 200 && configStatus < 400) {
          const value = await page.getByRole('textbox').inputValue().catch(() => '');
          const widgetReady = captchaEnabled === false || captchaEnabled === true
            && await page.locator('[name="cf-turnstile-response"]').count().catch(() => 0) > 0;
          if (widgetReady && value === number && await button.isEnabled().catch(() => false)) {
            await button.click({ timeout: remaining() });
            break;
          }
          if (widgetReady && captchaEnabled && Date.now() - start > 5000 && Date.now() - lastClick > 8000) {
            await nudge();
          }
          await page.waitForTimeout(Math.min(250, remaining()));
        }
        if (await Promise.race([terminal, offered]) === true) {
          // The scans open against the delivery postcode, through the page's own dialog and a fresh token.
          const step = () => ({ timeout: Math.min(10_000, remaining()) });
          await page.locator('[class*="ctaActionCell"]').first().click(step());
          await page.locator('[class*="VerifyIdentityModal_inputGroup"] input').last().fill(postcode, step());
          await page.locator('[class*="VerifyIdentityModal_unlockBtn"]').click(step());
          const asked = Date.now();
          let done = false;
          void terminal.then(() => { done = true; });
          while (accepting && !expired && !done) {
            if (Date.now() - asked > 5000 && Date.now() - lastClick > 8000) await nudge();
            await page.waitForTimeout(Math.min(250, remaining()));
          }
        }
        // Keep the bounded sequence if the official page immediately repeats a request.
        await page.waitForTimeout(Math.min(300, remaining()));
        return result();
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Browser deadline')); }, maxTimeout); }),
    ]);
  } catch {
    if (entries.length || configStatus >= 400 || statusCode >= 400 || statusCode === 200 && captchaEnabled === true) return result();
    return { tier, status: 'error', durationMs: Date.now() - start, reason: 'Asendia browser retrieval failed' };
  } finally {
    accepting = false;
    expired = true;
    clearTimeout(timer);
    if (page && onResponse) page.off('response', onResponse);
    if (context) await close(context);
  }
}
