import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runXpoBrowser, xpoBrowserNumber } from './xpo-browser.mjs';

const number = '990000001';
const endpoint = `https://api.ltl.xpo.com/public-tracking/1.0/shipments/${number}/tracking`;
const url = `https://ext-web.ltl-xpo.com/public-app/shipments?referenceNumber=${number}`;
const capture = { captureResponses: [endpoint] };
const body = JSON.stringify({ code: '200', data: { proNbr: number } });
const response = (status = 200, value = body, target = endpoint) => ({ url: () => target, status: () => status,
  request: () => ({ method: () => 'GET' }), headers: () => ({ 'set-cookie': 'PRIVATE' }), body: async () => Buffer.from(value) });
function fixture() {
  const handlers = {}, state = { closed: 0, selected: [], policy: 0 };
  const page = { on: (name, fn) => { handlers[name] = fn; }, off: name => { delete handlers[name]; },
    goto: async () => { handlers.response(response(428, 'PRIVATE')); return { status: () => 200 }; },
    locator: () => ({ waitFor: async () => {} }),
    frames: () => [{ url: () => 'https://www.google.com/recaptcha/api2/anchor?size=normal&k=synthetic-public-widget-key' }],
    frameLocator: selector => { state.selected.push(selector); },
  };
  const options = { url, capture, tier: 3, maxTimeout: 6000,
    handle: { browser: { newContext: async () => ({ newPage: async () => page, close: async () => { state.closed++; } }) } },
    installPolicy: async () => { state.policy++; },
    solveCaptcha: async scoped => {
      scoped.frameLocator('iframe[src*="anchor"]'); scoped.frameLocator('iframe[src*="bframe"]');
      handlers.response(response(200, body, endpoint.replace(number, '990000012')));
      handlers.response(response());
    },
  };
  return { options, handlers, state, page };
}
test('accepts only the whole checked PRO and its exact endpoint', () => {
  assert.equal(xpoBrowserNumber(url, capture), number);
  for (const candidate of [url + '#extra', url + '&referenceNumber=' + number, url.replace(number, '990000002'),
    url.replace('ext-web.ltl-xpo.com', 'example.test'), url.replace('ext-web.ltl-xpo.com', 'user@ext-web.ltl-xpo.com')]) {
    assert.equal(xpoBrowserNumber(candidate, capture), null);
  }
  assert.equal(xpoBrowserNumber(url, { captureResponses: [endpoint + '?extra'] }), null);
});
test('observes before navigation, scopes the visible widget and keeps the response sequence without verification tokens', async () => {
  const active = fixture(); const result = await runXpoBrowser(active.options);
  assert.deepEqual(result.capturedResponses.map(row => [row.status, row.body]), [[428, null], [200, body]]);
  assert.match(active.state.selected[0], /size=normal/);
  assert.match(active.state.selected[1], /k=synthetic-public-widget-key/);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.html, ''); assert.equal(active.state.closed, 1); assert.equal(active.state.policy, 1);
  assert.deepEqual(active.handlers, {});
});
test('retains refusals at failure or deadline and closes its context', async () => {
  for (const status of [403, 429]) {
    const active = fixture(); active.options.solveCaptcha = async () => { active.handlers.response(response(status, 'PRIVATE')); };
    assert.equal((await runXpoBrowser(active.options)).capturedResponses.at(-1).status, status);
    assert.equal(active.state.closed, 1);
  }
  const active = fixture(); active.options.maxTimeout = 20;
  assert.deepEqual((await runXpoBrowser(active.options)).capturedResponses.map(row => row.status), [428]);
  assert.equal(active.state.closed, 1);
});
test('bounds body sizes and repeated responses', async () => {
  const large = fixture(); large.options.solveCaptcha = async () => { large.handlers.response(response(200, 'x'.repeat(1_000_001))); };
  assert.equal((await runXpoBrowser(large.options)).capturedResponses.at(-1).truncated, true);
  const many = fixture(); many.options.solveCaptcha = async () => { for (let i = 0; i < 12; i++) many.handlers.response(response(428)); };
  const result = await runXpoBrowser(many.options);
  assert.equal(result.capturedResponses.length, 10); assert.match(result.capturedResponses.at(-1).error, /limit/);
});
