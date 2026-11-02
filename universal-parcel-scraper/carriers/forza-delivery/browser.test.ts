import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRemoteBrowser } from '../../core/transport/localBrowser.js';
import { fetchForzaInBrowser, forzaGuestLookup } from './browser.js';
import { FORZA_MAX_BYTES } from './parser.js';
import { FORZA_API, FORZA_ORIGIN, forzaLookupBody } from './request.js';

vi.mock('../../core/transport/localBrowser.js', () => ({ withRemoteBrowser: vi.fn() }));
const number = 'FD0000001';
const fixture = readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8');
const reply = (body = fixture, status = 200, url = FORZA_API, headers: Record<string, string> = {}) =>
  Object.defineProperty(new Response(body, { status, headers }), 'url', { value: url });

function harness(response = reply()) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetcher);
  const route = vi.fn();
  const page = { goto: vi.fn(async () => ({ status: (): number => 200, headers: () => ({}) })), url: vi.fn(() => `${FORZA_ORIGIN}/`),
    evaluate: vi.fn(async (fn: typeof forzaGuestLookup, args: Parameters<typeof forzaGuestLookup>[0]) => fn(args)) };
  const signal = new AbortController().signal;
  vi.mocked(withRemoteBrowser).mockImplementation(async (options, run) => run({ browser: {
    newContext: async () => ({ newPage: async () => page, route }),
  } as never, signal: options.signal!, remainingMs: () => 4000 }));
  return { fetcher, page, route, signal,
    run: (n = number) => fetchForzaInBrowser(n, 'ws://browser.test/synthetic', signal, 5000) };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Forza private browser recovery', () => {
  it('uses the guest request, keeps wall clocks and strips recipient detail', async () => {
    const h = harness();
    const result = await h.run();
    expect(result.current_stage).toBe('delivered');
    expect(result.events![0]).toMatchObject({ local_time: '2026-03-12T14:07:31' });
    expect(JSON.stringify(result)).not.toMatch(/Sample|SAMPLEAPP|Comprobante/);
    expect(h.fetcher).toHaveBeenCalledExactlyOnceWith('/fd2/Home.aspx/API', expect.objectContaining({
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal), body: forzaLookupBody(number),
    }));
    expect(h.page.goto).toHaveBeenCalledWith(`${FORZA_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 3000 });
    expect(withRemoteBrowser).toHaveBeenCalledWith(expect.objectContaining({ signal: h.signal, timeoutMs: 5000 }), expect.any(Function));
  });

  it('allows only official assets and the exact guest POST', async () => {
    const h = harness(); await h.run();
    const handle = h.route.mock.calls[0]![1] as (route: unknown) => Promise<void>;
    for (const [url, method, body, allowed] of [
      [`${FORZA_ORIGIN}/main.js`, 'GET', null, true], [FORZA_API, 'POST', forzaLookupBody(number), true],
      ['https://elsewhere.test/', 'GET', null, false], [FORZA_API, 'POST', forzaLookupBody('FD0000002'), false],
      [`${FORZA_ORIGIN}/login`, 'POST', '', false], [FORZA_API + '?other=1', 'POST', forzaLookupBody(number), false],
    ] as const) {
      const proceed = vi.fn(), abort = vi.fn();
      await handle({ request: () => ({ url: () => url, method: () => method, postData: () => body }), continue: proceed, abort });
      expect(allowed ? proceed : abort).toHaveBeenCalledOnce();
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate']] as const)(
    'keeps HTTP %s distinct from shipment absence', async (status, kind) => {
      const h = harness(reply('unavailable', status, FORZA_API, { 'retry-after': '30' }));
      await expect(h.run()).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 30_000 } : {}) });
    });

  it('requires the exact response endpoint and requested identity', async () => {
    const h = harness(reply(fixture, 200, FORZA_API + '?other=1'));
    await expect(h.run()).rejects.toMatchObject({ kind: 'schema' });
    h.fetcher.mockResolvedValue(reply());
    await expect(h.run('FD0000002')).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('bounds declared and streamed bodies', async () => {
    const h = harness(reply(fixture, 200, FORZA_API, { 'content-length': String(FORZA_MAX_BYTES + 1) }));
    await expect(h.run()).rejects.toMatchObject({ kind: 'transport' });
    h.fetcher.mockResolvedValue(reply('x'.repeat(FORZA_MAX_BYTES + 1)));
    await expect(h.run()).rejects.toMatchObject({ kind: 'transport' });
  });

  it('does not query after a refused or redirected bootstrap', async () => {
    const h = harness(); h.page.goto.mockResolvedValueOnce({ status: () => 403, headers: () => ({}) });
    await expect(h.run()).rejects.toMatchObject({ kind: 'challenge' });
    h.page.url.mockReturnValue('https://elsewhere.test/');
    await expect(h.run()).rejects.toMatchObject({ kind: 'schema' });
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it('preserves an explicit not-found answer', async () => {
    const missing = readFileSync(new URL('./fixtures/not-found.json', import.meta.url), 'utf8');
    const h = harness(reply(missing));
    await expect(h.run('FD0000000')).rejects.toMatchObject({ kind: 'not_found' });
  });
});
