import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dhlExpressBrowserNumber, runDhlExpressBrowser } from './dhl-express-browser.mjs';

const number = '1234567891';
const api = 'https://www.dhl.com/utapi';
const url = `https://www.dhl.com/global-en/home/tracking/tracking-parcel.html?submit=1&tracking-id=${number}`;
const capture = { captureResponses: [api] };
const body = JSON.stringify({ shipments: [{ id: number, service: 'express', events: [{ description: 'Delivered' }] }] });
const response = (status = 200, overrides = {}) => ({
  url: () => `${api}?trackingNumber=${number}&language=en`, status: () => status,
  request: () => ({ method: () => 'GET' }), headers: () => ({ 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': 'PRIVATE' }),
  body: async () => Buffer.from(body), ...overrides,
});

function fixture() {
  const handlers = {};
  const state = { closed: 0, counted: 0, policy: 0, replacements: 0, navigated: 0 };
  const page = { on: (name, handler) => { handlers[name] = handler; }, off: name => { delete handlers[name]; },
    goto: async () => { state.navigated++; handlers.response(response()); },
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const options = { url, capture, tier: 3, maxTimeout: 500,
    handle: { browser: { newContext: async () => context }, noteTemporaryContext: () => { state.counted++; }, requestBrowserReplacement: () => { state.replacements++; } },
    installPolicy: async () => { state.policy++; },
  };
  return { handlers, state, page, context, options };
}

test('DHL runner requires the exact Express request and capture endpoint', () => {
  assert.equal(dhlExpressBrowserNumber(url, capture), number);
  for (const candidate of [url + '#extra', url + '&extra=1', url.replace(number, '1234567890'),
    url.replace('www.dhl.com', 'example.test'), url.replace('www.dhl.com', 'user@www.dhl.com'), url.replace('submit=1', 'submit=0')]) {
    assert.equal(dhlExpressBrowserNumber(candidate, capture), null);
  }
  assert.equal(dhlExpressBrowserNumber(url, { captureResponses: [api, 'https://example.test'] }), null);
});

test('DHL runner accepts an Express piece identifier as DHL lists it', () => {
  const piece = 'JD014600000000000001';
  assert.equal(dhlExpressBrowserNumber(url.replace(number, piece), capture), piece);
  for (const other of ['JJD014600000000000001', 'JD024600000000000001', 'JD01460000000000001', 'jd014600000000000001']) {
    assert.equal(dhlExpressBrowserNumber(url.replace(number, other), capture), null);
  }
});

test('waits through 428 without copying tokens, then captures decoded tracking bytes and closes', async () => {
  const { handlers, state, page, options } = fixture();
  page.goto = async () => {
    handlers.response(response(428, { body: () => { throw new Error('Challenge body must not be read'); } }));
    await new Promise(resolve => setTimeout(resolve, 10));
    handlers.response(response());
  };
  const result = await runDhlExpressBrowser(options);
  assert.equal(result.status, 'success');
  assert.ok(result.body instanceof Uint8Array);
  assert.equal(result.capturedResponses.length, 2);
  assert.equal(result.capturedResponses[0].status, 428);
  assert.equal(result.capturedResponses[0].body, null);
  assert.equal(result.capturedResponses[1].body, body);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(state.closed, 1);
  assert.equal(state.policy, 1);
  assert.equal(state.counted, 1);
  assert.deepEqual(handlers, {});
});

test('ignores other waybills, repeated query parameters, origins and methods', async () => {
  const { handlers, page, options } = fixture();
  page.goto = async () => {
    for (const other of [`${api}?trackingNumber=1234567880`, `${api}?trackingNumber=${number}&trackingNumber=${number}`, `https://example.test/utapi?trackingNumber=${number}`]) {
      handlers.response(response(403, { url: () => other }));
    }
    handlers.response(response(403, { request: () => ({ method: () => 'POST' }) }));
    handlers.response(response());
  };
  assert.equal((await runDhlExpressBrowser(options)).capturedResponses.length, 1);
});

test('keeps a final rejection and the definitive missing-number envelope', async () => {
  for (const status of [403, 404, 429, 503]) {
    const { handlers, page, options } = fixture();
    page.goto = async () => { handlers.response(response(status)); };
    const result = await runDhlExpressBrowser(options);
    assert.equal(result.capturedResponses[0].status, status);
    assert.equal(result.capturedResponses[0].body, status === 404 ? body : null);
  }
});

test('bounds repeated challenges and preserves a challenge at the deadline', async () => {
  for (const count of [1, 11]) {
    const { handlers, page, state, options } = fixture();
    page.goto = async () => { for (let i = 0; i < count; i++) handlers.response(response(428)); };
    const result = await runDhlExpressBrowser({ ...options, maxTimeout: 15 });
    assert.equal(result.capturedResponses.length, Math.min(count, 10));
    assert.equal(result.capturedResponses.at(-1).status, 428);
    if (count > 10) assert.ok(result.capturedResponses.at(-1).error);
    assert.equal(state.closed, 1);
  }
});

test('rejects oversized replies before reading and after browser decompression', async () => {
  for (const declared of [true, false]) {
    const { handlers, page, options } = fixture();
    page.goto = async () => { handlers.response(response(200, {
      headers: () => ({ 'content-length': declared ? '1000001' : '20' }),
      body: async () => { assert.equal(declared, false); return Buffer.alloc(1000001); },
    })); };
    assert.equal((await runDhlExpressBrowser(options)).capturedResponses[0].truncated, true);
  }
});

test('cleans up hung navigation, late contexts and late pages without leaking work', async () => {
  const { page, state, options } = fixture();
  page.goto = () => new Promise(() => {});
  assert.equal((await runDhlExpressBrowser({ ...options, maxTimeout: 10 })).status, 'error');
  assert.equal(state.closed, 1);
  for (const latePage of [false, true]) {
    const f = fixture(); let release;
    if (latePage) f.context.newPage = () => new Promise(resolve => { release = resolve; });
    else f.options.handle.browser.newContext = () => new Promise(resolve => { release = resolve; });
    assert.equal((await runDhlExpressBrowser({ ...f.options, maxTimeout: 5 })).status, 'error');
    release(latePage ? f.page : f.context);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.navigated, 0);
  }
});

test('failed cleanup requests browser replacement and both tiers use fresh contexts', async () => {
  for (const tier of [2, 3]) {
    const { options, context, state } = fixture();
    context.close = () => Promise.reject(new Error('PRIVATE'));
    const result = await runDhlExpressBrowser({ ...options, tier });
    assert.equal(result.tier, tier);
    assert.equal(state.replacements, 1);
  }
});
