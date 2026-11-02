const ORIGIN = 'https://www.posta.hu';
const PAGE = '/nyomkovetes/nyitooldal';
// The tracker the public page frames. Its reCAPTCHA checkbox is only reachable as a top-level page.
const TRACKER = `${ORIGIN}/ikrnyomkovproxy/`;
const SEARCH = `${ORIGIN}/ikrnyomkovproxy/Search/Search`;
const RESULT = `${ORIGIN}/ikrnyomkovproxy/Result/Index`;
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const MAX_BODY = 1_000_000;
const CHALLENGE = /^https:\/\/www\.google\.com\/recaptcha\/(?:api2|enterprise)\/bframe(?:[?#]|$)/;
const REFUSAL = 'Google refused the audio challenge';

export function magyarPostaBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const number = url.searchParams.get('searchvalue') ?? '';
  return url.origin === ORIGIN && !url.username && !url.password && url.pathname === PAGE && !url.hash
    && [...url.searchParams].length === 1 && NUMBER.test(number)
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === RESULT ? number : null;
}

/** The one identifier a search form posted, or null. */
function postedNumber(request) {
  let form;
  try { form = new URLSearchParams(request.postData() ?? ''); } catch { return null; }
  const ids = form.getAll('Ids');
  const typed = form.getAll('SearchIds');
  return ids.length === 1 && typed.length === 1 && typed[0].trim() === ids[0] ? ids[0] : null;
}

/** The result page without its scripts and its form's anti-forgery token. */
function sanitize(html) {
  return html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<input\b[^>]*__RequestVerificationToken[^>]*>/gi, '');
}

/**
 * Runs in Google's challenge frame. Its class names, which every language shares, show a refusal:
 * the automated-traffic page for the address, or an error under an audio answer, which asks for more.
 */
function refusedInFrame() {
  const shown = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const error = document.querySelector('.rc-audiochallenge-error-message');
  return shown(document.querySelector('.rc-doscaptcha-header-text, .rc-doscaptcha-body-text'))
    || (shown(error) && !!error.textContent.trim());
}

/** Whether a challenge frame on the page shows Google's refusal now. */
async function refusedNow(page, signal) {
  for (const frame of page.frames()) {
    if (signal?.aborted || !CHALLENGE.test(frame.url())) continue;
    let timer;
    const refused = await Promise.race([Promise.resolve().then(() => frame.evaluate(refusedInFrame)).catch(() => false),
      new Promise(resolve => { timer = setTimeout(resolve, 1000, false); })]).finally(() => clearTimeout(timer));
    if (refused === true) return true;
  }
  return false;
}

/** Resolves true once the challenge frame shows a refusal, or false when `signal` ends the watch. */
async function refusal(page, signal) {
  while (!signal.aborted) {
    if (await refusedNow(page, signal)) return true;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return false;
}

/**
 * Search Magyar Posta's tracker for one number after its reCAPTCHA checkbox.
 * Every search needs a fresh answer, so each lookup opens its own context.
 */
export async function runMagyarPostaBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, solveCaptcha }) {
  const number = magyarPostaBrowserNumber(url, capture);
  if (!number) return undefined;
  const start = Date.now();
  const remaining = () => Math.max(1, Math.floor(maxTimeout - (Date.now() - start)));
  let context, page, timer, settle, observer, finish;
  let expired = false, accepting = true, statusCode = 0, totalBytes = 0;
  const entries = [];
  const searches = new WeakSet();
  const terminal = new Promise(resolve => { finish = resolve; });
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start,
    // TRAWL requires a body or HTML to forward captures. The rendered page is not needed.
    effectiveUrl: url, html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: entries });
  const close = async target => {
    let closed = false, cleanup;
    try { await Promise.race([
      Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
      new Promise(resolve => { cleanup = setTimeout(resolve, 1500); }),
    ]); } finally { clearTimeout(cleanup); if (!closed) handle.requestBrowserReplacement?.('Magyar Posta context cleanup failed'); }
  };
  const record = (address, response) => {
    if (entries.length >= 10) { entries.at(-1).error = 'Magyar Posta response limit exceeded'; accepting = false; finish(); return null; }
    const headers = response.headers();
    const entry = { url: address, status: response.status(), body: null,
      headers: Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key]).map(key => [key, headers[key].slice(0, 100)])),
      truncated: false, base64Encoded: false, error: null };
    entries.push(entry);
    return entry;
  };
  const read = (response, entry, keep) => {
    const length = Number(response.headers()['content-length'] ?? 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || totalBytes >= 3 * MAX_BODY) {
      entry.truncated = true; finish(); return;
    }
    void response.body().then(body => {
      if (!accepting) return;
      totalBytes += body.length;
      if (body.length > MAX_BODY || totalBytes > 3 * MAX_BODY) entry.truncated = true;
      else keep(body.toString('utf8'));
      finish();
    }).catch(() => { if (accepting) { entry.error = 'Magyar Posta response could not be read'; finish(); } });
  };
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1) throw new Error('No browser budget');
    return await Promise.race([
      (async () => {
        const created = await handle.browser.newContext();
        handle.noteTemporaryContext?.();
        if (expired) { await close(created); throw new Error('Late browser context'); }
        context = created;
        // The tracker answers in the browser's language; the parser reads its Hungarian wording.
        await context.addCookies([{ name: '.Nyomkov.Culture', value: 'HU', domain: 'www.posta.hu', path: '/ikrnyomkovproxy', secure: true }]);
        page = await context.newPage();
        if (expired) throw new Error('Late browser page');
        await installPolicy?.(page);
        if (expired) throw new Error('Late browser setup');
        observer = response => {
          if (!accepting) return;
          let target;
          try { target = new URL(response.url()); } catch { return; }
          const request = response.request();
          if (target.username || target.password || target.search || target.hash) return;
          const address = target.origin + target.pathname;
          if (address === SEARCH && request.method() === 'POST') {
            // Only the search for this whole number, alone.
            if (postedNumber(request) !== number) return;
            searches.add(request);
            const entry = record(SEARCH, response);
            if (!entry || entry.status === 302) return;
            // The form back with HTTP 200 is a refused verification. Its page stays here.
            if (entry.status === 200) read(response, entry, html => {
              if (/IKRNYOM_HIBA_\w*CAPTCHA/.test(html)) entry.error = 'Magyar Posta refused the verification';
            });
            else finish();
            return;
          }
          if (address !== RESULT || request.method() !== 'GET') return;
          // The result page this number's search redirected to, not one a later search opened.
          const from = request.redirectedFrom();
          if (!from || !searches.has(from)) return;
          const entry = record(RESULT, response);
          if (!entry) return;
          entry.trackingNumberSubmitted = number;
          if (entry.status !== 200) { finish(); return; }
          read(response, entry, html => { entry.body = sanitize(html); });
        };
        page.on('response', observer);
        const navigation = await page.goto(TRACKER, { waitUntil: 'domcontentloaded', timeout: remaining() });
        statusCode = navigation?.status() ?? 0;
        if (expired || statusCode !== 200 || !solveCaptcha || remaining() <= 5000) return result();
        await page.locator('#main_search_content').fill(number, { timeout: Math.min(5000, remaining()) });
        // A refusal ends the solve at once, and the solve ends before the browser deadline,
        // so the tracker's page can report either as a challenge.
        const solveMs = Math.min(30000, remaining() - 3000);
        const solving = new AbortController();
        let solveTimer;
        let outcome = await Promise.race([
          Promise.resolve().then(() => solveCaptcha(page, solveMs, solving.signal)).then(solved => solved ? 'solved' : 'unsolved', () => 'unsolved'),
          refusal(page, solving.signal).then(refused => refused ? 'refused' : 'unsolved'),
          new Promise(resolve => { solveTimer = setTimeout(resolve, solveMs + 500, 'unsolved'); }),
        ]).finally(() => { clearTimeout(solveTimer); solving.abort(); });
        // The solver also stops at Google's refusal, which its frame still shows.
        if (outcome === 'unsolved' && !expired && await refusedNow(page)) outcome = 'refused';
        if (outcome === 'refused') {
          // Its outcome, without the widget's tokens or text.
          entries.push({ url: TRACKER, status: statusCode, body: null, headers: {}, truncated: false, base64Encoded: false, error: REFUSAL });
        }
        if (expired || outcome !== 'solved') return result();
        await page.locator('#search_button').click({ timeout: Math.min(5000, remaining()) });
        // The search answers within a few seconds; a form that never posts ends the wait.
        await Promise.race([terminal, new Promise(resolve => { settle = setTimeout(resolve, Math.min(20000, remaining())); })]);
        return result();
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('Browser deadline')); }, maxTimeout); }),
    ]);
  } catch {
    // Keep what was observed for the adapter to classify.
    if (entries.length) return result();
    return { tier, status: 'error', durationMs: Date.now() - start,
      reason: expired ? 'Magyar Posta browser budget exhausted' : 'Magyar Posta browser search failed' };
  } finally {
    accepting = false; expired = true; clearTimeout(timer); clearTimeout(settle);
    if (page && observer) page.off('response', observer);
    if (context) await close(context);
  }
}
