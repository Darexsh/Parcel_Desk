// The Posta app adds a number to its guest list once an invisible reCAPTCHA
// Enterprise widget issues a token. The app renders that widget in a WebView
// whose base URL is net.posta.hu, and later reads of the same application id
// need no token. This helper renders the app's widget page on that origin in
// a fresh context, answers its audio challenge with TRAWL's speech-to-text and
// posts the one number, returning the reply without names, phone numbers or the token.
const ORIGIN = 'https://net.posta.hu';
/** The WebView's document, which the app loads with this base URL. */
const PAGE = `${ORIGIN}/`;
const TRACKING = `${ORIGIN}/mpl/public/api/mobile/guest/package/tracking`;
const SITE_KEY = '6Lf5NGktAAAAAMZ_5_t485SSq5kFIkZeKrCKyEPd'; // gitleaks:allow
// The key the public app sends with every guest request, the same for every install.
const APP_KEY = '4ec65760-cac5-4344-bee8-316962adf443'; // gitleaks:allow
const APP_HEADERS = { 'User-Agent': 'okhttp/4.12.0', 'X-Internal-Key': APP_KEY, preview: 'true', Accept: 'application/json, text/plain, */*' };
const APPLICATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const CHALLENGE = /^https:\/\/www\.google\.com\/recaptcha\/enterprise\/bframe(?:[?#]|$)/;
const AUDIO = /^https:\/\/www\.google\.com\/recaptcha\/enterprise\/payload\?/;
const REFUSAL = 'Google refused the audio challenge';
const MAX_BODY = 1_000_000;
const MAX_AUDIO = 2_000_000;
const MAX_ANSWERS = 2;

/** Only guest registrations live here; every hit still fetches the current scans. */
export function magyarPostaRegistrations({ now = Date.now, limit = 1000, ttlMs = 24 * 60 * 60_000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000 || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('Invalid Magyar Posta registration limits');
  }
  const entries = new Map();
  let refusedUntil = 0;
  return {
    refused() { return now() < refusedUntil; },
    refuse() { refusedUntil = now() + 10 * 60_000; },
    get(number) {
      const entry = entries.get(number);
      if (!entry) return null;
      if (entry.until <= now()) { entries.delete(number); return null; }
      entries.delete(number); entries.set(number, entry);
      return entry.id;
    },
    set(number, id) {
      if (!NUMBER.test(number) || !APPLICATION.test(id)) return;
      entries.delete(number); entries.set(number, { id, until: now() + ttlMs });
      while (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    delete(number) { entries.delete(number); },
  };
}
const registrations = magyarPostaRegistrations();
const REGISTRATION_HEADER = 'x-magyar-posta-registration';

// The app's widget page: an invisible widget executed at once. Its callback
// leaves the token in the page, where the helper reads it.
const WIDGET = `<!DOCTYPE html>
<html lang="hu">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<script src="https://www.google.com/recaptcha/enterprise.js?hl=hu" async defer></script>
</head>
<body>
<span id="recaptcha-container"></span>
<input type="hidden" id="verification" value="" />
<script>
const ready = setInterval(() => {
  if (!window.grecaptcha || !grecaptcha.enterprise || !grecaptcha.enterprise.render) return;
  clearInterval(ready);
  const widget = grecaptcha.enterprise.render("recaptcha-container", { sitekey: "${SITE_KEY}", size: "invisible",
    callback: token => { document.getElementById("verification").value = token; } });
  grecaptcha.enterprise.execute(widget);
}, 250);
</script>
</body>
</html>`;

/** The application id and the one number the adapter asks the helper to add, or null. */
export function magyarPostaAppRequest(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const applicationId = url.searchParams.get('applicationId') ?? '';
  const number = url.searchParams.get('packageId') ?? '';
  return url.origin === ORIGIN && !url.username && !url.password && url.pathname === new URL(TRACKING).pathname && !url.hash
    && [...url.searchParams].length === 2 && APPLICATION.test(applicationId) && NUMBER.test(number)
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === TRACKING ? { applicationId, number } : null;
}

const sleep = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** `promise`, or `fallback` once `ms` pass. */
async function within(promise, ms, fallback) {
  let timer;
  return await Promise.race([Promise.resolve().then(() => promise).catch(() => fallback),
    new Promise(resolve => { timer = setTimeout(resolve, ms, fallback); })]).finally(() => clearTimeout(timer));
}

/**
 * Runs in Google's challenge frame. Its class names, which every language shares, show a refusal:
 * the automated-traffic page for the address, or an error under an audio answer, which asks for more.
 */
function challengeState() {
  const shown = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const error = document.querySelector('.rc-audiochallenge-error-message');
  const audio = document.querySelector('#audio-source');
  const prompt = document.querySelector('.rc-imageselect-desc-wrapper');
  return {
    refused: shown(document.querySelector('.rc-doscaptcha-header-text, .rc-doscaptcha-body-text'))
      || (shown(error) && !!(error.textContent ?? '').trim()),
    challenge: shown(document.querySelector('#rc-audio')) || !!(prompt?.textContent ?? '').trim(),
    audio: audio ? audio.src || audio.getAttribute('src') || '' : '',
  };
}

/** Whether the widget's callback left a token in the page. */
async function verified(page) {
  return await within(page.evaluate(() => !!document.getElementById('verification')?.value), 1000, false);
}

/** The audio clip's words, fetched in the widget's own context, or null. */
async function listen(context, address, transcribe, timeoutMs, signal) {
  const clip = await within(context.request.get(address, { headers: { Referer: 'https://www.google.com/' }, timeout: timeoutMs, maxRedirects: 0 }), timeoutMs, null);
  if (!clip || clip.status() !== 200) return null;
  const bytes = await within(clip.body(), timeoutMs, null);
  if (!bytes || !bytes.length || bytes.length > MAX_AUDIO || signal.aborted) return null;
  const answer = await within(transcribe(`data:audio/mpeg;base64,${Buffer.from(bytes).toString('base64')}`, signal), timeoutMs, undefined);
  return typeof answer === 'string' && answer.trim() ? answer.trim().slice(0, 100) : null;
}

/**
 * Waits for the widget's token, switching its challenge to audio and answering it.
 * Google's refusal ends the wait at once, with no further audio request.
 */
async function verify(page, context, transcribe, budgetMs, signal) {
  const end = Date.now() + budgetMs;
  const left = () => Math.max(1, end - Date.now());
  let asked = false, heard = '', answers = 0, answeredAt = 0;
  while (Date.now() < end && !signal.aborted) {
    if (await verified(page)) return 'solved';
    const frame = page.frames().find(candidate => CHALLENGE.test(candidate.url()));
    const state = frame ? await within(frame.evaluate(challengeState), 1000, null) : null;
    if (state?.refused) return 'refused';
    if (frame && state?.audio && state.audio !== heard && AUDIO.test(state.audio)) {
      if (answers >= MAX_ANSWERS) return 'unsolved';
      answers++; heard = state.audio;
      const answer = await listen(context, state.audio, transcribe, Math.min(15000, left()), signal);
      if (signal.aborted || Date.now() >= end) break;
      if (!answer) {
        await within(frame.locator('#recaptcha-reload-button').click({ timeout: Math.min(3000, left()) }), 3000);
        continue;
      }
      await within(frame.locator('#audio-response').fill(answer, { timeout: Math.min(3000, left()) }), 3000);
      await within(frame.locator('#recaptcha-verify-button').click({ timeout: Math.min(3000, left()) }), 3000);
      answeredAt = Date.now();
    } else if (frame && state?.challenge && !asked) {
      asked = true;
      await within(frame.locator('#recaptcha-audio-button').click({ timeout: Math.min(3000, left()) }), 3000);
    } else if (frame && answeredAt && Date.now() - answeredAt > 4000 && answers < MAX_ANSWERS) {
      // Google judged nothing: a fresh clip, as TRAWL's solver does.
      answeredAt = 0;
      await within(frame.locator('#recaptcha-reload-button').click({ timeout: Math.min(3000, left()) }), 3000);
    }
    await sleep(250, signal);
  }
  return 'unsolved';
}

const scalar = (value, limit) => typeof value === 'string' ? value.slice(0, limit)
  : typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const fields = (source, names, limit = 300) => Object.fromEntries(names.map(name => [name, scalar(source?.[name], limit)])
  .filter(([, value]) => value !== undefined));

/** The reply's tracking fields; names, phone numbers, notes and payment details stay out. */
export function magyarPostaAppReply(text) {
  let reply;
  try { reply = JSON.parse(text); } catch { return null; }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const kept = fields(reply, ['message'], 200);
  if (Array.isArray(reply.data)) {
    kept.data = reply.data.slice(0, 5).filter(item => item && typeof item === 'object').map(item => ({
      ...fields(item, ['package_id', 'current_status', 'consignment_type', 'consignment_direction', 'delivery_type_key']),
      package_details: fields(item.package_details, ['consignment_title', 'base_service_code']),
      delivery_info: fields(item.delivery_info, ['alias', 'text']),
      events: (Array.isArray(item.events) ? item.events.slice(0, 300) : []).filter(event => event && typeof event === 'object')
        .map(event => fields(event, ['alias', 'status', 'message', 'code', 'location', 'date'])),
    }));
  }
  return JSON.stringify(kept);
}

/** The app's token-free refresh or its addition after verification. */
async function tracking(fetcher, { applicationId, number }, token, timeoutMs, signal) {
  const entry = { url: TRACKING, status: 0, body: null, headers: {}, truncated: false, base64Encoded: false, error: null,
    trackingNumberSubmitted: number };
  const query = new URLSearchParams({ platform: 'android', preferredLanguage: 'hu', applicationId });
  if (token === null) query.append('packages[0][packageId]', number);
  else query.set('_ts', String(Date.now()));
  try {
    const response = await fetcher(`${TRACKING}?${query}`, { method: token === null ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))]),
      headers: { ...APP_HEADERS, ...(token !== null && { 'Content-Type': 'application/json' }) },
      ...(token !== null && { body: JSON.stringify({ packageId: number, 'g-recaptcha-response': token }) }) });
    entry.status = response.status;
    entry.headers = Object.fromEntries(['content-type', 'retry-after'].map(key => [key, response.headers.get(key)])
      .filter(([, value]) => value).map(([key, value]) => [key, value.slice(0, 100)]));
    const length = Number(response.headers.get('content-length') ?? 0);
    if (!Number.isSafeInteger(length) || length > MAX_BODY) { entry.truncated = true; await response.body?.cancel(); return entry; }
    const text = await response.text();
    if (text.length > MAX_BODY) entry.truncated = true;
    else if ((entry.body = magyarPostaAppReply(text)) === null && entry.status === 200) entry.error = 'Magyar Posta app reply is not JSON';
  } catch {
    entry.error = 'Magyar Posta app request failed';
  }
  return entry;
}

function bound(entry, number, requireEvents = false) {
  if (entry.status !== 200 || entry.error || entry.truncated || !entry.body) return false;
  try {
    const data = JSON.parse(entry.body).data;
    return Array.isArray(data) && data.length === 1 && data[0]?.package_id === number
      && (!requireEvents || data[0].events?.length > 0);
  } catch { return false; }
}

/**
 * Add one number to the app's guest list after its invisible reCAPTCHA widget.
 * Every addition needs a fresh token, so each one opens its own context.
 */
export async function runMagyarPostaApp({ url, handle, tier, maxTimeout, capture, installPolicy, transcribe, signal,
  fetcher = globalThis.fetch, registrationCache = registrations, onRegistration = fields => console.warn(JSON.stringify({
    level: 'warn', event: 'magyar-posta.registration', ...fields,
  })) }) {
  const request = magyarPostaAppRequest(url, capture);
  if (!request) return undefined;
  const start = Date.now();
  const remaining = () => Math.max(1, Math.floor(maxTimeout - (Date.now() - start)));
  const ending = new AbortController();
  const combined = signal ? AbortSignal.any([signal, ending.signal]) : ending.signal;
  let context, timer, expired = false, statusCode = 0, cache = 'miss';
  const entries = [];
  const result = () => {
    for (const entry of entries) entry.headers['x-magyar-posta-registration-cache'] = 'memory';
    return { tier, status: 'success', durationMs: Date.now() - start,
      // TRAWL requires a body or HTML to forward captures. The widget page is not needed.
      effectiveUrl: url, html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: entries };
  };
  const close = async target => {
    let closed = false, cleanup;
    try { await Promise.race([
      Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
      new Promise(resolve => { cleanup = setTimeout(resolve, 1500); }),
    ]); } finally { clearTimeout(cleanup); if (!closed) handle.requestBrowserReplacement?.('Magyar Posta context cleanup failed'); }
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1) throw new Error('No browser budget');
    return await Promise.race([
      (async () => {
        if (combined.aborted) return result();
        const held = registrationCache.get(request.number);
        if (held && remaining() > 8000) {
          const entry = await tracking(fetcher, { ...request, applicationId: held }, null, Math.min(2500, remaining() - 6000), combined);
          if (expired || combined.aborted) return result();
          entry.headers[REGISTRATION_HEADER] = 'retained';
          if (bound(entry, request.number)) {
            // The retained guest id never leaves this service. The SDK must not
            // remember its newly requested id as though it held this number.
            entries.push(entry); statusCode = 200; cache = 'hit'; return result();
          }
          // Only an explicit empty list expires a registration. A refusal, rate
          // limit or malformed reply keeps its failure instead of adding load.
          let empty = false;
          try { const data = JSON.parse(entry.body).data; empty = Array.isArray(data) && data.length === 0; } catch { /* Not an empty list. */ }
          if (entry.status === 200 && !entry.error && !entry.truncated && empty) {
            registrationCache.delete(request.number); cache = 'stale';
          } else {
            if (entry.status === 200 && !entry.error && !entry.truncated) {
              registrationCache.delete(request.number);
              entry.body = null; entry.error = 'Magyar Posta returned no bound cached history';
            }
            // The helper completed; the captured API reply owns its HTTP status
            // and Retry-After, as an addition from the widget page does.
            entries.push(entry); statusCode = 200; cache = 'failed'; return result();
          }
        }
        if (registrationCache.refused()) {
          cache = 'cooldown';
          entries.push({ url: PAGE, status: 200, body: null, headers: {}, truncated: false, base64Encoded: false, error: REFUSAL });
          statusCode = 200; return result();
        }
        if (typeof transcribe !== 'function') throw new Error('No speech-to-text');
        const created = await handle.browser.newContext();
        handle.noteTemporaryContext?.();
        if (expired) { await close(created); throw new Error('Late browser context'); }
        context = created;
        const page = await context.newPage();
        if (expired) throw new Error('Late browser page');
        await installPolicy?.(page);
        // The app's own page on the origin its WebView gives it; nothing else is answered locally.
        await page.route(PAGE, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: WIDGET }));
        if (expired) throw new Error('Late browser setup');
        const navigation = await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        // The number is posted after the widget, so the widget leaves time for it.
        if (expired || statusCode !== 200 || remaining() <= 8000) return result();
        const outcome = await verify(page, context, transcribe, Math.min(30000, remaining() - 6000), ending.signal);
        if (outcome === 'refused') {
          registrationCache.refuse();
          // Its outcome, without the widget's tokens or text.
          entries.push({ url: PAGE, status: statusCode, body: null, headers: {}, truncated: false, base64Encoded: false, error: REFUSAL });
        }
        if (expired || outcome !== 'solved') return result();
        const token = await within(page.evaluate(() => document.getElementById('verification')?.value ?? ''), 1000, '');
        if (typeof token !== 'string' || !token || expired) return result();
        const entry = await tracking(fetcher, request, token, Math.min(15000, remaining() - 500), ending.signal);
        if (!expired && bound(entry, request.number, true)) {
          registrationCache.set(request.number, request.applicationId);
        }
        entries.push(entry);
        return result();
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Browser deadline')); }, maxTimeout); }),
    ]);
  } catch {
    // Keep what was observed for the adapter to classify.
    if (entries.length) return result();
    return { tier, status: 'error', durationMs: Date.now() - start,
      reason: expired ? 'Magyar Posta browser budget exhausted' : 'Magyar Posta browser verification failed' };
  } finally {
    expired = true; clearTimeout(timer); ending.abort();
    if (context) await close(context);
    try { onRegistration({ cache, browserOpened: !!context, durationMs: Date.now() - start }); } catch { /* Telemetry cannot change tracking. */ }
  }
}
