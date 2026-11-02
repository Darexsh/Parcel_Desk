// Stock TRAWL skips compressed bodies and settles on the first polling reply.
// This compatibility adapter observes the browser's own reply for a few exact
// tracking endpoints, each on its public page with one valid number. Every
// other capture request keeps TRAWL's stock behaviour.
import { attachRoyalMailHistoryCapture, ROYAL_MAIL_OPT_OUT } from './royal-mail-history.mjs';
import { attachSwiftxSlider } from './swiftx-slider.mjs';
import { attachUspsTrackingCapture } from './usps-tracking.mjs';

// TRAWL drops a result that arrives at its request deadline. End a capture's
// waits before it, so the replies already observed are still returned.
export function reserveDeadline(capture, reserveMs) {
  const early = budgetMs => Math.max(0, budgetMs - reserveMs);
  return { ...capture,
    // TRAWL asks every capture for a page archive; these keep none.
    archive: capture.archive ?? (() => undefined),
    ...(capture.prepare ? { prepare: budgetMs => capture.prepare(early(budgetMs)) } : {}),
    settle: budgetMs => capture.settle(early(budgetMs)) };
}

// Run inside the carrier page: its anonymous tracking API is independent of
// the optional account iframe, which can be challenged while tracking works.
// Public client configuration stays in this context and is never returned.
export async function requestAustraliaPostInPage({ number, budgetMs }) {
  if (location.origin !== 'https://auspost.com.au' || !/^[A-Z0-9]{10,34}$/.test(number)) {
    throw new Error('Australia Post lookup context is invalid');
  }
  if (!(budgetMs > 0)) throw new Error('Australia Post lookup budget exhausted');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(budgetMs, 15_000));
  try {
    const modules = [...document.querySelectorAll('script[type="module"][src]')]
      .map(script => new URL(script.src, location.href))
      .filter(url => url.origin === location.origin && /^\/mypost\/track\/assets\/index-[\w-]+\.js$/.test(url.pathname)
        && !url.search && !url.hash);
    if (modules.length !== 1) throw new Error('Australia Post application module is missing or ambiguous');
    const bundle = await fetch(modules[0].href, { signal: controller.signal, credentials: 'same-origin', redirect: 'error' });
    if (!bundle.ok || !bundle.body || Number(bundle.headers.get('content-length')) > 4_000_000) {
      await bundle.body?.cancel();
      throw new Error('Australia Post application module is unavailable');
    }
    const reader = bundle.body.getReader();
    const decoder = new TextDecoder();
    let source = '';
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4_000_000) {
          await reader.cancel();
          throw new Error('Australia Post application module exceeds its size limit');
        }
        source += decoder.decode(value, { stream: true });
      }
      source += decoder.decode();
    } finally { reader.releaseLock(); }
    const matches = [...source.matchAll(/\bshipmentsGateway:"([A-Za-z0-9._-]{16,200})"/g)];
    if (matches.length !== 1) throw new Error('Australia Post anonymous client configuration changed');
    const api = new URL('https://digitalapi.auspost.com.au/shipments-gateway/v1/watchlist/shipments');
    api.searchParams.set('trackingIds', number);
    await fetch(api.href, { credentials: 'include', redirect: 'error', signal: controller.signal,
      headers: { 'api-key': matches[0][1], 'Content-Type': 'application/json', AP_CHANNEL_NAME: 'WEB_DETAIL' } });
  } finally { clearTimeout(timer); }
}

const SITES = [
  {
    api: 'https://mydhl.express.dhl/shipmentTracking',
    provider: 'DHL Express',
    allowTextResponse: true,
    requestMethod: 'GET',
    apiForNumber(number) {
      return this.api + '?' + new URLSearchParams({ AWB: number, clientApp: 'mydhlplus', countryCode: 'gb', languageCode: 'en',
        requestAdditionalDetails: 'controlledAccessDataCodes,productCode,shipmentActivationDate,countryCodes' }).toString().replace(/%2C/g, ',');
    },
    number(page) {
      if (page.origin !== 'https://mydhl.express.dhl' || page.pathname !== '/gb/en/tracking.html' || page.search) return null;
      return /^#\/results\?id=(\d{10})$/.exec(page.hash)?.[1] ?? null;
    },
    settled(data, number) {
      return data?.results?.some(result => result.id === number) || data?.errors?.some(error => error.id === number);
    },
  },
  {
    api: 'https://services.yuntrack.com/Track/Query',
    provider: 'YunExpress',
    requestMethod: 'POST',
    number(page) {
      if (page.origin !== 'https://www.yuntrack.com' || page.pathname !== '/parcelTracking' || page.hash) return null;
      const values = [...page.searchParams];
      return values.length === 1 && values[0][0] === 'id' && /^YT\d{16}$/.test(values[0][1]) ? values[0][1] : null;
    },
    requestMatches(request, number) {
      try {
        const body = request.postDataJSON();
        return Array.isArray(body?.NumberList) && body.NumberList.length === 1 && body.NumberList[0] === number;
      } catch { return false; }
    },
    settled() {
      // One posted parcel, one final envelope. The adapter binds both returned
      // identities and validates even a decoded null, array or primitive root.
      return true;
    },
  },
  {
    // The page passes Cloudflare's check, then posts one batch GraphQL query
    // for the number in its address, with its Turnstile token, and gets a
    // compressed JSON reply.
    api: 'https://swiftx-express.com/api/graphql',
    provider: 'SwiftX',
    requestMethod: 'POST',
    number(page) {
      if (page.origin !== 'https://swiftx-express.com' || page.pathname !== '/track' || page.hash) return null;
      const values = [...page.searchParams];
      return values.length === 1 && values[0][0] === 'trackingNumber' && /^SWX\d{18}$/.test(values[0][1]) ? values[0][1] : null;
    },
    requestMatches(request, number) {
      try {
        const body = request.postDataJSON();
        const input = body?.variables?.input;
        return typeof body?.query === 'string' && /\bgetOfficialWebsiteTrackingInfoBatch\b/.test(body.query)
          && input && typeof input === 'object' && Object.keys(input).every(key => ['trackingNos', 'humanToken', 'sliderToken',
            'phoneLast4', 'unlockToken', 'unlockScope'].includes(key))
          && ['phoneLast4', 'unlockToken', 'unlockScope'].every(key => input[key] == null)
          && Array.isArray(input.trackingNos) && input.trackingNos.length === 1 && input.trackingNos[0] === number;
      } catch { return false; }
    },
    settled() {
      // One query, one final reply. The adapter binds the returned number and
      // reads the not-found notice itself.
      return true;
    },
    sanitize(data) {
      const batch = data?.data?.getOfficialWebsiteTrackingInfoBatch;
      if (batch && typeof batch === 'object') {
        delete batch.unlockToken;
        delete batch.unlockTokenExpiresInSeconds;
      }
    },
    setup(page, number, state, options) { state.slider = attachSwiftxSlider(page, number, { signal: options.budget?.signal }); },
    async prepare(page, number, budgetMs, { state, hasTrackingRequest, refuse }) {
      await state.slider.prepare(budgetMs, hasTrackingRequest, refuse);
    },
    settleAfterPrepare: false,
    cleanup(state) { state.slider?.dispose(); },
  },
  {
    api: 'https://digitalapi.auspost.com.au/shipments-gateway/v1/watchlist/shipments',
    queryNumber: true,
    number(page) {
      if (page.origin !== 'https://auspost.com.au' || page.search || page.hash) return null;
      return /^\/mypost\/track\/details\/([A-Z0-9]{10,34})\/?$/.exec(page.pathname)?.[1] ?? null;
    },
    settled(data, number) {
      return Array.isArray(data) && data.some(item => Array.isArray(item?.trackingIds) && item.trackingIds.includes(number));
    },
    async prepare(page, number, budgetMs) {
      await page.evaluate(requestAustraliaPostInPage, { number, budgetMs });
    },
  },
  {
    api: 'https://postal.ninja/track/get',
    checkApi: 'https://postal.ninja/track/check',
    number(page) {
      if (page.origin !== 'https://postal.ninja' || page.pathname !== '/en/tools' || page.search) return null;
      // Private integration marker, not an upstream tracking deep link.
      return /^#trawl-number=((?=[A-Z0-9]*\d)[A-Z0-9]{4,40})$/.exec(page.hash)?.[1] ?? null;
    },
    settled(data, number, state) {
      if (data?.status === 'PROCESSING' && data.tc === number && typeof data.hid === 'string' && data.hid) state.handle = data.hid;
      if (data?.status === 'CHLNG_REQ') return data.tc === number || Boolean(state.handle && data.hid === state.handle);
      if (data?.status === 'UNTRACEABLE') return data.tc === number;
      const found = data?.status === 'FOUND' && data.track?.tc === number
        && typeof data.hid === 'string' && data.hid && data.track.hid === data.hid;
      if (found && !data.inProgress && /^[A-Za-z0-9_-]{1,100}$/.test(data.hid)
        && !Array.isArray(data.track.events) && (data.track.firstEv || data.track.lastEv)) {
        // This is the normal results route emitted by Postal Ninja's own URL
        // builder. Its page requests full history using the verified handle.
        state.resultUrl = `https://postal.ninja/en/track#/${data.hid}`;
      }
      return found && !data.inProgress;
    },
    async prepare(page, number, budgetMs) {
      const deadline = Date.now() + Math.max(0, Math.min(budgetMs, 15_000));
      const timeout = () => {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('Postal Ninja form preparation timed out');
        return left;
      };
      const form = page.frameLocator('iframe[title="Package tracking widget"]').locator('form.tracker');
      await form.locator('input[type="text"]').fill(number, { timeout: timeout() });
      const save = form.locator('input[type="checkbox"]');
      if (await save.count()) await save.uncheck({ timeout: timeout() });
      // Run the normal form handler, including its Turnstile execution and
      // request signing. Tokens stay inside this isolated browser context.
      const submitted = await form.locator('button[type="submit"]').evaluate((element, expected) => {
        if (element.form?.querySelector('input[type="text"]')?.value !== expected || element.disabled) return false;
        element.click();
        return true;
      }, number, { timeout: timeout() });
      if (!submitted) throw new Error('Postal Ninja form was not ready for submission');
    },
  },
  {
    // 17TRACK polls: keep reading until a completed reply names the number.
    api: 'https://t.17track.net/track/restapi',
    provider: '17TRACK',
    requestMethod: 'POST',
    number(page) {
      if (page.origin !== 'https://t.17track.net' || page.pathname !== '/en') return null;
      const number = new URLSearchParams(page.hash.slice(1)).get('nums');
      return number && /^[A-Z0-9]{5,40}$/.test(number) ? number : null;
    },
    requestMatches(request, number) {
      try {
        const body = request.postDataJSON();
        return Array.isArray(body?.data) && body.data.length === 1 && body.data[0]?.num === number;
      } catch { return false; }
    },
    postcodeSubmitted(request, target) {
      const postcode = new URLSearchParams(target.hash.slice(1)).get('trawl-postcode');
      try { return Boolean(postcode && request.postDataJSON().data[0]?.params_v2?.postal_code === postcode); }
      catch { return false; }
    },
    prepareFor(target) {
      const values = new URLSearchParams(target.hash.slice(1)).getAll('trawl-postcode');
      return values.length === 1 && /^[A-Z0-9][A-Z0-9 -]{0,13}[A-Z0-9]$/.test(values[0]);
    },
    async setup(page) {
      // The first-visit tour replaces the real result with a demo shipment.
      // Skip that optional presentation before the application mounts.
      await page.addInitScript(() => {
        if (location.origin === 'https://t.17track.net') localStorage.setItem('tourDone', JSON.stringify('true'));
      });
    },
    settled(data, number, state) {
      const shipment = data.shipments?.find(s => s.number === number && s.code !== 100);
      state.postcodeOffered = data.meta?.code === 200 && shipment?.code === 400 && shipment.shipment === null
        && Array.isArray(shipment.params_v2) && shipment.params_v2.some(p => p?.key === 'postal_code');
      return data.meta?.code !== 200 || data.shipments?.some(s => s.number === number && s.code !== 100);
    },
    async prepare(page, number, budgetMs, { state, target, settle, restart }) {
      const deadline = Date.now() + Math.max(0, budgetMs);
      const timeout = () => {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('17TRACK postcode submission timed out');
        return left;
      };
      await settle(timeout());
      if (!state.postcodeOffered || state.postcodeAttempted) return;
      state.postcodeAttempted = true;
      try {
        // Use the website's form handler so its fingerprint, request signing,
        // detected carriers and subsequent polling all carry the same input.
        await page.getByText(number, { exact: true }).first().waitFor({ state: 'visible', timeout: timeout() });
        await page.getByText('reference', { exact: true }).click({ timeout: timeout() });
        const dialog = page.getByRole('dialog');
        await dialog.locator('input[name="postal_code"]').fill(new URLSearchParams(target.hash.slice(1)).get('trawl-postcode'), { timeout: timeout() });
        restart();
        await dialog.locator('button[type="submit"]').click({ timeout: timeout() });
      } catch { throw new Error('17TRACK postcode form could not complete'); }
    },
  },
  {
    // Akamai accepts UPS tracking only from the session the page established,
    // which is why replies are read here and never replayed.
    api: 'https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US',
    provider: 'UPS',
    requestMethod: 'POST',
    keepLatestCaptures: true,
    number(page) {
      if (page.origin !== 'https://www.ups.com' || page.pathname !== '/track') return null;
      const number = (page.searchParams.get('tracknum') ?? '').toUpperCase();
      return /^1Z[A-Z0-9]{16}$/.test(number) ? number : null;
    },
    requestMatches(request, number) {
      try {
        const body = request.postDataJSON();
        const values = body?.TrackingNumber;
        return Array.isArray(values) && values.length === 1 && typeof values[0] === 'string'
          && /^1Z[A-Z0-9]{16}$/i.test(values[0]) && values[0].toUpperCase() === number;
      } catch { return false; }
    },
    settled(data, number) {
      const details = Array.isArray(data.trackDetails) ? data.trackDetails : [];
      return String(data.statusCode) !== '200' || details.length === 0
        || details.some(d => String(d?.trackingNumber ?? d?.requestedTrackingNumber ?? '').toUpperCase() === number);
    },
  },
  {
    // FedEx answers once. The edge accepts this call only from the session
    // the page established, which is why the reply is read here and never
    // replayed. The page redirects its canonical /fedextrack/ URL to the
    // /wtrk/track/ application, so both pathnames serve the same lookup.
    api: 'https://api.fedex.com/track/v2/shipments',
    number(page) {
      if (page.origin !== 'https://www.fedex.com') return null;
      if (page.pathname !== '/wtrk/track/' && page.pathname !== '/fedextrack/') return null;
      const number = (page.searchParams.get('trknbr') ?? '').toUpperCase();
      return /^(\d{12}|\d{15}|\d{20})$/.test(number) ? number : null;
    },
    settled(data) {
      // One POST, one final reply: any decoded envelope ends the wait. The
      // adapter binds the packages to the requested number itself.
      return !!data?.output;
    },
  },
  {
    // The hash route can start tracking with consent already recorded;
    // otherwise submit the form after any consent-triggered reload.
    api: 'https://api-web.royalmail.com/mailpieces/microsummary/v1/summary/',
    perNumber: true,
    number(page) {
      if (page.origin !== 'https://www.royalmail.com' || page.pathname !== '/track-your-item') return null;
      const number = (/^#\/tracking-results\/([A-Z0-9]+)\/?$/.exec(page.hash)?.[1] ?? '');
      return /^[A-Z]{2}\d{9}GB$/.test(number) ? number : null;
    },
    settled(data, number, state, status) {
      // The page retries E0015 with a new CAPTCHA token when its existing API
      // session is rejected. Keep that first reply for diagnosis, but allow
      // one automatic refresh within the normal capture deadline.
      if (status === 401 && !state.challengeRefresh
        && Array.isArray(data?.errors)
        && data.errors.some(error => error?.errorCode === 'E0015' || error?.code === 'E0015')) {
        state.challengeRefresh = true;
        return false;
      }
      // Other replies are final; the adapter verifies the mailpiece identity.
      return !!data && typeof data === 'object';
    },
  },
];

const NETWORK_ERRORS = new Set([
  'NS_ERROR_NET_RESET', 'NS_ERROR_NET_TIMEOUT', 'NS_ERROR_UNKNOWN_HOST',
  'net::ERR_CONNECTION_RESET', 'net::ERR_HTTP2_PROTOCOL_ERROR', 'net::ERR_TIMED_OUT',
]);

export async function attachTrackingCapture(page, url, options) {
  const usps = attachUspsTrackingCapture(page, url, options);
  if (usps) return usps;
  const history = await attachRoyalMailHistoryCapture(page, url, options);
  if (history) return history;
  const target = new URL(url);
  const requested = options.captureResponses ?? [];
  const site = SITES.find(candidate => candidate.number(target)
    && (!candidate.checkApi || requested.includes(candidate.checkApi))
    && (candidate.queryNumber
      ? requested.includes(`${candidate.api}?trackingIds=${candidate.number(target)}`)
      : candidate.perNumber
      ? requested.includes(candidate.api + candidate.number(target))
      : requested.includes(candidate.api)));
  if (!site) return undefined;
  const number = site.number(target);
  const state = {};
  if (site.setup && (!site.prepareFor || site.prepareFor(target))) await site.setup(page, number, state, options);
  const api = site.apiForNumber ? site.apiForNumber(number)
    : site.api + (site.queryNumber ? `?trackingIds=${number}` : site.perNumber ? number : '');
  if (site.perNumber) {
    await page.context().addCookies(Object.entries(ROYAL_MAIL_OPT_OUT).map(([name, value]) => ({
      name, value, domain: '.royalmail.com', path: '/', secure: true, sameSite: 'Lax',
    })));
  }
  const entries = [];
  let terminal = false;
  let trackingRequested = false;
  let networkError;
  let accepting = true;
  let count = 0;
  let bodyReads = 0;
  let bytes = 0;
  let finish;
  const restart = () => {
    terminal = false;
    return new Promise(resolve => { finish = () => { terminal = true; resolve(); }; });
  };
  let ready = restart();
  const settle = async budgetMs => {
    let timer;
    try {
      await Promise.race([ready, new Promise(resolve => {
        timer = setTimeout(resolve, Math.max(0, Math.min(budgetMs, options.settleTimeout ?? 15_000, 30_000)));
      })]);
    } finally { clearTimeout(timer); }
  };
  const observesRequests = site.perNumber || site.queryNumber || site.requestMethod;
  const matchesRequest = request => accepting && request.url() === api
    && request.method() === (site.requestMethod ?? 'GET')
    && (!site.requestMatches || site.requestMatches(request, number));
  const onRequest = request => { if (matchesRequest(request)) trackingRequested = true; };
  const onRequestFailed = request => {
    if (!matchesRequest(request)) return;
    const code = request.failure()?.errorText;
    networkError = NETWORK_ERRORS.has(code) ? code : 'network failure';
    finish();
  };
  const onResponse = async response => {
    if (!accepting || (response.url() !== api && response.url() !== site.checkApi)
      || (site.requestMethod && !matchesRequest(response.request()))
      || (site.checkApi && response.request().method() !== 'POST')
      || ((site.perNumber || site.queryNumber) && response.request().method() !== 'GET')) return;
    if (!site.keepLatestCaptures && ++count > 20) return;
    // A later matching response can recover a failed UPS request. Until then,
    // drain must not let an older successful response conceal that failure.
    if (site.keepLatestCaptures) networkError = undefined;
    const headers = response.headers();
    const entry = { url: response.url(), status: response.status(), body: null,
      headers: headers['retry-after'] ? { 'retry-after': headers['retry-after'].slice(0, 100) } : {},
      truncated: false, base64Encoded: false };
    if (site.postcodeSubmitted?.(response.request(), target)) entry.postcodeSubmitted = true;
    entries.push(entry);
    // UPS retries can arrive after the old capture limit. Keep their arrival
    // order and latest metadata, including refusals whose bodies are private.
    if (site.keepLatestCaptures && entries.length > 20) entries.shift();
    if (entry.status !== 200 && !site.perNumber) { finish(); return; }
    const type = headers['content-type'] ?? '';
    const length = headers['content-length'] === undefined ? 0 : Number(headers['content-length']);
    // The browser already decoded this response for the site. Do not implement
    // our own decompressor, fetch again or transfer the session to Node.
    if ((!type.includes('application/json') && !site.allowTextResponse) || !Number.isSafeInteger(length)
      || length < 0 || length > 2_000_000 || bytes >= 4_000_000) {
      entry.error = 'unsupported or oversized tracking response'; finish(); return;
    }
    // Rolling metadata must not create unbounded body reads during a burst.
    // An unreadable latest 200 stays explicit; later HTTP refusals still win.
    if (site.keepLatestCaptures && bodyReads >= 20) {
      entry.error = 'tracking response extraction limit exceeded'; finish(); return;
    }
    try {
      if (site.keepLatestCaptures) bodyReads += 1;
      const body = await response.body();
      if (!accepting) return;
      bytes += body.length;
      if (body.length > 2_000_000 || bytes > 4_000_000) {
        entry.truncated = true; entry.error = 'tracking response budget exceeded'; finish(); return;
      }
      entry.body = body.toString('utf8');
      if (site.allowTextResponse && /^\s*</.test(entry.body)) { finish(); return; }
      const data = JSON.parse(entry.body);
      if (site.sanitize) { site.sanitize(data); entry.body = JSON.stringify(data); }
      // Preserve intermediate replies for diagnosis, but let the website carry
      // on until it holds a final reply for exactly the requested number.
      if (site.settled(data, number, state, entry.status)) finish();
    } catch {
      entry.error = 'tracking response could not be read';
      if (site.requestMethod) finish();
    }
  };
  page.on('response', onResponse);
  if (observesRequests) {
    page.on('request', onRequest);
    page.on('requestfailed', onRequestFailed);
  }
  return {
    // Called by both TRAWL browser tiers after navigation and before solving.
    ...(site.prepare && (!site.prepareFor || site.prepareFor(target)) ? { async prepare(budgetMs) {
      const deadline = Date.now() + Math.max(0, budgetMs);
      await site.prepare(page, number, Math.max(0, deadline - Date.now()), { state, target, settle,
        restart: () => { ready = restart(); }, hasTrackingRequest: () => trackingRequested,
        refuse({ status, retryAfter }) {
          if (entries.length >= 20) entries.shift();
          entries.push({ url: api, status, body: null, headers: retryAfter ? { 'retry-after': String(retryAfter).slice(0, 100) } : {},
            truncated: false, base64Encoded: false, error: 'verification refused' });
          finish();
        } });
      if (site.settleAfterPrepare === false) return;
      await settle(deadline - Date.now());
      if (!state.resultUrl || deadline - Date.now() < 1000) return;
      // Reuse this browser context: the main form has a separate verification
      // gate, but an established parcel's normal results page loads its full
      // history directly. Reset settlement so the compact reply cannot end
      // the new capture phase before that history arrives.
      ready = restart();
      await page.goto(state.resultUrl, {
        waitUntil: 'domcontentloaded', timeout: Math.min(15_000, deadline - Date.now()),
      });
    } } : {}),
    ...(site.perNumber ? { async prepare(budgetMs) {
      const deadline = Date.now() + Math.max(0, Math.min(budgetMs, 15_000));
      const timeout = () => {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('Royal Mail form preparation timed out');
        return left;
      };
      const awaitReply = async () => {
        let timer;
        try { await Promise.race([ready, new Promise(resolve => {
          timer = setTimeout(resolve, Math.min(timeout(), 5_000));
        })]); } finally { clearTimeout(timer); }
      };
      // With opt-out preferences already present, the hash route can start
      // the lookup itself. Avoid submitting a second challenge/request.
      if (trackingRequested) { await awaitReply(); return; }
      const input = page.locator('#barcode-input');
      await input.waitFor({ state: 'visible', timeout: timeout() });
      // TrustArc can arrive after the app mounts. Dismiss optional cookies
      // before clicking, and handle a banner that appears during that click.
      const decline = page.getByText('Decline all', { exact: true });
      await decline.waitFor({ state: 'visible', timeout: Math.min(timeout(), 3_000) }).catch(() => {});
      if (await decline.isVisible()) {
        // TrustArc can reload the document after consent changes. Typing
        // before that reload finishes fills the outgoing form, while submit
        // resolves against a new, empty form and never triggers hCaptcha.
        const reloaded = page.waitForEvent('domcontentloaded', {
          timeout: Math.min(timeout(), 3_000),
        }).catch(() => {});
        await decline.evaluate(element => element.click());
        await reloaded;
        await input.waitFor({ state: 'visible', timeout: timeout() });
      }
      if (trackingRequested) { await awaitReply(); return; }
      // Native key events update React's controlled state even after the
      // hash route prefilled it. A DOM-only fill can leave stale form state.
      await input.press('ControlOrMeta+A', { timeout: timeout() });
      await input.press('Backspace', { timeout: timeout() });
      await input.pressSequentially(number, { timeout: timeout(), delay: 30 });
      if (await input.inputValue() !== number) throw new Error('Royal Mail input was reset before submission');
      // Camoufox's humanized mouse action can stall after reaching the button.
      // Invoke the page's normal click handler; it still runs its validation
      // and hCaptcha callback before making any tracking request.
      const submit = page.locator('#submit:not(:disabled)');
      await submit.waitFor({ state: 'visible', timeout: timeout() });
      if (trackingRequested) { await awaitReply(); return; }
      const submitted = await submit.evaluate((element, expected) => {
        // Check and click in one document: a late reload must not turn a
        // locally validated number into an empty submission.
        if (element.ownerDocument.querySelector('#barcode-input')?.value !== expected) return false;
        element.click();
        return true;
      }, number);
      if (!submitted) throw new Error('Royal Mail input was reset before submission');
      // Invisible hCaptcha commonly auto-passes after submit. Its callback
      // sends the API request and resets the widget; do not click it again.
      await awaitReply();
    } } : {}),
    hasResponse() { return Boolean(((site.checkApi || site.queryNumber || site.requestMethod) && terminal) || (site.perNumber && entries.some(entry => entry.body !== null || entry.status !== 200))); },
    // Royal Mail can use an existing API session or a fresh CAPTCHA token.
    // Once the lookup starts, let its own refresh callback handle E0015.
    hasTrackingRequest() { return Boolean((site.checkApi && state.handle) || (observesRequests && trackingRequested)); },
    async settle(budgetMs) {
      if (site.postcodeSubmitted && site.prepareFor(target) && !state.postcodeAttempted) {
        const deadline = Date.now() + Math.max(0, budgetMs);
        await site.prepare(page, number, budgetMs, { state, target, settle, restart: () => { ready = restart(); } });
        await settle(Math.max(0, deadline - Date.now()));
      } else await settle(budgetMs);
    },
    async drain() {
      site.cleanup?.(state);
      accepting = false;
      page.off('response', onResponse);
      if (observesRequests) {
        page.off('request', onRequest);
        page.off('requestfailed', onRequestFailed);
      }
      // A loaded app shell is not a successful tracking session. Let the
      // orchestrator invalidate cached cookies and try its fresh browser tier.
      if (observesRequests && (entries.length === 0 || site.keepLatestCaptures && networkError)) {
        const provider = site.provider ?? (site.queryNumber ? 'Australia Post' : 'Royal Mail');
        if (networkError) throw new Error(`${provider} tracking request failed: ${networkError}`);
        throw new Error(`${provider} produced no tracking response after submission`);
      }
      return { capturedResponses: entries.map(entry => ({ ...entry })) };
    },
  };
}
