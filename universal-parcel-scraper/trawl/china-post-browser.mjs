import { solveChinaPostCharacters } from './china-post-ocr.mjs';

const ORIGIN = 'https://www.ems.com.cn';
const FLAG = `${ORIGIN}/ems-web/trackTestQuery/getLogisticsTestFlag`;
const API = `${ORIGIN}/ems-web/mailTrack/queryTrack`;
const MAX_BODY = 1_000_000;
const endpointOf = raw => {
  try { const url = new URL(raw); return !url.username && !url.password ? url.origin + url.pathname : null; }
  catch { return null; }
};

export function chinaPostBrowserNumber(raw, capture = {}) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const number = url.searchParams.get('mailNo') ?? '';
  return url.origin === ORIGIN && url.pathname === '/queryList' && !url.username && !url.password && !url.hash
    && [...url.searchParams].length === 1 && /^(?:Z[SCA]\d{11}|[A-Z]{2}\d{9}CN)$/.test(number)
    && capture.captureResponses?.length === 2 && capture.captureResponses[0] === FLAG && capture.captureResponses[1] === API ? number : null;
}

/** The guest preview's state labels and clocks, excluding contacts, addresses and CAPTCHA material. */
export function projectChinaPostWebReply(payload, number) {
  if (!payload || typeof payload.success !== 'boolean') return { invalid: true };
  if (!payload.success) {
    const message = typeof payload.message === 'string' ? payload.message : '';
    return { success: false, reason: /频繁|限流|too many/i.test(message) ? 'rate_limit'
      : /手机|电话|后四位/.test(message) ? 'phone'
      : /验证|验证码|captcha/i.test(message) ? 'verification'
      : /无查询邮件信息|超过查询期限|暂无物流信息/.test(message) ? 'empty' : 'refused' };
  }
  const records = payload.value?.domesticMailResultDtoList;
  if (!Array.isArray(records) || records.length !== 1) return { invalid: true };
  const record = records[0], scans = record?.resObj;
  if (record?.resCode !== 'true' || !Array.isArray(scans) || scans.length > 100) return { invalid: true };
  if ((record.traceNo && record.traceNo !== number) || scans.some(scan => scan?.traceNo !== number)) return { success: true, match: false };
  const label = value => typeof value === 'string' && /^[\u3400-\u9fff]{1,16}$/.test(value) ? value : '';
  return { success: true, match: true, scans: scans.map(scan => ({ number,
    time: typeof scan.bubbleTime === 'string' && scan.bubbleTime.length <= 32 ? scan.bubbleTime : '',
    code: typeof scan.opStateCode === 'string' && /^[A-Z0-9_]{1,20}$/.test(scan.opStateCode) ? scan.opStateCode : '',
    state: label(scan.opName) || label(scan.opStateName),
  })) };
}

/** Submit the anonymous form; a phone or account dialog is never completed. */
export async function runChinaPostBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, signal,
  solveCharacters = solveChinaPostCharacters }) {
  const number = chinaPostBrowserNumber(url, capture);
  if (!number) return undefined;
  const started = Date.now(), entries = [], reads = [];
  const stopped = new AbortController();
  const operationSignal = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
  let context, page, observer, requestObserver, timer, abort, accepting = true, expired = false, statusCode = 0, totalBytes = 0, verificationStatus = 0, phase = 'setup';
  let formReloaded = false, formReadyAfterReload = false, unreadableChallenge = false, trackingStarted = false;
  let promptRefreshed = false, previousPrompt;
  let finish;
  const trackingWait = () => new Promise(resolve => { finish = resolve; });
  let completed = trackingWait();
  const remaining = (cap = maxTimeout) => {
    const left = maxTimeout - (Date.now() - started);
    if (expired || left < 1) throw new Error('China Post browser budget exhausted');
    return Math.max(1, Math.min(cap, Math.floor(left)));
  };
  // The browser service otherwise turns every failed tier into HTTP 500. An
  // identified verification failure must still reach the carrier parser, which
  // rejects the empty capture as a challenge; it is never tracking history.
  const identifiedChallenge = () => statusCode === 200
    && (unreadableChallenge || (phase === 'form' && !trackingStarted && [403, 405, 412].includes(verificationStatus)));
  const result = () => ({ tier, status: entries.length || identifiedChallenge() ? 'success' : 'error', statusCode, durationMs: Date.now() - started, effectiveUrl: url,
    html: '', body: new Uint8Array(), cookies: [], capturedResponses: entries, verificationStatus, reason: `china-post-${phase}` });
  const boundEndpoint = request => {
    const endpoint = endpointOf(request.url?.());
    if (![FLAG, API].includes(endpoint) || request.method() !== 'POST') return null;
    let body;
    try { body = request.postDataJSON(); } catch { return null; }
    return endpoint === API
      ? body?.list?.length === 1 && body.list[0] === number && body.value?.length === 1
        && body.value[0]?.orderNum?.length === 1 && body.value[0].orderNum[0] === number ? endpoint : null
      : body?.value?.waybillNoList?.length === 1 && body.value.waybillNoList[0] === number ? endpoint : null;
  };
  const close = async target => {
    let closed = false, timeout;
    try { await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
      new Promise(resolve => { timeout = setTimeout(resolve, 1500); })]); }
    finally { clearTimeout(timeout); if (!closed) handle.requestBrowserReplacement?.('China Post context cleanup failed'); }
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
          const endpoint = endpointOf(response.url());
          if (endpoint === `${ORIGIN}/queryList` && response.request().isNavigationRequest?.()
            && response.frame() === page.mainFrame()) {
            statusCode = response.status();
            if ([403, 405, 412].includes(statusCode)) verificationStatus = statusCode;
          }
          if (![FLAG, API].includes(endpoint) || boundEndpoint(response.request()) !== endpoint) return;
          const track = endpoint === API;
          if (entries.length >= 10) { entries.at(-1).error = 'response-limit'; accepting = false; finish(); return; }
          const headers = response.headers();
          // The firewall appends session material to query strings. Never retain it.
          const entry = { url: endpoint, status: response.status(), body: null, truncated: false, base64Encoded: false,
            error: null, trackingNumberSubmitted: number,
            headers: Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key]).map(key => [key, headers[key].slice(0, 100)])) };
          entries.push(entry);
          if (entry.status !== 200) { finish(); return; }
          const length = Number(headers['content-length'] ?? 0);
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || totalBytes >= 3 * MAX_BODY) {
            entry.truncated = true; finish(); return;
          }
          reads.push(response.body().then(body => {
            if (!accepting) return;
            totalBytes += body.length;
            if (body.length > MAX_BODY || totalBytes > 3 * MAX_BODY) { entry.truncated = true; finish(); return; }
            let payload;
            try { payload = JSON.parse(body.toString('utf8')); }
            catch { entry.error = 'invalid-json'; finish(); return; }
            const projected = !track && payload?.success === true ? { success: true, checked: true }
              : projectChinaPostWebReply(payload, number);
            entry.body = JSON.stringify(projected);
            if (track || projected.success !== true) finish();
          }).catch(() => { if (accepting) { entry.error = 'response-read'; finish(); } }));
        };
        requestObserver = request => { if (accepting && boundEndpoint(request)) trackingStarted = true; };
        page.on('request', requestObserver);
        page.on('response', observer);
        phase = 'navigation';
        const navigation = await page.goto(`${ORIGIN}/queryList`, { waitUntil: 'domcontentloaded', timeout: remaining(25000) });
        statusCode = navigation?.status() ?? 0;
        if ([403, 405, 412].includes(statusCode)) verificationStatus = statusCode;
        if ([404, 410].includes(statusCode)) return result();
        const input = page.locator('input[placeholder="输入最多20个邮件号(多个请用空格或,隔开)"]');
        phase = 'form';
        // Its firewall can return executable HTML with 412, then navigate to the form.
        try { await input.fill(number, { timeout: remaining(15000) }); }
        catch (error) {
          // A cleared firewall page can leave its scripts unloaded. Reload only
          // before any tracking request, once, on the same official entry page.
          const location = new URL(page.url());
          if (operationSignal.aborted || trackingStarted || entries.length || remaining() < 15000
            || ![200, 403, 405, 412].includes(statusCode) || location.origin !== ORIGIN || location.pathname !== '/queryList') throw error;
          formReloaded = true;
          phase = 'form-reload';
          const reloaded = await page.reload({ waitUntil: 'domcontentloaded', timeout: remaining(15000) });
          statusCode = reloaded?.status() ?? 0;
          if ([403, 405, 412].includes(statusCode)) verificationStatus = statusCode;
          phase = 'form';
          await input.fill(number, { timeout: remaining(15000) });
          formReadyAfterReload = true;
        }
        if (await input.inputValue({ timeout: remaining(3000) }) !== number) throw new Error('China Post input changed');
        // Blurring commits the typed value to the form's list of waybills.
        await input.evaluate(element => element.blur(), undefined, { timeout: remaining(3000) });
        phase = 'picture';
        const nextPicture = () => page.waitForResponse(response => endpointOf(response.url()) === `${ORIGIN}/ems-web/cutPic/getPictureNew`
          && response.request().method() === 'POST', { timeout: remaining() }).catch(() => null);
        let picture = nextPicture();
        // Native mouse movement can stall in Camoufox; use the form's click handler.
        await page.getByRole('button', { name: '查询', exact: true }).evaluate(element => element.click(), undefined, { timeout: remaining(3000) });
        for (let attempt = 0; attempt < 2; attempt++) {
          const imageResponse = await picture;
          if (!imageResponse || imageResponse.status() !== 200) return result();
          const imageBody = await imageResponse.body();
          if (imageBody.length > MAX_BODY) throw new Error('China Post image response too large');
          const challenge = JSON.parse(imageBody.toString('utf8'))?.data;
          await page.locator('.text-verify').waitFor({ timeout: remaining(5000) });
          if (promptRefreshed) {
            // A refresh invalidates the old puzzle. Wait for the official widget
            // to display the new response before interpreting or clicking it.
            if (!challenge?.id || challenge.id === previousPrompt?.id
              || !challenge.backgroundImage || challenge.backgroundImage === previousPrompt?.backgroundImage) return result();
            await page.waitForFunction(image => {
              const element = document.querySelector('.text-verify');
              return element && getComputedStyle(element).backgroundImage.includes(image);
            }, challenge.backgroundImage, { timeout: remaining(3000) });
          }
          phase = 'characters';
          let promptUnreadable = false;
          const points = await solveCharacters(challenge, operationSignal, remaining(24000), stage => {
            if (stage === 'prompt' || stage === 'positions') phase = `characters-${stage}`;
            if (stage === 'prompt-unreadable' && phase === 'characters-prompt') promptUnreadable = true;
          });
          if (!points?.length || points.length > 4 || points.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y)
            || point.x < 0 || point.y < 0 || point.x >= challenge.backgroundImageWidth || point.y >= challenge.backgroundImageHeight)) {
            unreadableChallenge = true;
            if (!attempt && promptUnreadable && !operationSignal.aborted && !trackingStarted && !entries.length && remaining() >= 12000) {
              picture = nextPicture();
              previousPrompt = challenge;
              promptRefreshed = true;
              await page.getByRole('button', { name: '刷新', exact: true }).evaluate(element => element.click(), undefined, { timeout: remaining(3000) });
              continue;
            }
            return result();
          }
          unreadableChallenge = false;
          phase = 'submit';
          await page.locator('.text-verify').evaluate((element, positions) => {
            const rect = element.getBoundingClientRect();
            for (const point of positions) element.dispatchEvent(new MouseEvent('click', { bubbles: true,
              clientX: rect.x + point.x * rect.width, clientY: rect.y + point.y * rect.height }));
          }, points.map(point => ({ x: point.x / challenge.backgroundImageWidth, y: point.y / challenge.backgroundImageHeight })), { timeout: remaining(3000) });
          // On an incorrect answer the official form opens a new puzzle itself.
          // Observe that refresh before submitting; never replay an old solution.
          const refresh = attempt === 0 ? nextPicture() : null;
          await page.getByRole('button', { name: '验证', exact: true }).evaluate(element => element.click(), undefined, { timeout: remaining(3000) });
          phase = 'history';
          await completed;
          await Promise.all(reads);
          let latest;
          try { latest = JSON.parse(entries.at(-1)?.body ?? 'null'); } catch { return result(); }
          if (attempt || latest?.reason !== 'verification' || remaining() < 12000) return result();
          picture = refresh;
          completed = trackingWait();
        }
        return result();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('China Post browser budget exhausted')), Math.max(1, maxTimeout));
        abort = () => reject(new Error('China Post browser cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } catch {
    return result();
  } finally {
    const failedVerification = !entries.length && identifiedChallenge(), failurePhase = phase;
    const failureCause = unreadableChallenge ? 'unreadable' : 'firewall', failurePageStatus = statusCode, failureVerificationStatus = verificationStatus;
    const reloadedFormReady = formReadyAfterReload;
    let reloadScans = 0;
    if (formReloaded || promptRefreshed) {
      try {
        const last = entries.at(-1), payload = JSON.parse(last?.body ?? 'null');
        if (last?.url === API && last.status === 200 && payload?.success === true && payload.match === true && Array.isArray(payload.scans)) reloadScans = payload.scans.length;
      } catch { /* A failed reply supplies no history. */ }
    }
    expired = true; accepting = false; stopped.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (page && observer) page.off('response', observer);
    if (page && requestObserver) page.off('request', requestObserver);
    if (context) await close(context);
    if (failedVerification) {
      try { console.warn(JSON.stringify({ level: 'warn', event: 'china-post.verification', host: 'www.ems.com.cn',
        phase: failurePhase, cause: failureCause, pageStatus: failurePageStatus, verificationStatus: failureVerificationStatus })); }
      catch { /* Diagnostics cannot change tracking or cleanup. */ }
    }
    if (formReloaded) {
      try { console.warn(JSON.stringify({ level: 'warn', event: 'china-post.form-reload', host: 'www.ems.com.cn',
        formReady: reloadedFormReady, scans: reloadScans })); } catch { /* Diagnostics cannot change tracking or cleanup. */ }
    }
    if (promptRefreshed) {
      try { console.warn(JSON.stringify({ level: 'warn', event: 'china-post.prompt-refresh', host: 'www.ems.com.cn',
        scans: reloadScans })); } catch { /* Diagnostics cannot change tracking or cleanup. */ }
    }
  }
}
