import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ozonBrowserRequest, readOzonPageApi, runOzonBrowser } from './ozon-browser.mjs';

const posting = '48271635-2048-1';
const path = `/p-api/ozon-track-bff/tracking/${posting}`;
const api = `https://tracking.ozon.ru${path}`;
const url = `https://tracking.ozon.ru/?track=${posting}`;
const capture = { captureResponses: [api] };

test('Ozon binds the only whole posting to its official GET endpoint', () => {
  assert.deepEqual(ozonBrowserRequest(url, capture), { posting, number: '4827163520481', api });
  for (const bad of [url.replace('tracking.ozon.ru', 'tracking.ozon.ru.example.invalid'), `${url}&track=${posting}`,
    `${url}#other`, `${url}&extra=1`, url.replace(posting, `${posting}0`)]) assert.equal(ozonBrowserRequest(bad, capture), null);
  assert.equal(ozonBrowserRequest(url, { captureResponses: [`${api}0`] }), null);
});

test('Ozon reads a compressed/unknown-length browser body through a bounded stream', async () => {
  const previous = { fetch: globalThis.fetch, location: globalThis.location };
  const body = JSON.stringify({ message: `Постинг ${posting} не найден` });
  globalThis.location = { origin: 'https://tracking.ozon.ru' };
  globalThis.fetch = async () => {
    const response = new Response(body, { status: 404, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
    Object.defineProperty(response, 'url', { value: api });
    return response;
  };
  try {
    const value = await readOzonPageApi({ path, timeoutMs: 1000, maxBytes: 1000 });
    assert.equal(value.status, 404);
    assert.equal(value.error, null);
    assert.equal(value.body, body);
  } finally { Object.assign(globalThis, previous); }
});

test('Ozon returns only tracking fields and never challenge tokens or recipient fields', async () => {
  const previous = { fetch: globalThis.fetch, location: globalThis.location };
  globalThis.location = { origin: 'https://tracking.ozon.ru' };
  const values = [
    { status: 200, payload: { deliveryType: 'PVZ', recipient: 'PRIVATE', items: [{ event: 'Created', moment: '2031-01-01T00:00:00Z', token: 'PRIVATE' }] } },
    { status: 403, payload: { incidentId: 'PRIVATE', challengeURL: 'PRIVATE' } },
    { status: 200, payload: { incidentId: 'PRIVATE', challengeURL: 'PRIVATE' } },
  ];
  try {
    for (const value of values) {
      globalThis.fetch = async () => {
        const response = new Response(JSON.stringify(value.payload), { status: value.status });
        Object.defineProperty(response, 'url', { value: api }); return response;
      };
      const result = await readOzonPageApi({ path, timeoutMs: 1000, maxBytes: 1000 });
      assert.ok(!JSON.stringify(result).includes('PRIVATE'));
      if (value.payload.items) assert.equal(JSON.parse(result.body).items[0].event, 'Created');
      else assert.equal(result.body, null);
    }
  } finally { Object.assign(globalThis, previous); }
});

test('Ozon stops a response stream at its byte cap without returning partial JSON', async () => {
  const previous = { fetch: globalThis.fetch, location: globalThis.location };
  let cancelled = false;
  globalThis.location = { origin: 'https://tracking.ozon.ru' };
  globalThis.fetch = async () => ({ url: api, status: 200, headers: new Headers(), body: new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(101))); },
    cancel() { cancelled = true; },
  }) });
  try {
    assert.deepEqual(await readOzonPageApi({ path, timeoutMs: 1000, maxBytes: 100 }),
      { status: 200, headers: { 'content-type': '' }, body: null, error: 'response-too-large', truncated: true });
    assert.equal(cancelled, true);
  } finally { Object.assign(globalThis, previous); }
});

test('Ozon refuses an endpoint redirect to a different posting before reading it', async () => {
  const previous = { fetch: globalThis.fetch, location: globalThis.location };
  let cancelled = false;
  globalThis.location = { origin: 'https://tracking.ozon.ru' };
  globalThis.fetch = async () => ({ url: `${api}0`, status: 200, body: { async cancel() { cancelled = true; } } });
  try {
    assert.deepEqual(await readOzonPageApi({ path, timeoutMs: 1000, maxBytes: 1000 }),
      { status: 200, body: null, error: 'different-response' });
    assert.equal(cancelled, true);
  } finally { Object.assign(globalThis, previous); }
});

test('Ozon invalid paths make no request', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unexpected transport'); };
  try {
    assert.equal((await readOzonPageApi({ path: `${path}?other=1`, timeoutMs: 1000, maxBytes: 1000 })).error, 'invalid-request');
  } finally { globalThis.fetch = previous; }
});

test('Ozon cancellation before setup opens no browser context', async () => {
  const signal = AbortSignal.abort();
  const result = await runOzonBrowser({ url, capture, handle: { browser: { newContext() { throw new Error('unexpected context'); } } },
    tier: 3, maxTimeout: 100, signal });
  assert.equal(result.status, 'error');
  assert.deepEqual(result.capturedResponses, []);
});

test('Ozon deadline closes a context that arrives after the operation ended', async () => {
  let closed = 0;
  const result = await runOzonBrowser({ url, capture, handle: { browser: { async newContext() {
    await new Promise(resolve => setTimeout(resolve, 25));
    return { async close() { closed++; } };
  } } }, tier: 3, maxTimeout: 5 });
  assert.equal(result.status, 'error');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closed, 1);
});

test('Ozon observes before navigation and keeps a refusal before its bounded final reply', async () => {
  const listeners = new Map(), order = [];
  let closed = 0;
  const page = {
    on(event, fn) { listeners.set(event, fn); },
    off(event) { listeners.delete(event); },
    async goto() {
      assert.ok(listeners.has('request') && listeners.has('response'));
      order.push('navigate'); return { status: () => 403 };
    },
    locator() { return { async waitFor() { order.push('ready'); } }; },
    async evaluate(_reader, args) {
      assert.equal(args.path, path);
      const request = { method: () => 'GET', url: () => api };
      listeners.get('request')(request);
      for (const status of [403, 200]) listeners.get('response')({ request: () => request, url: () => api, status: () => status });
      return { status: 200, body: '{"items":[]}', headers: { 'content-type': 'application/json' }, error: null };
    },
  };
  const result = await runOzonBrowser({ url, capture, handle: { browser: { async newContext() {
    return { async newPage() { return page; }, async close() { closed++; } };
  } } }, tier: 3, maxTimeout: 1000, signal: new AbortController().signal });
  assert.deepEqual(order, ['navigate', 'ready']);
  assert.equal(closed, 1);
  assert.equal(listeners.size, 0);
  assert.deepEqual(result.capturedResponses.map(row => row.status), [403, 200]);
  assert.equal(result.capturedResponses[1].trackingNumberSubmitted, '4827163520481');
  assert.equal(result.capturedResponses[0].body, null);
  assert.equal(result.html, '');
  assert.deepEqual(result.cookies, []);
});

test('Ozon cancellation retains an observed refusal and closes its context', async () => {
  const controller = new AbortController(), listeners = new Map();
  let closed = 0;
  const request = { method: () => 'GET', url: () => api };
  const page = {
    on(event, fn) { listeners.set(event, fn); }, off(event) { listeners.delete(event); },
    async goto() { return { status: () => 200 }; },
    locator() { return { async waitFor() {} }; },
    async evaluate() {
      listeners.get('request')(request);
      listeners.get('response')({ request: () => request, url: () => api, status: () => 403 });
      controller.abort();
      return new Promise(() => {});
    },
  };
  const result = await runOzonBrowser({ url, capture, handle: { browser: { async newContext() {
    return { async newPage() { return page; }, async close() { closed++; } };
  } } }, tier: 3, maxTimeout: 1000, signal: controller.signal });
  assert.equal(closed, 1);
  assert.equal(result.capturedResponses.at(-1).status, 403);
  assert.equal(listeners.size, 0);
});
