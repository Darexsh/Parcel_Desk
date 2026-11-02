import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asendiaBrowserNumber, asendiaBrowserPostcode, runAsendiaBrowser } from './asendia-browser.mjs';

const number = 'ASE00000000';
const endpoint = 'https://track.asendia.com/api/1.0/branded-url/branded-parcel-search?sort=shipment_date';
const url = `https://track.asendia.com/track/${number}`;
const capture = { captureResponses: [endpoint] };
const body = JSON.stringify({ context_code: 1000, data: [{ tracking_id: number, status: 'Delivered',
  recipient_name: 'PRIVATE', events: [{ event_time: '2026-01-01T10:00:00Z', harmonized_label: 'Delivered', recipient_email: 'PRIVATE' }] }] });
const response = (status = 200, value = body, ids = [number]) => ({ url: () => endpoint, status: () => status,
  request: () => ({ method: () => 'POST', postDataJSON: () => ({ ids, turnstile_token: 'PRIVATE' }) }),
  headers: () => ({ 'set-cookie': 'PRIVATE' }), body: async () => Buffer.from(value) });
function fixture() {
  const handlers = {}, state = { closed: 0, clicked: 0, policy: 0 };
  const page = { on: (name, fn) => { handlers[name] = fn; }, off: name => { delete handlers[name]; },
    goto: async () => {
      handlers.response({ url: () => 'https://track.asendia.com/api/1.0/fe-tracking-configuration', status: () => 200,
        request: () => ({ method: () => 'GET' }), json: async () => ({ data: { TRACKING: { ENABLE_CAPTCHA: true } } }) });
      return { status: () => 200 };
    },
    getByRole: role => role === 'textbox' ? { inputValue: async () => number } : {
      isEnabled: async () => true, click: async () => { state.clicked++; handlers.response(response()); },
    },
    locator: () => ({ count: async () => 1 }), frames: () => [], waitForTimeout: async () => {},
  };
  const options = { url, capture, tier: 3, maxTimeout: 1000,
    handle: { browser: { newContext: async () => ({ newPage: async () => page, close: async () => { state.closed++; } }) } },
    installPolicy: async () => { state.policy++; },
  };
  return { options, handlers, state, page };
}
test('accepts only the whole identifier on the official page and exact API', () => {
  assert.equal(asendiaBrowserNumber(url, capture), number);
  assert.equal(asendiaBrowserNumber(url + '#trawl-postcode=AB1%202CD', capture), number);
  assert.equal(asendiaBrowserPostcode(url + '#trawl-postcode=AB1%202CD'), 'AB1 2CD');
  for (const candidate of [url + '?extra=1', url + '#extra', url + '#trawl-postcode=', url + '#trawl-postcode=1000&trawl-postcode=2000',
    url + '#trawl-postcode=1000&extra=1', url + '/extra', url.replace(number, 'ONLYLETTERS'),
    url.replace('track.asendia.com', 'example.test'), url.replace('track.asendia.com', 'user@track.asendia.com')]) {
    assert.equal(asendiaBrowserNumber(candidate, capture), null);
  }
  assert.equal(asendiaBrowserNumber(url, { captureResponses: [endpoint + '&extra=1'] }), null);
});
test('submits the page, binds the request and removes recipient and challenge fields', async () => {
  const active = fixture(); const result = await runAsendiaBrowser(active.options);
  assert.equal(result.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.html, ''); assert.equal(result.cookies.length, 0);
  assert.equal(active.state.closed, 1); assert.equal(active.state.clicked, 1); assert.equal(active.state.policy, 1);
  assert.deepEqual(active.handlers, {});
});
test('ignores searches for another identifier or multiple identifiers, retaining a later refusal', async () => {
  const active = fixture();
  active.page.getByRole = role => role === 'textbox' ? { inputValue: async () => number } : {
    isEnabled: async () => true, click: async () => {
      active.handlers.response(response(200, body, ['ASE00000001']));
      active.handlers.response(response(200, body, [number, 'ASE00000001']));
      active.handlers.response(response());
      active.handlers.response(response(403, 'PRIVATE'));
    },
  };
  const result = await runAsendiaBrowser(active.options);
  assert.deepEqual(result.capturedResponses.map(row => [row.status, !!row.body]), [[200, true], [403, false]]);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('does not submit during hydration or manufacture not-found on an unresolved widget', async () => {
  const active = fixture(); active.options.maxTimeout = 20;
  active.page.getByRole = role => role === 'textbox' ? { inputValue: async () => number } : { isEnabled: async () => false };
  active.page.waitForTimeout = ms => new Promise(resolve => setTimeout(resolve, ms));
  const result = await runAsendiaBrowser(active.options);
  assert.equal(active.state.clicked, 0); assert.equal(active.state.closed, 1);
  assert.deepEqual(result.capturedResponses, []);
  const hydration = fixture(); hydration.options.maxTimeout = 20;
  hydration.page.goto = async () => ({ status: () => 200 });
  hydration.page.waitForTimeout = ms => new Promise(resolve => setTimeout(resolve, ms));
  assert.equal((await runAsendiaBrowser(hydration.options)).status, 'error');
  assert.equal(hydration.state.clicked, 0);
});
test('bounds bodies, malformed JSON and repeated requests', async () => {
  for (const [value, truncated] of [['x'.repeat(1_000_001), true], ['invalid json PRIVATE', false]]) {
    const active = fixture();
    active.page.getByRole = role => role === 'textbox' ? { inputValue: async () => number } : {
      isEnabled: async () => true, click: async () => { active.handlers.response(response(200, value)); },
    };
    const result = await runAsendiaBrowser(active.options);
    assert.equal(result.capturedResponses[0].truncated, truncated);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
  const many = fixture();
  many.page.getByRole = role => role === 'textbox' ? { inputValue: async () => number } : {
    isEnabled: async () => true, click: async () => { for (let i = 0; i < 12; i++) many.handlers.response(response(403)); },
  };
  const result = await runAsendiaBrowser(many.options);
  assert.equal(result.capturedResponses.length, 10); assert.match(result.capturedResponses.at(-1).error, /limit/);
});
test('preserves a refused configuration instead of calling it a missing parcel', async () => {
  const active = fixture();
  active.page.goto = async () => {
    active.handlers.response({ url: () => 'https://track.asendia.com/api/1.0/fe-tracking-configuration', status: () => 429 });
    return { status: () => 200 };
  };
  const result = await runAsendiaBrowser(active.options);
  assert.equal(result.statusCode, 429); assert.equal(active.state.clicked, 0);
  assert.deepEqual(result.capturedResponses, []);
});
test('opens the scans through the page dialog with the supplied postcode only when the portal offers it', async () => {
  const locked = JSON.stringify({ context_code: 1000, verification_methods: { postal_code: true, first_name_match: true },
    data: [{ tracking_id: number, status: 'Delivered', recipient_name: 'PRIVATE' }] });
  const verification = (value, postal_code) => ({ ...response(200, value), request: () => ({ method: () => 'POST',
    postDataJSON: () => ({ ids: [number], tracking_id: number, postal_code, turnstile_token: 'PRIVATE' }) }) });
  const run = async (fragment, answer, first = locked) => {
    const active = fixture(); const steps = [];
    active.options.url = url + fragment;
    active.page.goto = (goto => async target => { steps.push(target); return goto(); })(active.page.goto);
    active.page.getByRole = role => role === 'textbox' ? { inputValue: async () => number } : {
      isEnabled: async () => true, click: async () => { active.handlers.response(response(200, first)); },
    };
    active.page.locator = selector => ({ count: async () => 1,
      first() { return this; }, last() { return this; },
      click: async () => { steps.push(selector); if (selector.includes('unlockBtn')) active.handlers.response(answer(steps)); },
      fill: async value => { steps.push(value); } });
    active.page.waitForTimeout = ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 1)));
    return { result: await runAsendiaBrowser(active.options), steps, state: active.state };
  };
  const opened = await run('#trawl-postcode=AB1%202CD', () => verification(body, 'AB1 2CD'));
  assert.deepEqual(opened.steps, [url, '[class*="ctaActionCell"]', 'AB1 2CD', '[class*="VerifyIdentityModal_unlockBtn"]']);
  assert.deepEqual(opened.result.capturedResponses.map(row => row.postcodeSubmitted === true), [false, true]);
  assert.equal(opened.result.effectiveUrl, url);
  assert.deepEqual(JSON.parse(opened.result.capturedResponses[0].body).verification_methods, { postal_code: true });
  assert.equal(JSON.stringify(opened.result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(opened.result).includes('AB1'), false);
  assert.equal(opened.state.closed, 1);
  // A request carrying another postcode is not this lookup's verification.
  const other = await run('#trawl-postcode=1000', () => verification(body, '2000'));
  assert.deepEqual(other.result.capturedResponses.map(row => row.postcodeSubmitted === true), [false, false]);
  const refused = await run('#trawl-postcode=1000', () => verification(JSON.stringify({ context_code: 1100, data: null, summary: 'PRIVATE' }), '1000'));
  assert.equal(refused.result.capturedResponses[1].body, '{"context_code":1100,"data":null}');
  for (const [fragment, first] of [['', locked], ['#trawl-postcode=1000', body]]) {
    const plain = await run(fragment, () => { throw new Error('unexpected dialog'); }, first);
    assert.deepEqual(plain.steps, [url]); assert.equal(plain.result.capturedResponses.length, 1);
  }
});
