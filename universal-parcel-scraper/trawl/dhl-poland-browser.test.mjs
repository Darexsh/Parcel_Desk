import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dhlPolandBrowserNumber, dhlPolandHistory, runDhlPolandBrowser } from './dhl-poland-browser.mjs';
import { createRecaptchaAudioBackoff } from './recaptcha-backoff.mjs';

const number = '99999999990';
const endpoint = 'https://sprawdz.dhl.com.pl/';
const url = `${endpoint}?sn=${number}&lang=en-gb`;
const capture = { captureResponses: [endpoint] };
const html = `<html><textarea name="g-recaptcha-response">PRIVATE</textarea><div class="trackHead"><b class="dhl_black_color">${number}</b></div>
<div id="addit_infoHead"><div class="topBotPads15"><div>04.03.2026</div><div>10:15</div><div>Example depot</div>
<div>Delivered to customer. The shipment received by PRIVATE</div></div></div><input value="PRIVATE"></html>`;
const response = (status = 200, body = html, submitted = number) => ({ url: () => endpoint, status: () => status,
  request: () => ({ method: () => 'POST', postData: () => `SearchMode=Shipment&ShipmentNumbers=${submitted}&g-recaptcha-response=PRIVATE` }),
  headers: () => ({ 'content-type': 'text/html', 'set-cookie': 'PRIVATE' }), body: async () => Buffer.from(body) });
function fixture() {
  const diagnostics = [];
  const interactions = { checkbox: 0 };
  const handlers = {}, state = { closed: 0, submitted: 0, policy: 0 };
  const page = { on: (event, fn) => { handlers[event] = fn; }, off: event => { delete handlers[event]; },
    goto: async () => ({ status: () => 200 }), waitForTimeout: async () => {},
    frameLocator: () => ({ first: () => ({ locator: selector => ({
      click: async () => { assert.equal(selector, '#recaptcha-anchor'); interactions.checkbox++; } }) }) }),
    waitForFunction: async () => {},
    locator: selector => {
      if (selector === '#onetrust-reject-all-handler') return { waitFor: async () => {}, evaluate: async () => {} };
      if (selector === '#sn') return { fill: async value => assert.equal(value, number) };
      if (selector.includes('iframe')) return { first: () => ({ scrollIntoViewIfNeeded: async () => {} }) };
      if (selector === '#g-recaptcha-response') return { inputValue: async () => 'PRIVATE' };
      return { click: async () => { state.submitted++; handlers.response(response()); } };
    },
  };
  const options = { url, capture, tier: 3, maxTimeout: 1000, audioBackoff: createRecaptchaAudioBackoff(), logDiagnostic: record => diagnostics.push(record),
    handle: { browser: { newContext: async () => ({ newPage: async () => page, close: async () => { state.closed++; } }) } },
    installPolicy: async () => { state.policy++; },
  };
  return { options, handlers, state, page, diagnostics, interactions };
}
test('only the exact carrier URL, canonical waybill and capture endpoint select the helper', () => {
  assert.equal(dhlPolandBrowserNumber(url, capture), number);
  for (const candidate of [url + '#x', url + '&sn=' + number, url.replace(number, 'JJD00000000000000000'),
    url.replace('sprawdz.dhl.com.pl', 'other.test'), url.replace('sprawdz.dhl.com.pl', 'user@sprawdz.dhl.com.pl')]) {
    assert.equal(dhlPolandBrowserNumber(candidate, capture), null);
  }
});
test('native verification owns the initial checkbox and requires the page proof before submitting', async () => {
  const active = fixture(); active.options.maxTimeout = 60000;
  let proof = '';
  const original = active.page.locator;
  active.page.locator = selector => selector === '#g-recaptcha-response' ? { inputValue: async () => proof } : original(selector);
  active.options.solveNativeCaptcha = async (_page, budget, report) => {
    assert.ok(budget > 0 && budget <= 30000);
    report('audio_started'); report('PRIVATE'); report('audio_verified'); proof = 'PRIVATE';
    return true;
  };
  const result = await runDhlPolandBrowser(active.options);
  assert.equal(result.capturedResponses.length, 1);
  assert.equal(active.interactions.checkbox, 0);
  assert.deepEqual(active.diagnostics[0].native, ['audio_started', 'audio_verified']);
  assert.equal(active.diagnostics[0].verification, 'native');
  assert.equal(JSON.stringify(active.diagnostics).includes('PRIVATE'), false);
  proof = '';
  active.options.solveNativeCaptcha = async () => true;
  await runDhlPolandBrowser(active.options);
  assert.equal(active.state.submitted, 1);
});
test('failed native solving retains a challenge without submitting the form', async () => {
  const active = fixture(); active.options.maxTimeout = 15000;
  let proof = '';
  const original = active.page.locator;
  active.page.locator = selector => selector === '#g-recaptcha-response' ? { inputValue: async () => proof } : original(selector);
  active.options.solveNativeCaptcha = async (_page, _budget, report) => { report('audio_blocked'); return false; };
  const result = await runDhlPolandBrowser(active.options);
  assert.equal(result.capturedResponses.length, 0);
  assert.equal(active.state.submitted, 0);
  assert.equal(active.state.closed, 1);
  assert.deepEqual(active.interactions, { checkbox: 0 });
  assert.equal(active.diagnostics[0].outcome, 'challenge');
  assert.equal(active.diagnostics[0].verification, 'unverified');
  assert.deepEqual(active.diagnostics[0].native, ['audio_blocked']);
});
test('a shared block skips audio on later pages, retains challenge and permits an already verified form', async () => {
  const backoff = createRecaptchaAudioBackoff(); backoff.block();
  const active = fixture(); active.options.audioBackoff = backoff;
  const original = active.page.locator;
  active.page.locator = selector => selector === '#g-recaptcha-response' ? { inputValue: async () => '' } : original(selector);
  let solves = 0;
  active.options.solveNativeCaptcha = async () => { solves++; return true; };
  const result = await runDhlPolandBrowser(active.options);
  assert.equal(solves, 0); assert.equal(active.state.submitted, 0); assert.equal(active.state.closed, 1);
  assert.equal(result.capturedResponses.length, 0);
  assert.deepEqual(active.diagnostics[0].native, ['audio_cooldown']);
  assert.equal(active.diagnostics[0].outcome, 'challenge');
  const verified = fixture(); verified.options.audioBackoff = backoff;
  verified.options.solveNativeCaptcha = async () => { solves++; return true; };
  assert.equal((await runDhlPolandBrowser(verified.options)).capturedResponses.length, 1);
  assert.equal(solves, 0); assert.equal(verified.diagnostics[0].verification, 'checkbox');
});
test('a stalled native solver is stopped by the browser deadline and closes its context', async () => {
  const active = fixture(); active.options.maxTimeout = 30;
  active.options.solveNativeCaptcha = () => new Promise(() => {});
  await runDhlPolandBrowser(active.options);
  assert.equal(active.state.closed, 1); assert.equal(active.state.submitted, 0);
  assert.equal(active.diagnostics[0].outcome, 'deadline');
});
test('a restored shared pause is awaited before DHL Poland asks for audio', async () => {
  const active = fixture();
  active.options.audioBackoff = createRecaptchaAudioBackoff(() => 1000, { load: async () => 21601000 });
  const original = active.page.locator;
  active.page.locator = selector => selector === '#g-recaptcha-response' ? { inputValue: async () => '' } : original(selector);
  let solves = 0;
  active.options.solveNativeCaptcha = async () => { solves++; return true; };
  await runDhlPolandBrowser(active.options);
  assert.equal(solves, 0);
  assert.equal(active.state.submitted, 0);
  assert.deepEqual(active.diagnostics[0].native, ['audio_cooldown']);
});
test('extracts only safe history fields and identifies an unresolved verification form', () => {
  assert.deepEqual(dhlPolandHistory(html), { number, events: [{ date: '04.03.2026', time: '10:15',
    location: 'Example depot', description: 'Delivered to customer.' }] });
  assert.deepEqual(dhlPolandHistory('<div class="g-recaptcha">PRIVATE</div>'), { challenge: true });
  assert.equal(JSON.stringify(dhlPolandHistory(html.replace('The shipment received by PRIVATE', 'Przesyłka odebrana przez PRIVATE'))).includes('PRIVATE'), false);
  assert.deepEqual(dhlPolandHistory(html.replace('</html>', '<div class="trackHead"><b class="dhl_black_color">99999999991</b></div></html>')), { challenge: true });
});
test('observes before navigation, submits through the verified form and closes its context', async () => {
  const active = fixture(); const result = await runDhlPolandBrowser(active.options);
  assert.equal(result.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.deepEqual(active.state, { closed: 1, submitted: 1, policy: 1 });
  assert.deepEqual(active.handlers, {});
  assert.equal(active.diagnostics.length, 1);
  assert.equal(active.diagnostics[0].outcome, 'history');
  assert.equal(active.diagnostics[0].cleanup, 'closed');
  for (const privateValue of ['PRIVATE', number, endpoint, 'Example depot']) assert.equal(JSON.stringify(active.diagnostics).includes(privateValue), false);
});
test('diagnostics retain the failure phase and never propagate observer failures', async () => {
  const active = fixture();
  active.page.goto = async () => { throw new Error('PRIVATE'); };
  await runDhlPolandBrowser(active.options);
  assert.equal(active.diagnostics[0].phase, 'navigation');
  assert.equal(active.diagnostics[0].outcome, 'browser_error');
  assert.equal(JSON.stringify(active.diagnostics).includes('PRIVATE'), false);
  active.options.logDiagnostic = () => { throw new Error('PRIVATE'); };
  assert.equal((await runDhlPolandBrowser(active.options)).status, 'error');
});
test('native traces are bounded and contain only fixed diagnostic events', async () => {
  const active = fixture(); active.options.maxTimeout = 10000;
  const original = active.page.locator;
  active.page.locator = selector => selector === '#g-recaptcha-response' ? { inputValue: async () => '' } : original(selector);
  active.options.solveNativeCaptcha = async (_page, _budget, report) => {
    for (let i = 0; i < 100; i++) { report('PRIVATE'); report('audio_started'); }
  };
  await runDhlPolandBrowser(active.options);
  const record = active.diagnostics[0];
  assert.equal(record.native.length, 16);
  assert.ok(record.native.every(event => event === 'audio_started'));
  assert.equal(JSON.stringify(record).includes('PRIVATE'), false);
  assert.equal(record.outcome, 'challenge');
});
test('failed widget diagnostics cannot delay context cleanup beyond the budget', async () => {
  const active = fixture(); active.options.maxTimeout = 30;
  active.page.goto = async () => { const error = new Error('PRIVATE'); error.name = 'TimeoutError'; throw error; };
  active.page.evaluate = () => new Promise(() => {});
  const started = performance.now();
  await runDhlPolandBrowser(active.options);
  assert.ok(performance.now() - started < 150);
  assert.equal(active.state.closed, 1);
  assert.equal(active.diagnostics[0].failure, 'timeout');
  assert.equal(active.diagnostics[0].widget, null);
});
test('rejects prefix matches and repeated form fields, keeping a later rejection', async () => {
  const active = fixture(); const original = active.page.locator;
  active.page.locator = selector => selector !== '#searchSubmit' ? original(selector) : { click: async () => {
    active.handlers.response(response(200, html, '0' + number));
    active.handlers.response(response(200, html, number + '&ShipmentNumbers=' + number));
    active.handlers.response(response()); active.handlers.response(response(403, 'PRIVATE'));
  } };
  const result = await runDhlPolandBrowser(active.options);
  assert.deepEqual(result.capturedResponses.map(row => row.status), [200, 403]);
  assert.equal(active.diagnostics[0].outcome, 'challenge');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('retains oversized or repeated response failures without their content', async () => {
  const active = fixture(); const original = active.page.locator;
  active.page.locator = selector => selector !== '#searchSubmit' ? original(selector) : { click: async () => {
    active.handlers.response(response(200, 'PRIVATE'.repeat(100000)));
  } };
  const result = await runDhlPolandBrowser(active.options);
  assert.equal(result.capturedResponses[0].truncated, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('an unsolved or stalled CAPTCHA cannot submit and cleanup stays within the budget', async () => {
  for (const stall of [false, true]) {
    const active = fixture(); active.options.maxTimeout = 30;
    const original = active.page.locator;
    active.page.locator = selector => selector === '#g-recaptcha-response' ? { inputValue: async () => '' } : original(selector);
    if (stall) active.page.waitForFunction = () => new Promise(() => {});
    const result = await runDhlPolandBrowser(active.options);
    assert.equal(active.state.submitted, 0); assert.equal(active.state.closed, 1);
    assert.deepEqual(result.capturedResponses, []);
    if (stall) assert.equal(active.diagnostics[0].failure, 'timeout');
  }
});
