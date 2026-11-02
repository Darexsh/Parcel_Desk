import { test } from 'node:test';
import assert from 'node:assert/strict';
import { track718JuxiNumber, projectTrack718, runTrack718Juxi } from './track718-juxi.mjs';
const number = 'JXCZZ9000000001YQ', api = 'https://apigetway.track718.net/track/real_query_multi';
const url = `https://www.track718.com/en/detail?nums=${number}&cb=678`, capture = { captureResponses: [api] };
const payload = () => ({ status: { code: 0 }, data: [{ track: number, fromKey: 'www.juxiex.com', origin: '04', result: 0,
  recipient: 'PRIVATE', token: 'PRIVATE', from: [], to: [], frist: [], wms: [] }] });

test('Track718 enters only the whole Juxi request with its fixed carrier selection', () => {
  assert.equal(track718JuxiNumber(url, capture), number);
  for (const bad of [url + '&cb=1', url.replace('cb=678', 'cb=679'), url.replace(number, number + '0'), url + '#other', url.replace('www.track718.com', 'example.test')]) {
    assert.equal(track718JuxiNumber(bad, capture), null);
  }
  assert.equal(track718JuxiNumber(url, { captureResponses: [api + '/other'] }), null);
});

test('Track718 projects only matching identity and bounded scan fields', () => {
  const value = projectTrack718(payload(), number);
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  assert.equal(value.data[0].track, number);
  const other = payload(); other.data[0].track += '0'; assert.equal(projectTrack718(other, number), null);
  const carrier = payload(); carrier.data[0].fromKey = 'other'; assert.equal(projectTrack718(carrier, number), null);
  const oversized = payload(); oversized.data[0].from = Array(501).fill({}); assert.equal(projectTrack718(oversized, number), null);
});

test('Track718 binds the WebSocket session and request before accepting a reply', async () => {
  const listeners = new Map(), frames = new Map(); let closed = 0;
  const request = { url: () => api, method: () => 'POST', postData: () => JSON.stringify({ uuid: 'test-session', tracks: [{ track: number, key: 'www.juxiex.com' }] }) };
  const page = {
    on(event, fn) { listeners.set(event, fn); }, off(event) { listeners.delete(event); },
    async goto() {
      assert.ok(listeners.has('websocket') && listeners.has('request'));
      listeners.get('websocket')({ url: () => 'wss://socket.track718.net/', on(event, fn) { frames.set(event, fn); }, off(event) { frames.delete(event); } });
      frames.get('framesent')({ payload: 'wrong-session' });
      listeners.get('request')(request);
      frames.get('framereceived')({ payload: JSON.stringify(payload()) });
      frames.get('framesent')({ payload: 'test-session' });
      frames.get('framereceived')({ payload: JSON.stringify(payload()) });
      return { status: () => 200 };
    },
  };
  const response = await runTrack718Juxi({ url, capture, handle: { browser: { async newContext() {
    return { async newPage() { return page; }, async close() { closed++; } };
  } } }, tier: 3, maxTimeout: 20, signal: new AbortController().signal });
  assert.equal(response.capturedResponses.length, 1);
  assert.equal(response.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(closed, 1); assert.equal(listeners.size, 0); assert.equal(frames.size, 0);
  assert.deepEqual(response.cookies, []); assert.equal(response.html, '');
});

test('Track718 cancels before setup without opening a context', async () => {
  const response = await runTrack718Juxi({ url, capture, handle: { browser: { newContext() { throw Error('unexpected'); } } }, tier: 3, maxTimeout: 100, signal: AbortSignal.abort() });
  assert.equal(response.capturedResponses.length, 0);
});
