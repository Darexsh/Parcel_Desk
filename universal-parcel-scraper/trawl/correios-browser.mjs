const ORIGIN = 'https://rastreamento.correios.com.br';
const PAGE = `${ORIGIN}/app/index.php`;
const API = `${ORIGIN}/app/resultado.php`;
const MAX_BODY = 1_000_000;
const reportVerification = fields => console.warn(JSON.stringify({ level: 'warn', event: 'correios.verification', ...fields }));

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const pick = (row, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));

/** The fields the adapter reads. Locker pickup codes, delivery receipts and recipient fields stay out. */
function trackingData(bytes) {
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { return 'null'; }
  if (!isObject(payload)) return 'null';
  const scan = event => isObject(event) ? {
    ...pick(event, ['codigo', 'tipo', 'descricao']),
    ...(Object.hasOwn(event, 'dtHrCriado')
      ? { dtHrCriado: isObject(event.dtHrCriado) ? pick(event.dtHrCriado, ['date', 'timezone_type', 'timezone']) : event.dtHrCriado } : {}),
    ...(isObject(event.unidade) && isObject(event.unidade.endereco)
      ? { unidade: { endereco: pick(event.unidade.endereco, ['cidade', 'uf']) } } : {}),
  } : null;
  return JSON.stringify({ ...pick(payload, ['codObjeto', 'erro', 'mensagem', 'situacao', 'atrasado', 'dtPrevista']),
    ...(isObject(payload.tipoPostal) ? { tipoPostal: pick(payload.tipoPostal, ['categoria']) } : {}),
    ...(Array.isArray(payload.eventos) ? { eventos: payload.eventos.map(scan) } : {}) });
}

/** The tracker's own share link for one S10 number, which fills in its search field. */
export function correiosBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const number = url.searchParams.get('objetos') ?? '';
  if (url.origin !== ORIGIN || url.username || url.password || url.origin + url.pathname !== PAGE || url.hash
    || [...url.searchParams].length !== 1 || !/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(number)
    || capture.captureResponses?.length !== 1 || capture.captureResponses[0] !== API) return null;
  return number;
}

/** Search through the tracker's form once Turnstile has given the page its token. */
export async function runCorreiosBrowser({ url, capture, handle, tier, maxTimeout, installPolicy, onVerification = reportVerification }) {
  const number = correiosBrowserNumber(url, capture);
  if (!number) return undefined;
  const start = Date.now();
  let context, page, timer, onResponse;
  let expired = false, accepting = true, statusCode = 0, widget = false, searched = false, tokenReceived = false, timedOut = false;
  let responseCount = 0, totalBytes = 0, lastClick = 0, pendingBodies = 0;
  const entries = [];
  const remaining = () => Math.max(1, maxTimeout - (Date.now() - start));
  const close = async target => {
    let closed = false, cleanupTimer;
    try {
      await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { cleanupTimer = setTimeout(resolve, 1500); })]);
    } finally {
      clearTimeout(cleanupTimer);
      if (!closed) handle.requestBrowserReplacement?.('Correios context cleanup failed');
    }
  };
  // TRAWL forwards captures only beside a body or HTML; the rendered page holds no evidence the reply lacks.
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start,
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
        // The widget only shows itself when Cloudflare wants an interaction, as it does in the service's
        // Firefox: the token follows a click on its checkbox, which may need a few tries while it renders.
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
          if (!accepting || response.url() !== API) return;
          const request = response.request();
          if (request.method() !== 'POST') return;
          const form = new URLSearchParams(request.postData() ?? '');
          if (form.getAll('objeto').length !== 1 || form.get('objeto') !== number) return;
          if (++responseCount > 10) {
            entries.at(-1).error = 'Correios tracking response limit exceeded'; accepting = false; finish(); return;
          }
          const headers = response.headers();
          const entry = { url: API, status: response.status(), body: null, trackingNumberSubmitted: number,
            headers: Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key])
              .map(key => [key, headers[key].slice(0, 100)])), truncated: false, base64Encoded: false, error: null };
          entries.push(entry);
          // A refused check keeps its status, never the verification token.
          if (entry.status !== 200) { finish(); return; }
          const length = Number(headers['content-length'] ?? 0);
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || totalBytes >= 3 * MAX_BODY) {
            entry.truncated = true; finish(); return;
          }
          pendingBodies++;
          void response.body().then(bytes => {
            if (!accepting) return;
            totalBytes += bytes.length;
            if (bytes.length > MAX_BODY || totalBytes > 3 * MAX_BODY) entry.truncated = true;
            else entry.body = trackingData(bytes);
            finish();
          }).catch(() => { if (accepting) { entry.error = 'Correios tracking response could not be read'; finish(); } })
            .finally(() => { pendingBodies--; });
        };
        page.on('response', onResponse);
        const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        const loaded = Date.now();
        const field = page.locator('#objeto');
        while (accepting && !expired && statusCode === 200) {
          widget ||= await page.locator('#form-rastreamento .cf-turnstile').count().catch(() => 0) > 0;
          const token = widget ? await page.locator('#form-rastreamento [name="cf-turnstile-response"]').inputValue().catch(() => '') : '';
          if (token) {
            tokenReceived = true;
            if (await field.inputValue().catch(() => '') !== number) await field.fill(number, { timeout: Math.min(5000, remaining()) });
            await page.locator('#b-pesquisar').click({ timeout: Math.min(5000, remaining()) });
            searched = true;
            break;
          }
          if (widget && Date.now() - loaded > 1000 && Date.now() - lastClick > 3000) await nudge();
          await page.waitForTimeout(Math.min(250, remaining()));
        }
        if (!searched) return result();
        await terminal;
        // Keep the bounded sequence if the page repeats its request at once.
        await page.waitForTimeout(Math.min(300, remaining()));
        return result();
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = expired = true; reject(new Error('Browser deadline')); }, maxTimeout); }),
    ]);
  } catch {
    // An unresolved widget or a refused reply is a challenge for the adapter, not a missing parcel.
    if (entries.length || statusCode >= 400 || statusCode === 200 && widget) return result();
    return { tier, status: 'error', durationMs: Date.now() - start, reason: 'Correios browser retrieval failed' };
  } finally {
    accepting = false;
    expired = true;
    clearTimeout(timer);
    if (page && onResponse) page.off('response', onResponse);
    if (context) await close(context);
    const last = entries.at(-1);
    try {
      onVerification({ nativeOutcome: tokenReceived ? 'token_received' : widget ? 'waiting' : 'not_started',
        searched, responses: entries.length, pending: pendingBodies,
        pageStatus: Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : 0,
        apiStatus: Number.isInteger(last?.status) && last.status >= 100 && last.status <= 599 ? last.status : 0,
        outcome: !last ? timedOut ? 'timeout' : 'not_submitted'
          : [400, 401, 403].includes(last.status) ? 'challenge' : last.status === 429 ? 'rate_limited'
            : last.error || last.truncated || last.status === 200 && (!last.body || last.body === 'null') ? 'incomplete' : 'http_response',
        durationMs: Date.now() - start });
    } catch { /* Diagnostics must not change the tracking result or cleanup. */ }
  }
}
