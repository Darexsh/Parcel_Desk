// Keep a verified FedEx browser context on its original pooled browser. Moving
// its cookies to another context/browser did not preserve API acceptance.
const PAGE = 'https://www.fedex.com/fedextrack/';
const API = 'https://api.fedex.com/track/v2/shipments';
const MAX_BODY = 2_000_000;
const MAX_REPLIES = 20;

// The browser tier succeeds even when its captured tracking API returns 403.
// Its ordinary failure log cannot describe these refusals. Keep this separate
// from the reply, and log only fixed labels, counts and elapsed times.
const reportRefusal = fields => console.warn(JSON.stringify({ level: 'warn', event: 'fedex.api-refusal', ...fields }));
const reportSessionEnd = fields => console.warn(JSON.stringify({ level: 'warn', event: 'fedex.session-end', ...fields }));

// Classify a discarded reply without retaining its content or identifying its parcel.
function discardedReply(entries, number) {
  const last = entries.at(-1);
  if (!last || last.status === 0) return 'request_failed';
  if ([401, 403].includes(last.status)) return 'api_denied';
  if (last.status !== 200) return 'api_error';
  if (last.truncated || last.error || !last.body) return 'unreadable';
  try {
    const output = JSON.parse(last.body)?.output;
    const packages = output?.packages;
    if (!Array.isArray(packages)) return 'unreadable';
    const matches = packages.filter(item => item?.trackingNbr === number);
    if (packages.length && matches.length !== 1) return 'identity';
    const errors = [...(Array.isArray(output.errorList) ? output.errorList : []),
      ...(Array.isArray(matches[0]?.errorList) ? matches[0].errorList : [])];
    const codes = errors.map(error => String(error?.code ?? error?.errorCode ?? '').slice(0, 80)).join(' ');
    if (/AUTHORIZ|AUTHENTICAT/i.test(codes)) return 'verification_required';
    if (/TRACKINGNUMBER|NOTFOUND|NO TRACKING/i.test(codes)) return 'no_tracking';
    if (!packages.length) return 'empty_result';
    return 'missing_status';
  } catch { return 'unreadable'; }
}

export function fedexSessionNumber(url, capture = {}) {
  let page;
  try { page = new URL(url); } catch { return null; }
  if (page.origin !== 'https://www.fedex.com'
    || !['/fedextrack/', '/wtrk/track/'].includes(page.pathname)
    || capture.captureResponses?.length !== 1 || capture.captureResponses[0] !== API) return null;
  const numbers = page.searchParams.getAll('trknbr');
  return numbers.length === 1 && /^(\d{12}|\d{15}|\d{20})$/.test(numbers[0]) ? numbers[0] : null;
}

async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms));
    })]);
  } finally { clearTimeout(timer); }
}

export class FedExSessions {
  #sessions = new WeakMap();
  #activity = new WeakMap();
  constructor({ idleMs = 30 * 60_000, maxAgeMs = 2 * 60 * 60_000, closeMs = 3_000,
    settleMs = 250, incompleteSettleMs = 1_000, onRefusal = reportRefusal, onSessionEnd = reportSessionEnd } = {}) {
    this.idleMs = idleMs;
    this.maxAgeMs = maxAgeMs;
    this.closeMs = closeMs;
    this.settleMs = settleMs;
    this.incompleteSettleMs = incompleteSettleMs;
    this.onRefusal = onRefusal;
    this.onSessionEnd = onSessionEnd;
  }

  preferred(entries, domain) {
    if (domain !== 'www.fedex.com' || !entries.length) return undefined;
    const ready = entries.find(entry => {
      const session = this.#sessions.get(entry.browser);
      return session?.verified && !session.disposed && !session.page.isClosed()
        && Date.now() - session.created < this.maxAgeMs;
    });
    if (ready) return ready;
    // The pool otherwise sticks to the first browser that visited a domain,
    // including rejected attempts. A later lookup may try another available
    // browser; there is no extra request or retry inside this lookup.
    return entries.reduce((best, entry) => (this.#activity.get(entry.browser)?.at ?? 0)
      < (this.#activity.get(best.browser)?.at ?? 0) ? entry : best);
  }

  async #discard(browser, session, replace, reason) {
    if (session.disposed) return;
    session.disposed = true;
    try {
      this.onSessionEnd({ host: 'api.fedex.com', browser: session.browserId, reason,
        sessionAgeMs: Math.max(0, Date.now() - session.created), lookups: session.lookups,
        digits: session.digits, hadVerifiedLookup: session.lastVerifiedAt !== undefined,
        idleMs: session.lastLookupAt === undefined ? null : Math.max(0, Date.now() - session.lastLookupAt),
        sinceVerifiedMs: session.lastVerifiedAt === undefined ? null : Math.max(0, Date.now() - session.lastVerifiedAt) });
    } catch { /* Diagnostics must never prevent session disposal. */ }
    clearTimeout(session.timer);
    browser.off('disconnected', session.disconnected);
    if (this.#sessions.get(browser) === session) this.#sessions.delete(browser);
    if (!session.context) {
      if (browser.isConnected?.() !== false) replace?.('FedEx session setup did not finish');
      return;
    }
    try { await bounded(session.context.close(), this.closeMs, 'FedEx session cleanup timed out'); }
    catch { replace?.('FedEx session cleanup failed'); }
  }

  #retain(browser, session, replace) {
    const left = Math.min(this.idleMs, this.maxAgeMs - (Date.now() - session.created));
    session.timer = setTimeout(() => {
      void this.#discard(browser, session, replace, Date.now() - session.created >= this.maxAgeMs ? 'max_age' : 'idle');
    }, Math.max(0, left));
    session.timer.unref?.();
  }

  async run({ url, handle, tier, maxTimeout, capture, installPolicy }) {
    const number = fedexSessionNumber(url, capture);
    if (!number) return undefined;
    const started = Date.now(), browser = handle.browser;
    const failure = reason => ({ tier, status: 'error', reason, durationMs: Date.now() - started });
    if (!Number.isFinite(maxTimeout) || maxTimeout < 1) return failure('FedEx lookup budget exhausted');
    let session = this.#sessions.get(browser);
    // The pool serializes leases; this also protects against accidental direct
    // callers sharing a browser while one lookup is still in flight.
    if (session?.busy) return failure('FedEx browser session is busy');
    const previous = this.#activity.get(browser);
    const activity = { at: started, lookups: (previous?.lookups ?? 0) + 1, successAt: previous?.successAt };
    this.#activity.set(browser, activity);
    if (session && (Date.now() - session.created >= this.maxAgeMs || session.page.isClosed())) {
      await this.#discard(browser, session, handle.requestBrowserReplacement,
        Date.now() - session.created >= this.maxAgeMs ? 'max_age' : 'page_closed');
      session = undefined;
    }
    const reused = Boolean(session?.verified);
    if (!session) {
      session = { created: Date.now(), busy: true, verified: false, disposed: false, lookups: 0,
        browserId: Number.isSafeInteger(handle.id) && handle.id >= 0 && handle.id < 1024 ? handle.id : undefined };
      session.disconnected = () => { void this.#discard(browser, session, handle.requestBrowserReplacement, 'browser_disconnected'); };
      this.#sessions.set(browser, session);
      browser.once('disconnected', session.disconnected);
    }
    clearTimeout(session.timer);
    session.busy = true;
    session.lookups++;
    session.lastLookupAt = started;
    session.digits = number.length;
    try {
      const result = await bounded(this.#lookup({ number, session, browser, started, maxTimeout, capture, installPolicy,
        replace: handle.requestBrowserReplacement, onCreated: handle.noteTemporaryContext }),
        Math.max(0, maxTimeout - (Date.now() - started)), 'FedEx lookup budget exhausted');
      if (session.verified) session.lastVerifiedAt = activity.successAt = Date.now();
      const rejected = result.capturedResponses.find(entry => [401, 403].includes(entry.status));
      if (rejected) {
        try {
          this.onRefusal({ host: 'api.fedex.com', tier: [2, 3, 4].includes(tier) ? tier : undefined,
            browser: Number.isSafeInteger(handle.id) && handle.id >= 0 && handle.id < 1024 ? handle.id : undefined,
            statusCode: rejected.status, cause: rejected.error === 'fedex-edge-denial' ? 'edge' : 'api',
            session: reused ? 'reused' : 'new', sessionAgeMs: Math.max(0, started - session.created),
            idleMs: previous ? Math.max(0, started - previous.at) : null, browserLookups: activity.lookups,
            sinceSuccessMs: activity.successAt === undefined ? null : Math.max(0, started - activity.successAt),
            ...(result.capturedResponses.length > 1 ? { responses: result.capturedResponses.length, recovered: session.verified } : {}) });
        } catch { /* Diagnostics must not change tracking or cleanup. */ }
      }
      if (!session.verified) await this.#discard(browser, session, handle.requestBrowserReplacement, discardedReply(result.capturedResponses, number));
      return { tier, status: 'success', statusCode: 200, durationMs: Date.now() - started,
        effectiveUrl: url, ...result, cookies: [], reason: reused ? 'fedex-session-reused' : 'fedex-session-new' };
    } catch {
      // Selector and navigation errors can include the number; do not include
      // those raw messages in shared browser-service diagnostics.
      await this.#discard(browser, session, handle.requestBrowserReplacement, 'lookup_failed');
      return failure('FedEx browser session could not complete tracking');
    } finally {
      session.busy = false;
      if (session.verified && !session.disposed) this.#retain(browser, session, handle.requestBrowserReplacement);
    }
  }

  async #lookup({ number, session, browser, started, maxTimeout, capture, installPolicy, replace, onCreated }) {
    const timeout = (cap = 15_000) => {
      const remaining = maxTimeout - (Date.now() - started);
      if (remaining <= 0 || session.disposed) throw new Error('FedEx lookup budget exhausted');
      return Math.min(cap, remaining);
    };
    if (!session.context) {
      const context = await browser.newContext();
      if (session.disposed) {
        void bounded(context.close(), this.closeMs, 'FedEx late context cleanup timed out')
          .catch(() => { replace?.('FedEx late session cleanup failed'); });
        throw new Error('FedEx lookup ended during browser setup');
      }
      session.context = context;
      onCreated?.();
      session.page = await context.newPage();
      await installPolicy?.(session.page);
    }
    const page = session.page;
    // Begin each lookup at the blank form while preserving the context. The
    // result-page form can ignore submissions or retain the previous route.
    session.verified = false;
    let submitted = false, wake, lastActivity = Date.now();
    const requests = new Set();
    const responded = new WeakSet();
    const replies = [];
    const changed = () => { lastActivity = Date.now(); wake?.(); };
    const waitForChange = async ms => {
      let timer, resolve;
      try {
        await new Promise(done => { resolve = done; wake = done; timer = setTimeout(done, Math.max(1, ms)); });
      } finally {
        clearTimeout(timer);
        if (wake === resolve) wake = undefined;
      }
    };
    const matches = request => {
      if (!submitted || request.url() !== API || request.method() !== 'POST') return false;
      try {
        const info = request.postDataJSON()?.trackingInfo;
        return info?.length === 1 && info[0]?.trackNumberInfo?.trackingNumber === number;
      } catch { return false; }
    };
    const observed = (request, response) => {
      if (!requests.has(request) || responded.has(request)) return;
      responded.add(request);
      replies.push(response);
      if (replies.length > MAX_REPLIES) replies.shift();
      changed();
    };
    const onResponse = response => observed(response.request(), response);
    const onFailure = request => observed(request, null);
    const onRequest = request => {
      if (!matches(request)) return;
      requests.add(request);
      if (requests.size > MAX_REPLIES) requests.delete(requests.values().next().value);
      changed();
    };
    page.on('response', onResponse);
    page.on('requestfailed', onFailure);
    page.on('request', onRequest);
    try {
      await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: timeout(25_000) });
      const consent = page.getByRole('button', { name: 'REJECT OPTIONAL COOKIES', exact: true });
      try { await consent.click({ timeout: timeout(4_000) }); }
      catch { timeout(); }
      const another = page.getByRole('button', { name: 'Track Another Shipment', exact: true });
      const input = page.locator('input[id^="tracking_number_"]').first();
      try { await another.click({ timeout: timeout(5_000) }); }
      catch {
        timeout();
        // Camoufox mouse movement can stall. Only invoke the menu handler if
        // its form did not already open; a second toggle would close it.
        if (!await input.isVisible()) await another.evaluate(element => element.click(), undefined, { timeout: timeout() });
      }
      await input.fill(number, { timeout: timeout() });
      if (await input.inputValue({ timeout: timeout() }) !== number) throw new Error('FedEx input changed');
      submitted = true;
      const submit = page.getByRole('button', { name: /^track$/i, exact: true });
      try { await submit.click({ timeout: timeout(5_000) }); }
      catch {
        timeout();
        // A click can dispatch the request before its automation action times
        // out. Never submit twice when that request is already in flight.
        if (!requests.size) await submit.evaluate(element => { if (!element.disabled) element.click(); }, undefined, { timeout: timeout() });
      }
      // Keep the bounded response sequence, including automatic verification retries.
      // A summary without scans gets a little longer to receive the history. Neither
      // a refusal nor an unreadable final reply can disappear behind an older success.
      const entries = [];
      const deadline = started + maxTimeout - Math.min(250, maxTimeout / 50);
      let rich = false;
      while (Date.now() < deadline) {
        if (!replies.length) {
          const pending = [...requests].some(request => !responded.has(request));
          const quiet = Math.min(capture.settleTimeout ?? Infinity, rich ? this.settleMs : this.incompleteSettleMs);
          const left = entries.length && !pending ? quiet - (Date.now() - lastActivity) : deadline - Date.now();
          if (left <= 0) break;
          await waitForChange(Math.min(left, deadline - Date.now()));
          continue;
        }
        const response = replies.shift();
        session.verified = false;
        rich = false;
        if (!response) {
          entries.push({ url: API, status: 0, body: null, headers: {}, truncated: false,
            base64Encoded: false, error: 'fedex-tracking-request-failed' });
          continue;
        }
        const headers = response.headers();
        const retainedHeaders = {};
        for (const name of ['content-type', 'server', 'retry-after']) {
          if (headers[name]) retainedHeaders[name] = headers[name].slice(0, 100);
        }
        const entry = { url: API, status: response.status(), body: null, truncated: false, base64Encoded: false,
          headers: retainedHeaders };
        if (typeof response.serverAddr === 'function') {
          try {
            const peer = await bounded(response.serverAddr(), timeout(500), 'FedEx peer observation timed out');
            if (peer?.ipAddress) retainedHeaders['x-trawl-network-family'] = peer.ipAddress.includes(':') ? 'IPv6' : 'IPv4';
          } catch { /* Missing network diagnostics never change the original lookup. */ }
        }
        if ([401, 403].includes(entry.status)) {
          entry.error = /akamai/i.test(retainedHeaders.server ?? '')
            && /text\/html/i.test(retainedHeaders['content-type'] ?? '')
            ? 'fedex-edge-denial' : 'fedex-browser-request-rejected';
        }
        if (entry.status === 200) {
          const length = Number(headers['content-length'] ?? 0);
          if (!String(headers['content-type'] ?? '').includes('application/json')
            || !Number.isSafeInteger(length) || length < 0 || length > MAX_BODY) {
            entry.error = 'unsupported or oversized tracking response';
          } else {
            let body;
            try { body = await bounded(response.body(), Math.max(1, Math.min(timeout(5_000), deadline - Date.now())), 'FedEx response read timed out'); }
            catch { entry.truncated = true; entry.error = 'tracking response could not be read'; }
            if (body && body.length > MAX_BODY) { entry.truncated = true; entry.error = 'tracking response budget exceeded'; }
            else if (body) {
              entry.body = body.toString('utf8');
              try {
                const packages = JSON.parse(entry.body)?.output?.packages;
                const matches = Array.isArray(packages) ? packages.filter(p => p?.trackingNbr === number) : [];
                const errors = matches[0]?.errorList ?? [];
                const placeholder = Array.isArray(errors) && errors.some(error => /TRACKINGNUMBER|NOTFOUND|NO TRACKING|AUTHORIZ|AUTHENTICAT/i.test(error?.code ?? error?.errorCode ?? ''));
                session.verified = matches.length === 1 && Boolean(matches[0].keyStatus || matches[0].keyStatusCD
                  || (Array.isArray(matches[0].scanEventList) && matches[0].scanEventList.length)) && !placeholder;
                rich = session.verified && Array.isArray(matches[0].scanEventList) && matches[0].scanEventList.length > 0;
              } catch { entry.error = 'tracking response could not be read'; }
            }
          }
        }
        entries.push(entry);
        lastActivity = Date.now();
        if (entries.length > MAX_REPLIES) entries.shift();
        let bytes = 0;
        for (const kept of entries.slice().reverse()) {
          bytes += Buffer.byteLength(kept.body ?? '');
          if (bytes > 2 * MAX_BODY && kept.body !== null) {
            kept.body = null; kept.truncated = true; kept.error = 'tracking sequence budget exceeded';
          }
        }
      }
      if (!entries.length) throw new Error('FedEx tracking response missing');
      if (replies.length || [...requests].some(request => !responded.has(request))) {
        session.verified = false;
        entries.push({ url: API, status: 0, body: null, headers: {}, truncated: false,
          base64Encoded: false, error: 'fedex-tracking-request-failed' });
      }
      // Responses are never cached. Retaining this context retains only the
      // browser session; every lookup submits and captures its own request.
      const html = await bounded(page.content(), timeout(3_000), 'FedEx page read timed out');
      return { html, capturedResponses: entries.slice(-MAX_REPLIES) };
    } finally {
      page.off('response', onResponse);
      page.off('requestfailed', onFailure);
      page.off('request', onRequest);
    }
  }
}

export const fedexSessions = new FedExSessions();
export const preferredFedExEntry = (entries, domain) => fedexSessions.preferred(entries, domain);
