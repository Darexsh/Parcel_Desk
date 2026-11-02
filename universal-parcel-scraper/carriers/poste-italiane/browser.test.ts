import { EventEmitter } from 'node:events';
import type { Browser, Page, Request } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRemoteBrowser } from '../../core/transport/localBrowser.js';
import { fetchPosteItalianeInBrowser } from './browser.js';

vi.mock('../../core/transport/localBrowser.js', () => ({ withRemoteBrowser: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const API = 'https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice';
const NUMBER = 'RA00000000001';
const payload = { idTracciatura: NUMBER, listaMovimenti: [{ dataOra: 1767225600000 }] };

function harness() {
  const events = new EventEmitter(), main = {}, other = {};
  const controller = new AbortController();
  const click = vi.fn(async () => {}), close = vi.fn(async () => {});
  const goto = vi.fn(async () => ({ status: () => 200 }));
  const page = Object.assign(events, { mainFrame: () => main, goto,
    getByRole: () => ({ click }) }) as unknown as Page;
  const browser = { newContext: vi.fn(async () => ({ newPage: async () => page, close })) } as unknown as Browser;
  vi.mocked(withRemoteBrowser).mockImplementation(async (_options, run) => run({ browser, signal: controller.signal, remainingMs: () => 3000 }));
  const send = (body: unknown = payload, status = 200, options: { number?: string; foreignFrame?: boolean; endpoint?: string;
    length?: string; contentType?: string; method?: string; raw?: boolean } = {}) => {
    const request = { url: () => options.endpoint ?? API, method: () => options.method ?? 'POST',
      frame: () => options.foreignFrame ? other : main,
      postDataJSON: () => ({ codiceSpedizione: options.number ?? NUMBER, tipoRichiedente: 'WEB' }) } as unknown as Request;
    events.emit('request', request);
    events.emit('response', { request: () => request, url: request.url, status: () => status,
      headers: () => ({ 'content-type': options.contentType ?? 'application/json',
        ...(options.length ? { 'content-length': options.length } : {}), 'retry-after': '30' }),
      body: async () => Buffer.from(options.raw ? String(body) : JSON.stringify(body)) });
  };
  const fetch = () => fetchPosteItalianeInBrowser(NUMBER, 'ws://browser.test/private-path', controller.signal, 3000);
  return { events, goto, close, controller, send, fetch, browser };
}

describe('Poste Italiane private guest browser', () => {
  it('observes before navigation and binds the whole request and positive reply', async () => {
    const h = harness();
    h.goto.mockImplementationOnce(async () => { h.send(); return { status: () => 200 }; });
    await expect(h.fetch()).resolves.toEqual(payload);
    expect(h.goto).toHaveBeenCalledWith(`https://www.poste.it/cerca-spedizioni#/risultati-spedizioni/${NUMBER}`, expect.any(Object));
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.events.eventNames()).toEqual([]);
  });

  it('routes the entire fresh guest context through the supplied proxy', async () => {
    const h = harness(), proxy = { server: 'http://proxy.test:8080', username: 'guest', password: 'secret' };
    h.goto.mockImplementationOnce(async () => { h.send(); return { status: () => 200 }; });
    await expect(fetchPosteItalianeInBrowser(NUMBER, 'ws://browser.test/private-path', h.controller.signal, 3000, proxy)).resolves.toEqual(payload);
    expect(h.browser.newContext).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ proxy, serviceWorkers: 'block' }));
    expect(h.close).toHaveBeenCalledOnce();
  });

  it.each([{ number: `${NUMBER}9` }, { foreignFrame: true }, { endpoint: `${API}/other` }, { method: 'GET' }])(
    'ignores an unrelated request before accepting its bound response: %j', async options => {
      const h = harness();
      h.goto.mockImplementationOnce(async () => { h.send({ unexpected: true }, 200, options); h.send(); return { status: () => 200 }; });
      await expect(h.fetch()).resolves.toEqual(payload);
    });

  it('refuses history that belongs to another number', async () => {
    const h = harness();
    h.goto.mockImplementationOnce(async () => { h.send({ ...payload, idTracciatura: 'RA00000000002' }); return { status: () => 200 }; });
    await expect(h.fetch()).rejects.toMatchObject({ kind: 'schema' });
    expect(h.close).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 400])('preserves a challenge HTTP %s without opening a solver', async status => {
    const h = harness();
    h.goto.mockImplementationOnce(async () => { h.send({ tipo: 'error', descrizione: 'CAPTCHA required' }, status); return { status: () => 200 }; });
    await expect(h.fetch()).rejects.toMatchObject({ kind: 'challenge' });
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('preserves rate limits', async () => {
    const h = harness();
    h.goto.mockImplementationOnce(async () => { h.send({}, 429); return { status: () => 200 }; });
    await expect(h.fetch()).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30000 });
  });

  it.each([{ length: '1000001' }, { contentType: 'text/html' }, { raw: true }])('rejects oversized or malformed replies: %j', async options => {
    const h = harness();
    h.goto.mockImplementationOnce(async () => { h.send(payload, 200, options); return { status: () => 200 }; });
    await expect(h.fetch()).rejects.toMatchObject({ kind: 'schema' });
  });

  it('leaves missing replies as challenges and reserves time for cleanup', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.fetch();
    const expectation = expect(pending).rejects.toMatchObject({ kind: 'challenge' });
    await vi.advanceTimersByTimeAsync(1501);
    await expectation;
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('honors caller cancellation and detaches every observer', async () => {
    const h = harness(), reason = new Error('cancelled');
    h.goto.mockImplementationOnce(async () => { h.controller.abort(reason); return { status: () => 200 }; });
    await expect(h.fetch()).rejects.toBe(reason);
    expect(h.events.eventNames()).toEqual([]);
    expect(h.close).toHaveBeenCalledOnce();
  });
});
