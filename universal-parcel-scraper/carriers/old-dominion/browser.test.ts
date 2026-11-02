import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { captureOldDominionReply } from './browser.js';
import { OLD_DOMINION_API } from './parser.js';

// A synthetic PRO as the page sends it, without leading zeros.
const PRO = '7200000001';
const BODY = '{"body":{"ok":true,"referenceType":"PRO","referenceNumber":"7200000001"}}\n';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

interface Call { url?: string; method?: string; ownFrame?: boolean; body?: unknown }

function harness() {
  const emitter = new EventEmitter();
  const frame = {};
  const page = Object.assign(emitter, { mainFrame: () => frame }) as unknown as Page;
  const request = (call: Call = {}) => ({ url: () => call.url ?? OLD_DOMINION_API, method: () => call.method ?? 'POST',
    frame: () => call.ownFrame === false ? {} : frame,
    postDataJSON: () => 'body' in call ? call.body : { referenceType: 'PRO', referenceNumbers: [PRO] },
    failure: () => ({ errorText: 'PRIVATE TOKEN in request headers' }) }) as unknown as Request;
  const respond = async (call: Call & { status?: number; headers?: Record<string, string>; read?: () => Promise<Buffer> } = {}) => {
    emitter.emit('response', { request: () => request(call), status: () => call.status ?? 200,
      headers: () => ({ 'content-type': 'application/x-ndjson', ...call.headers }),
      body: call.read ?? (async () => Buffer.from(BODY)) });
    await tick();
  };
  const controller = new AbortController();
  const capture = (trigger: () => Promise<void>, timeout = 1000) =>
    captureOldDominionReply(page, PRO, controller.signal, timeout, trigger);
  return { emitter, request, respond, controller, capture };
}

describe('Old Dominion tracking call capture', () => {
  it('takes the main frame\'s POST for this PRO and nothing else', async () => {
    const h = harness();
    const reply = await h.capture(async () => {
      await h.respond({ method: 'OPTIONS', status: 204 });
      await h.respond({ url: `${OLD_DOMINION_API}?x=1` });
      await h.respond({ ownFrame: false, status: 500 });
      await h.respond({ status: 422, headers: { 'retry-after': '5' } });
      await h.respond({ status: 200 });
    });
    expect(reply).toEqual({ status: 422, contentType: 'application/x-ndjson', retryAfter: '5', body: BODY });
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it.each([
    { referenceType: 'PRO', referenceNumbers: ['7200000002'] },
    { referenceType: 'PRO', referenceNumbers: [PRO, '7200000002'] },
    { referenceType: 'BOL', referenceNumbers: [PRO] },
    { referenceType: 'PRO', referenceNumbers: [Number(PRO)] },
    null,
  ])('fails when the page submits another reference: %j', async body => {
    const h = harness();
    await expect(h.capture(() => h.respond({ body }))).rejects.toMatchObject({ kind: 'schema' });
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('refuses an oversized declared reply before reading it and a decoded one after', async () => {
    for (const declared of [true, false]) {
      const h = harness();
      const read = vi.fn(async () => Buffer.alloc(1_000_001));
      await expect(h.capture(() => h.respond({ read, headers: declared ? { 'content-length': '1000001' } : {} })))
        .rejects.toMatchObject({ kind: 'schema' });
      expect(read).toHaveBeenCalledTimes(declared ? 0 : 1);
    }
  });

  it('keeps browser diagnostics out of read and request failures', async () => {
    const unread = harness();
    await expect(unread.capture(() => unread.respond({ read: async () => { throw new Error('PRIVATE TOKEN in body error'); } })))
      .rejects.toMatchObject({ kind: 'transport', message: 'Old Dominion tracking reply could not be read' });
    const h = harness();
    const result = h.capture(async () => {
      h.emitter.emit('requestfailed', h.request({ url: 'https://www.odfl.com/other' }));
      h.emitter.emit('requestfailed', h.request());
    });
    await expect(result).rejects.toMatchObject({ kind: 'transport', message: 'Old Dominion tracking request failed' });
    await expect(result).rejects.not.toHaveProperty('cause');
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('fails with the trigger\'s own error when the page cannot load', async () => {
    const h = harness();
    const failure = new Error('page failed');
    await expect(h.capture(async () => { throw failure; })).rejects.toBe(failure);
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('honors cancellation before loading the page', async () => {
    const h = harness();
    const reason = new Error('cancelled');
    h.controller.abort(reason);
    const trigger = vi.fn(async () => {});
    await expect(h.capture(trigger)).rejects.toBe(reason);
    expect(trigger).not.toHaveBeenCalled();
    expect(h.emitter.eventNames()).toEqual([]);
  });

  it('bounds a page that never calls and keeps a cancellation\'s reason over a late body', async () => {
    const missing = harness();
    await expect(missing.capture(async () => {}, 10)).rejects.toMatchObject({ kind: 'transport',
      message: 'Old Dominion trace page sent no tracking request in time' });
    expect(missing.emitter.eventNames()).toEqual([]);
    const h = harness();
    let release!: (value: Buffer) => void;
    const body = new Promise<Buffer>(resolve => { release = resolve; });
    const result = h.capture(() => h.respond({ read: () => body }));
    await tick();
    const reason = new Error('cancelled');
    h.controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    release(Buffer.from(BODY));
    await tick();
    expect(h.emitter.eventNames()).toEqual([]);
  });
});
