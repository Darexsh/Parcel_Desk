import { setTimeout as delay } from 'node:timers/promises';
import { solveSlider } from './zto-slider.mjs';
import { solveZtoCharacters } from './zto-ocr.mjs';

const API = 'https://hdgateway.zto.com/batchGetTrace';
const MAX_BODY = 1_000_000;
// Puzzles answered, and those swapped unanswered for another.
const MAX_ANSWERS = 4, MAX_REPLACEMENTS = 2;
// What the OCR worker could not read, as opposed to a worker that failed.
const UNREADABLE = new Set(['targets', 'image', 'region', 'boxes', 'charset']);
const reportVerification = fields => console.warn(JSON.stringify({ level: 'warn', event: 'zto.verification', ...fields }));
const round = value => Math.round(value * 100) / 100;

/**
 * Dingxiang's check of an answer: `/api/v1` for the slider, `/api/v2` for the characters.
 * Read its verdict and secondary-verification marker; the token stays in the page.
 */
function verificationType(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || !/^cap(?:-\d{1,3})?\.dingxiang-inc\.com$/.test(url.host)) return null;
    return url.pathname === '/api/v1' ? 'slider' : url.pathname === '/api/v2' ? 'characters' : null;
  } catch { return null; }
}

export function ztoBrowserNumber(rawUrl, capture = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  const number = url.searchParams.get('waybills') ?? '';
  return url.origin === 'https://www.zto.com' && url.pathname === '/check/detail' && !url.username && !url.password
    && !url.hash && [...url.searchParams].length === 1 && /^(?:\d{12}|7\d{13})$/.test(number)
    && capture.captureResponses?.length === 1 && capture.captureResponses[0] === API ? number : null;
}

/** Keep identity, milestone clocks and failure kinds, never recipient fields or tokens. */
export function projectZtoReply(payload, number) {
  if (!payload || typeof payload !== 'object' || typeof payload.status !== 'boolean') return {};
  const statusCode = typeof payload.statusCode === 'string' && /^[A-Z0-9]{1,20}$/.test(payload.statusCode) ? payload.statusCode : null;
  const result = { status: payload.status, statusCode };
  if (!payload.status) {
    const message = typeof payload.message === 'string' ? payload.message.slice(0, 1000) : '';
    result.message = /频繁|限流|too many|rate limit/i.test(message) ? 'rate limit'
      : /验证码|验证|登录|captcha|verification/i.test(message) ? 'verification' : '';
    return result;
  }
  const items = payload.result?.items;
  if (!Array.isArray(items) || items.length !== 1 || items[0]?.billCode !== number || !Array.isArray(items[0]?.traces)
    || items[0].traces.length > 500) return result;
  const string = value => typeof value === 'string' && value.length <= 200 ? value : null;
  result.result = { items: [{ billCode: number, traces: items[0].traces.map(row => ({
    traceTypeCode: string(row?.traceTypeCode), traceTypeDesc: string(row?.traceTypeDesc),
    traceSiteName: string(row?.traceSiteName), traceTime: typeof row?.traceTime === 'number' ? row.traceTime : null,
  })) }] };
  return result;
}

export function widgetState() {
  const root = [...document.querySelectorAll('.dx_captcha')].find(e => e.getBoundingClientRect().width);
  if (!root) return null;
  // Replacement widgets can have geometry while their contents are still fading in.
  const rendered = element => {
    for (let node = element; node && node !== root.parentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) < 0.95) return false;
    }
    return !!element;
  };
  if (!rendered(root)) return null;
  const rect = root.getBoundingClientRect();
  const pic = root.querySelector('.dx_captcha_clickword_pic');
  const p = pic?.getBoundingClientRect();
  const targets = root.querySelector('.dx_captcha_clickword_hint-cnt')?.textContent?.trim();
  if (p?.width && rendered(pic) && /^[\u3400-\u9fff]{2,4}$/.test(targets ?? '')) return { type: 'characters', targets,
    key: 'characters:' + targets + ':' + pic.getAttribute('style'),
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    region: { x: p.x - rect.x, y: p.y - rect.y, width: p.width, height: p.height } };
  const image = root.querySelector('.dx_captcha_basic_sub-slider img');
  const background = root.querySelector('.dx_captcha_basic_bg canvas');
  if (background?.width && image?.naturalWidth && rendered(background) && rendered(image)) {
    return { type: 'slider', key: 'slider:' + image.src };
  }
  return null;
}

// Dingxiang's own refresh control fetches another puzzle in place.
function requestReplacement() {
  const root = [...document.querySelectorAll('.dx_captcha')].find(e => e.getBoundingClientRect().width);
  const button = [...(root?.querySelectorAll('[id*="btn-refresh"]') ?? [])].find(e => e.getBoundingClientRect().width);
  button?.click();
  return !!button;
}

/** What the tracking reply says, as the verification log names it. */
function replyKind(entry, payload) {
  if (entry.status === 429 || payload?.message === 'rate limit') return 'rate_limited';
  if (entry.status !== 200 || !payload) return 'failed';
  if (payload.status === true) return 'verified';
  return ['10201', '10202'].includes(payload.statusCode) ? 'challenge' : 'failed';
}

export async function runZtoBrowser({ url, handle, tier, maxTimeout, capture, installPolicy, signal,
  solveCharacters = solveZtoCharacters, report = reportVerification }) {
  const number = ztoBrowserNumber(url, capture);
  if (!number) return undefined;
  const start = Date.now(), abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  let context, page, onRequest, onResponse, timer, terminal = false, accepting = true, statusCode = 0, bytesRead = 0;
  let reply = null, firstCode = null, firstPuzzleMs = null, replacements = 0, stop = null;
  const entries = [], attempted = new Set(), puzzles = [];
  const verifications = new WeakMap();
  const remaining = () => Math.max(1, Math.floor(maxTimeout - (Date.now() - start)));
  // Fixed labels for why the page did or did not verify. The adapter reads the same outcome.
  const outcome = () => {
    if (terminal) return reply === 'verified' || reply === 'rate_limited' ? reply : 'reply_failed';
    if (['unsolved', 'solver_unavailable', 'error'].includes(stop)) return stop;
    // A previous refusal must not hide an unfinished later challenge or tracking read.
    if (puzzles.at(-1)?.verdict === 'refused') return 'refused';
    return puzzles.length ? 'deadline' : 'no_puzzle';
  };
  const result = () => ({ tier, status: 'success', durationMs: Date.now() - start, effectiveUrl: url,
    html: '', body: new Uint8Array(), statusCode, cookies: [], capturedResponses: entries,
    ...(outcome() === 'verified' ? {} : { reason: `zto-${outcome()}` }) });
  const close = async target => {
    let closed = false, cleanup;
    try { await Promise.race([
      Promise.resolve().then(() => target.close()).then(() => { closed = true; }).catch(() => {}),
      new Promise(resolve => { cleanup = setTimeout(resolve, 1500); }),
    ]); } finally { clearTimeout(cleanup); if (!closed) handle.requestBrowserReplacement?.('ZTO context cleanup failed'); }
  };
  let rejectAbort;
  const interrupted = new Promise((_, reject) => { rejectAbort = () => reject(new Error('ZTO browser interrupted')); });
  try {
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1) throw new Error('No browser budget');
    combined.throwIfAborted();
    combined.addEventListener('abort', rejectAbort, { once: true });
    timer = setTimeout(() => abort.abort(), maxTimeout);
    return await Promise.race([interrupted, (async () => {
      const created = await handle.browser.newContext();
      handle.noteTemporaryContext?.();
      if (combined.aborted) { await close(created); return result(); }
      context = created;
      page = await context.newPage();
      combined.throwIfAborted();
      await installPolicy?.(page);
      combined.throwIfAborted();
      // Synchronous Baidu telemetry can hold the document parser in <head>,
      // before the tracking client starts. Keep this filter local to ZTO.
      await page.route(/^https:\/\/(?:hm|dlswbr)\.baidu\.com\//, route => route.abort('blockedbyclient'));
      onRequest = request => {
        if (!accepting || request.method() !== 'POST') return;
        const type = verificationType(request.url());
        const puzzle = type && puzzles.findLast(row => row.type === type && row.verdict === 'answered');
        if (puzzle) verifications.set(request, { puzzle, start: Date.now() });
      };
      onResponse = response => {
        if (!accepting) return;
        if (verificationType(response.url()) && response.request().method() === 'POST') {
          const verification = verifications.get(response.request());
          if (verification) void response.body().then(body => {
            const payload = body.length <= 10_000 ? JSON.parse(body.toString('utf8')) : null;
            const { puzzle } = verification;
            if (accepting && typeof payload?.success === 'boolean' && puzzle.verdict === 'answered') {
              // Dingxiang uses success:false when it requires a second challenge, too.
              puzzle.verdict = payload.success ? 'accepted' : payload.msg === '二次验证' ? 'escalated' : 'refused';
              puzzle.verificationMs = Date.now() - verification.start;
            }
          }).catch(() => {});
          return;
        }
        if (response.url() !== API || response.request().method() !== 'POST') return;
        let request;
        try { request = response.request().postDataJSON(); } catch { return; }
        if (request?.items?.length !== 1 || request.items[0]?.billCode !== number) return;
        if (entries.length >= 10) { entries.at(-1).error = 'ZTO response limit exceeded'; reply = 'failed'; terminal = true; return; }
        const headers = response.headers();
        const entry = { url: API, trackingNumberSubmitted: number, status: response.status(), body: null,
          headers: Object.fromEntries(['content-type', 'retry-after'].filter(key => headers[key]).map(key => [key, headers[key].slice(0, 100)])),
          truncated: false, base64Encoded: false, error: null };
        entries.push(entry);
        if (entry.status !== 200) { reply = replyKind(entry); terminal = true; return; }
        const length = Number(headers['content-length'] ?? 0);
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY || bytesRead >= MAX_BODY * 3) {
          entry.truncated = true; reply = 'failed'; terminal = true; return;
        }
        void response.body().then(body => {
          if (!accepting) return;
          bytesRead += body.length;
          if (body.length > MAX_BODY || bytesRead > MAX_BODY * 3) { entry.truncated = true; reply = 'failed'; terminal = true; return; }
          const payload = projectZtoReply(JSON.parse(body.toString('utf8')), number);
          entry.body = JSON.stringify(payload);
          reply = replyKind(entry, payload);
          if (entry === entries[0]) firstCode = payload.statusCode ?? null;
          // Keep the initial challenge through escalation and automatic retries.
          if (reply !== 'challenge') terminal = true;
        }).catch(() => { if (accepting) { entry.error = 'ZTO response could not be read'; reply = 'failed'; terminal = true; } });
      };
      page.on('request', onRequest);
      page.on('response', onResponse);
      const navigation = await page.goto(url, { waitUntil: 'commit', timeout: Math.min(15000, remaining()) });
      statusCode = navigation?.status() ?? 0;
      for (;;) {
        if (terminal) { stop = 'reply'; break; }
        if (combined.aborted || remaining() <= 1500) { stop = 'deadline'; break; }
        const state = await page.evaluate(widgetState);
        if (!state || attempted.has(state.key)) { await delay(200, undefined, { signal: combined }); continue; }
        if (puzzles.length - replacements >= MAX_ANSWERS) { stop = 'puzzle_limit'; break; }
        attempted.add(state.key);
        firstPuzzleMs ??= Date.now() - start;
        const puzzle = { type: state.type, verdict: 'unanswered', readyMs: Date.now() - start };
        const solving = Date.now();
        puzzles.push(puzzle);
        // A puzzle the solver cannot read is swapped for another while time allows.
        const replaced = async failure => {
          puzzle.failure = failure;
          if (replacements >= MAX_REPLACEMENTS || remaining() < 5000 || !await page.evaluate(requestReplacement)) return false;
          replacements++; puzzle.verdict = 'replaced';
          return true;
        };
        if (state.type === 'slider') {
          const solution = await page.evaluate(solveSlider);
          combined.throwIfAborted();
          puzzle.solveMs = Date.now() - solving;
          if (Number.isFinite(solution.score)) Object.assign(puzzle, { score: round(solution.score), method: solution.method === 'outline' ? 'outline' : 'fill' });
          if (solution.error || solution.score < 0.5 || !Number.isFinite(solution.distance) || solution.distance <= 0) {
            if (await replaced(solution.error === 'unexpected-image' ? 'unexpected_image' : solution.error ? 'missing' : 'unmatched')) continue;
            stop = 'unsolved'; break;
          }
          // Decoding the piece is asynchronous; a refresh invalidates its coordinates.
          const current = await page.evaluate(widgetState);
          combined.throwIfAborted();
          if (current?.key !== state.key) { puzzle.verdict = 'expired'; continue; }
          puzzle.verdict = 'answered';
          const inputStarted = Date.now();
          await page.evaluate(async s => {
            const element = document.querySelector('.dx_captcha_basic_slider');
            if (!element) return;
            const { x, y } = s.start;
            const emit = (type, a, b) => element.dispatchEvent(new MouseEvent(type,
              { bubbles: true, clientX: a, clientY: b, button: 0, buttons: type === 'mouseup' ? 0 : 1 }));
            emit('mousedown', x, y);
            for (let i = 1; i <= 40; i++) {
              await new Promise(resolve => setTimeout(resolve, 25));
              emit('mousemove', x + s.distance * (1 - Math.pow(1 - i / 40, 2)), y + Math.sin(i / 7) * 2);
            }
            emit('mouseup', x + s.distance, y);
          }, solution);
          puzzle.inputMs = Date.now() - inputStarted;
        } else {
          puzzle.targets = [...state.targets].length;
          if (state.box.width > 600 || state.box.height > 400) { puzzle.failure = 'widget_size'; stop = 'unsolved'; break; }
          if (remaining() < 5000) { stop = 'deadline'; break; }
          const image = await page.locator('.dx_captcha_clickword:visible').screenshot({ timeout: Math.min(2000, remaining()), scale: 'css' });
          if (image.length > MAX_BODY) { if (await replaced('image_size')) continue; stop = 'unsolved'; break; }
          const answer = await solveCharacters({ image: image.toString('base64'), targets: state.targets, region: state.region }, combined, remaining() - 2000);
          puzzle.solveMs = Date.now() - solving;
          for (const key of ['boxes', 'confidence', 'margin']) if (Number.isFinite(answer?.[key])) puzzle[key] = round(answer[key]);
          if (Number.isFinite(answer?.ms)) puzzle.ocrMs = answer.ms;
          if (answer?.waitMs > 0) puzzle.waitMs = answer.waitMs;
          if (combined.aborted) { stop = 'deadline'; break; }
          const points = answer?.points;
          if (!Array.isArray(points) || points.length !== puzzle.targets) {
            const failure = typeof answer?.failure === 'string' ? answer.failure : 'points';
            if (failure === 'budget') { puzzle.failure = failure; stop = 'deadline'; break; }
            if ((UNREADABLE.has(failure) || failure === 'points') && await replaced(failure)) continue;
            stop = UNREADABLE.has(failure) || failure === 'points' ? 'unsolved' : 'solver_unavailable';
            puzzle.failure = failure; break;
          }
          const current = await page.evaluate(widgetState);
          if (current?.key !== state.key) { puzzle.verdict = 'expired'; continue; }
          for (const point of points) {
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < state.region.x || point.y < state.region.y
              || point.x > state.region.x + state.region.width || point.y > state.region.y + state.region.height) throw new Error('Invalid character position');
          }
          puzzle.verdict = 'answered';
          const inputStarted = Date.now();
          for (const point of points) {
            combined.throwIfAborted();
            await page.evaluate(({ x, y }) => {
              const element = document.elementFromPoint(x, y);
              if (!element?.closest('.dx_captcha_clickword')) return;
              for (const type of ['mousemove', 'mousedown', 'mouseup', 'click']) element.dispatchEvent(new MouseEvent(type,
                { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0 }));
            }, { x: current.box.x + point.x, y: current.box.y + point.y });
            await delay(250, undefined, { signal: combined });
          }
          puzzle.inputMs = Date.now() - inputStarted;
        }
        await delay(600, undefined, { signal: combined });
      }
      return result();
    })()]);
  } catch {
    stop = terminal ? 'reply' : combined.aborted ? 'deadline' : 'error';
    if (entries.length) return result();
    return { tier, status: 'error', durationMs: Date.now() - start,
      reason: combined.aborted ? 'ZTO browser budget exhausted' : 'ZTO browser retrieval failed' };
  } finally {
    accepting = false; clearTimeout(timer);
    combined.removeEventListener('abort', rejectAbort); abort.abort();
    if (page && onResponse) page.off('response', onResponse);
    if (page && onRequest) page.off('request', onRequest);
    if (context) await close(context);
    // Fixed labels, scores and counts only: no number, image, answer, token or reply text.
    try {
      report({ host: 'www.zto.com', outcome: outcome(), stop, durationMs: Date.now() - start, replies: entries.length,
        firstCode, firstPuzzleMs, replacements, puzzles });
    } catch { /* Diagnostics cannot affect cleanup or tracking. */ }
  }
}
