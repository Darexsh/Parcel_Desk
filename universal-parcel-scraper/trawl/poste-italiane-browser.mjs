import { recaptchaAudioBackoff } from './recaptcha-backoff.mjs';

const ORIGIN = 'https://www.poste.it';
const API = `${ORIGIN}/online/dovequando/DQ-REST/ricercasemplice`;
const MAX_BODY = 1_000_000;
const NATIVE_EVENTS = new Set(['checkbox_started', 'checkbox_verified', 'challenge_missing', 'audio_started',
  'audio_blocked', 'audio_refused', 'audio_cooldown', 'audio_verified', 'native_failed']);
const reportVerification = fields => console.warn(JSON.stringify({ level: 'warn', event: 'poste.verification', ...fields }));

export function posteItalianeBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const number = /^#\/risultati-spedizioni\/([A-Z0-9]{12,24})$/.exec(url.hash)?.[1];
  return url.origin === ORIGIN && !url.username && !url.password && url.pathname === '/cerca/index.html'
    && !url.search && number && /\d/.test(number) && capture.captureResponses?.length === 1
    && capture.captureResponses[0] === API ? number : null;
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => {
  if (value[key] !== null && !['string', 'number', 'boolean'].includes(typeof value[key])) throw new Error('Invalid tracking field');
  return [key, value[key]];
}));
function trackingOnly(payload) {
  if (!record(payload)) throw new Error('Invalid tracking envelope');
  const result = pick(payload, ['idTracciatura', 'esitoRicerca', 'tipoSpedizione', 'tipoProdotto', 'stato', 'flagRitorno', 'dataPrevistaConsegna']);
  if (Object.hasOwn(payload, 'listaMovimenti')) {
    if (!Array.isArray(payload.listaMovimenti) || payload.listaMovimenti.length > 500) throw new Error('Invalid tracking history');
    result.listaMovimenti = payload.listaMovimenti.map(row => record(row)
      ? pick(row, ['statoLavorazione', 'dataOra', 'luogo', 'denominazioneUfficio', 'flagRitorno']) : null);
  }
  return result;
}

/** Let the official page submit its issued reCAPTCHA token and capture the resulting history. */
export async function runPosteItalianeBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, solveCaptcha, signal,
  onVerification = reportVerification, audioBackoff = recaptchaAudioBackoff }) {
  const number = posteItalianeBrowserNumber(url, capture);
  if (!number) return undefined;
  const started = Date.now();
  const entries = [];
  const requests = new Map(), pending = new Set(), complete = new Set();
  const controller = new AbortController();
  let context, page, timer, onResponse, onRequest, onFailed, abort;
  let accepting = true, expired = false, totalBytes = 0, statusCode = 0;
  let sawChallenge = false, paused = false, waitedForRequest = false, nativeOutcome = 'not_started';
  let finish, challenge;
  const terminal = new Promise(resolve => { finish = resolve; });
  const challenged = new Promise(resolve => { challenge = resolve; });
  const remaining = () => Math.max(1, Math.floor(maxTimeout - (Date.now() - started)));
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - started,
    effectiveUrl: url, html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: entries });
  const close = async target => {
    let closed = false, cleanup;
    try {
      await Promise.race([Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
        new Promise(resolve => { cleanup = setTimeout(resolve, 1500); })]);
    } finally {
      clearTimeout(cleanup);
      if (!closed) handle.requestBrowserReplacement?.('Poste Italiane context cleanup failed');
    }
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1) throw new Error('No browser budget');
    signal?.throwIfAborted();
    // The page is asked only after a direct search drew the CAPTCHA from the same address, so
    // while Google refuses the audio it would only show the challenge again.
    if (await audioBackoff.remainingMs() > 0) {
      paused = true; nativeOutcome = 'audio_cooldown';
      return result();
    }
    await Promise.race([
      (async () => {
        const created = await handle.browser.newContext();
        handle.noteTemporaryContext?.();
        if (expired) { await close(created); throw new Error('Late browser context'); }
        context = created;
        page = await context.newPage();
        if (expired) throw new Error('Late browser page');
        await installPolicy?.(page);
        if (expired) throw new Error('Late browser policy');
        const bound = request => {
          if (!accepting || expired || request.url() !== API || request.method() !== 'POST') return null;
          let body;
          try { body = request.postDataJSON(); } catch { return null; }
          return record(body) && body.codiceSpedizione === number && body.tipoRichiedente === 'WEB' ? body : null;
        };
        const begin = request => {
          if (requests.has(request)) return requests.get(request);
          if (entries.length >= 10) { entries.at(-1).error = 'Poste tracking response limit exceeded'; accepting = false; finish(); return; }
          const entry = { url: API, status: 0, body: null, headers: {}, truncated: false, base64Encoded: false,
            error: 'Poste tracking request unfinished' };
          entries.push(entry); requests.set(request, entry); pending.add(request);
          return entry;
        };
        const settle = (request, entry, terminal = true) => {
          pending.delete(request);
          if (terminal) complete.add(entry);
          if (!pending.size && complete.has(entries.at(-1))) finish();
        };
        onRequest = request => { if (bound(request)) begin(request); };
        onFailed = request => {
          if (!bound(request)) return;
          const entry = begin(request);
          if (!entry) return;
          entry.error = 'Poste tracking request failed';
          settle(request, entry);
        };
        onResponse = response => {
          const request = response.request(), body = bound(request);
          if (!body || response.url() !== API) return;
          const hasCaptcha = Boolean(body.captcha);
          const entry = begin(request);
          if (!entry) return;
          const headers = response.headers();
          entry.status = response.status();
          entry.headers = Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key])
            .map(key => [key, headers[key].slice(0, 100)]));
          entry.error = null;
          if (![200, 400].includes(entry.status)) { settle(request, entry); return; }
          const length = Number(headers['content-length'] ?? 0);
          if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || totalBytes >= 3 * MAX_BODY) {
            entry.truncated = true; settle(request, entry); return;
          }
          void response.body().then(body => {
            if (!accepting) return;
            totalBytes += body.length;
            if (body.length > MAX_BODY || totalBytes > 3 * MAX_BODY) { entry.truncated = true; settle(request, entry); return; }
            const payload = JSON.parse(body.toString('utf8'));
            if (entry.status === 400 && record(payload) && payload.id === 2 && payload.tipo === 'error'
              && /captcha/i.test(String(payload.descrizione))) {
              // Preserve the gate, without its request token or unrelated error details.
              entry.body = JSON.stringify({ id: 2, tipo: 'error', descrizione: 'CAPTCHA required' });
              sawChallenge = true;
              challenge();
              settle(request, entry, hasCaptcha);
              return;
            }
            if (entry.status === 200) entry.body = JSON.stringify(trackingOnly(payload));
            settle(request, entry);
          }).catch(() => {
            if (accepting) { entry.error = 'Poste tracking response could not be decoded'; settle(request, entry); }
          });
        };
        page.on('request', onRequest);
        page.on('response', onResponse);
        page.on('requestfailed', onFailed);
        const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        const gate = await Promise.race([terminal.then(() => false), challenged.then(() => true)]);
        if (gate && await audioBackoff.remainingMs() > 0) {
          nativeOutcome = 'audio_cooldown';
          waitedForRequest = pending.size > 0;
          if (waitedForRequest) await terminal;
        } else if (gate && solveCaptcha && remaining() > 5000) {
          await page.getByRole('button', { name: 'Non accetto', exact: true }).click({ timeout: Math.min(1000, remaining()) }).catch(() => {});
          // Success removes the widget before the solver can see its tick. The
          // bound tracking reply, not that boolean, decides completion.
          const solved = await Promise.race([terminal, solveCaptcha(page, Math.min(30000, remaining()), controller.signal,
            event => {
              if (NATIVE_EVENTS.has(event)) nativeOutcome = event;
              if (event === 'audio_blocked') audioBackoff.block();
            }).catch(() => false)]);
          // The callback can remove the widget before its tracking response or
          // body arrives. Finish an observed request within the same deadline.
          waitedForRequest = solved !== true && pending.size > 0;
          if (solved === true || waitedForRequest) await terminal;
        }
        // A refused solve leaves the captured challenge; do not wait out the deadline.
        if (!gate) await terminal;
      })(),
      new Promise((_, reject) => {
        const stop = () => { expired = true; controller.abort(); reject(new Error('Poste browser deadline')); };
        timer = setTimeout(stop, maxTimeout);
        abort = stop;
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) stop();
      }),
    ]);
    return result();
  } catch {
    if (entries.length) return result();
    return { tier, status: 'error', durationMs: Date.now() - started,
      reason: expired ? 'Poste Italiane browser budget exhausted' : 'Poste Italiane browser retrieval failed' };
  } finally {
    accepting = false; expired = true; controller.abort(); clearTimeout(timer);
    for (const request of pending) requests.get(request).error ??= 'Poste tracking response unfinished';
    if (abort) signal?.removeEventListener('abort', abort);
    if (page) {
      if (onRequest) page.off('request', onRequest);
      if (onResponse) page.off('response', onResponse);
      if (onFailed) page.off('requestfailed', onFailed);
    }
    if (context) await close(context);
    if (sawChallenge || paused) {
      const last = entries.at(-1);
      try {
        onVerification({ nativeOutcome, waitedForRequest, responses: entries.length, pending: pending.size,
          outcome: paused ? 'not_opened' : !last || last.error || last.truncated ? 'incomplete' : last.status === 400 ? 'challenge' : 'http_response',
          durationMs: Date.now() - started });
      } catch { /* Diagnostics must not change the tracking result or cleanup. */ }
    }
  }
}
