import { readFileSync } from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ZoomTracker } from './adapter.js';
import { ZOOM_READY_SELECTOR, zoomTrackingUrl } from './parser.js';

const fixture = (name = 'delivered') => readFileSync(new globalThis.URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const NUMBER = /Información del Envío (\d{10})/.exec(fixture())![1]!;
const URL = zoomTrackingUrl(NUMBER), SERVICE = 'https://trawl.invalid';
const SECRET = 'SYNTHETIC-UNUSED-TURNSTILE-RESPONSE-731594268';
const verified = new globalThis.URL(URL); verified.searchParams.set('turnstile-token', SECRET);
const widget = (token = SECRET) => `<html><body><div class="cf-turnstile"><input type="hidden" name="cf-turnstile-response" value="${token}"></div></body></html>`;
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const browser = (html = fixture(), extra: Record<string, unknown> = {}) => response({ url: URL, tier: 2, statusCode: 200, html,
  userAgent: 'Mozilla/5.0 (Synthetic Browser)', cookies: [], ...extra });
const http = (html = fixture(), extra: Record<string, unknown> = {}) => browser(html, { url: verified.href, tier: 1,
  body: Object.fromEntries([...brotliCompressSync(html)].map((value, index) => [index, value])), ...extra });
function harness(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const reply of replies) fetcher.mockResolvedValueOnce(reply);
  const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
  return { fetcher, recorder, tracker: new ZoomTracker({ fetcher, recorder, trawl: new TrawlClient(SERVICE) }) };
}

describe('Zoom verified retrieval', () => {
  it('accepts a completed bound browser history without requiring a remaining token', async () => {
    const h = harness(browser());
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SERVICE}/scrape`);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init!.body))).toMatchObject({ url: URL, skipHttp: true, maxTier: 3, contentWaitForSelector: ZOOM_READY_SELECTOR });
    expect(h.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok' }));
  });

  it('accepts only the explicit negative after the callback has finished', async () => {
    const h = harness(browser(fixture('not-found')));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses an unused response in a same-service HTTP-tier lookup and drops its capability', async () => {
    const h = harness(browser(widget()), http());
    const result = await h.tracker.fetch(NUMBER);
    expect(result.current_stage).toBe('delivered');
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    const request = JSON.parse(String(h.fetcher.mock.calls[1]![1]!.body));
    expect(request).toMatchObject({ url: verified.href, method: 'GET', maxTier: 1, headers: { 'User-Agent': 'Mozilla/5.0 (Synthetic Browser)' } });
    expect(request.headers.Cookie).toBeUndefined();
    expect(`${JSON.stringify(result)}${JSON.stringify(h.recorder.step.mock.calls)}`).not.toContain(SECRET);
  });

  it('retries one unfinished warm widget with only real carrier cookies', async () => {
    const owned = { name: 'zoom_sid', value: SECRET, domain: '.zoom.red', path: '/', secure: true };
    const foreign = { ...owned, name: 'foreign_sid', domain: '.other.invalid' };
    const h = harness(browser(widget(''), { cookies: [foreign, owned] }), browser());
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    const retry = JSON.parse(String(h.fetcher.mock.calls[1]![1]!.body));
    expect(retry.cookies).toEqual([owned]);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it('never invents cookies or repeats an unresolved widget indefinitely', async () => {
    const foreign = { name: 'sid', value: SECRET, domain: '.other.invalid', path: '/' };
    const one = harness(browser(widget(''), { cookies: [foreign] }));
    await expect(one.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(one.fetcher).toHaveBeenCalledTimes(1);
    const owned = { ...foreign, domain: '.zoom.red' };
    const two = harness(browser(widget(''), { cookies: [owned] }), browser(widget(''), { cookies: [owned] }));
    await expect(two.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(two.fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry schema failures as verification work', async () => {
    const h = harness(browser('<html>Changed page</html>', { cookies: [{ name: 'sid', value: SECRET, domain: '.zoom.red', path: '/' }] }));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 405, 410])('keeps rejected or unavailable HTTP reads separate from absence (%s)', async statusCode => {
    const h = harness(browser(widget()), http(fixture('not-found'), { statusCode }));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: [401, 403].includes(statusCode) ? 'challenge' : 'transport' });
  });

  it('retains rate limits without leaking response or request credentials', async () => {
    const h = harness(response({ error: SECRET }, 429, { 'retry-after': '8' }));
    let error: unknown;
    try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 8000 });
    expect(`${String(error)}${JSON.stringify(error)}${JSON.stringify(h.recorder.step.mock.calls)}`).not.toContain(SECRET);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a foreign or missing response URL before reading a result', async () => {
    for (const extra of [{ url: 'https://other.invalid/' }, { url: undefined }]) {
      const h = harness(browser(fixture(), extra));
      await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it('requires TRAWL, respects the budget reserve and starts nothing after cancellation', async () => {
    await expect(new ZoomTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const h = harness(browser());
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    const controller = new AbortController(); controller.abort(new Error('Cancelled'));
    await expect(h.tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Cancelled');
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it('exposes native tracking for the explicit carrier without HTTP browser recognition', async () => {
    const h = harness(browser());
    const native = adapter({ fetcher: h.fetcher, recorder: h.recorder, env: {}, trawl: new TrawlClient(SERVICE), browserExecutablePath: null });
    expect(native.recognize).toBeUndefined();
    await expect(createTracker({ providers: [], trawlUrl: SERVICE, fetcher: h.fetcher })
      .track({ number: NUMBER, carrier: 'zoom-ve' })).resolves.toMatchObject({ source: 'zoom-ve', result: { status: 'delivered' } });
  });
});
