import { readFileSync } from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, TOYOU_API, TOYOU_PAGE, ToyouTracker } from './adapter.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/return.json', import.meta.url), 'utf8'));
const NUMBER = fixture().payload[0].parcelId as string;
const SERVICE = 'https://trawl.invalid';
const TOKEN = ['A'.repeat(64), 'B'.repeat(64), 'C'.repeat(64)].join('.');
const response = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const bootstrap = (extra: Record<string, unknown> = {}) => response({ url: TOYOU_PAGE, tier: 3, statusCode: 200,
  html: '<body><script id="mobify-data" type="application/json">' + JSON.stringify({ __PRELOADED_STATE__: { appProps: { azureToken: TOKEN } } }) + '</script><p>Loading...</p></body>', ...extra });
const api = (data: unknown = fixture(), extra: Record<string, unknown> = {}) => {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return response({ url: TOYOU_API + NUMBER, tier: 1, statusCode: 200, html: text,
    body: Object.fromEntries([...brotliCompressSync(text)].map((value, index) => [index, value])), ...extra });
};
function harness(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const reply of replies) fetcher.mockResolvedValueOnce(reply);
  const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
  return { fetcher, recorder, tracker: new ToyouTracker({ fetcher, recorder, trawl: new TrawlClient(SERVICE) }) };
}

describe('toyou verified guest retrieval', () => {
  it('reuses server-rendered guest state for one same-service HTTP lookup even while the UI is loading', async () => {
    const h = harness(bootstrap(), api());
    const result = await h.tracker.fetch(NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', events: { length: 6 } });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    const requests = h.fetcher.mock.calls.map(([url, init]) => {
      expect(String(url)).toBe(SERVICE + '/scrape');
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      return JSON.parse(String(init!.body));
    });
    expect(requests[0]).toMatchObject({ url: TOYOU_PAGE, skipHttp: true, contentWaitForSelector: 'body:has(script#mobify-data)' });
    expect(requests[1]).toMatchObject({ url: TOYOU_API + NUMBER, maxTier: 1, headers: { Authorization: 'Bearer ' + TOKEN } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(h.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok' }));
  });

  it.each([401, 403, 404, 405, 410])('keeps HTTP %s separate from parcel absence and preserves status', async statusCode => {
    const h = harness(bootstrap(), api({}, { statusCode }));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: [401, 403].includes(statusCode) ? 'challenge' : 'transport', status: statusCode });
  });

  it('preserves rate limits without retaining guest credentials or service messages', async () => {
    const h = harness(bootstrap(), response({ error: TOKEN }, 429, { 'retry-after': '7' }));
    let error: unknown;
    try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 7000 });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(h.recorder.step.mock.calls)).not.toContain(TOKEN);
  });

  it.each([{ html: '<html>Changed guest page</html>' }, { html: '<script id="mobify-data">not-json</script>' }])('rejects changed guest state', extra => {
    return expect(harness(bootstrap(extra)).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('rejects ambiguous state and an unissued token', async () => {
    for (const html of ['<script id="mobify-data">{}</script>', '<script id="mobify-data">{}</script><script id="mobify-data">{}</script>']) {
      const h = harness(bootstrap({ html }));
      await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: html.includes('</script><script') ? 'schema' : 'challenge' });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['<html>Changed API</html>', '<html><title>Just a moment...</title></html>'])('does not treat HTML as missing history', async html => {
    await expect(harness(bootstrap(), api(html)).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: html.includes('Just a moment') ? 'challenge' : 'schema' });
  });

  it('rejects redirected guest and API responses before parsing them', async () => {
    await expect(harness(bootstrap({ url: 'https://other.invalid/' })).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness(bootstrap(), api(fixture(), { url: TOYOU_API + NUMBER + 'OTHER' })).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('respects the budget reserve, cancellation and browser-only recognition contract', async () => {
    const h = harness(bootstrap(), api());
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    const controller = new AbortController(); controller.abort(new Error('Cancelled'));
    await expect(h.tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Cancelled');
    await expect(new ToyouTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const native = adapter({ fetcher: h.fetcher, recorder: h.recorder, env: {}, trawl: new TrawlClient(SERVICE), browserExecutablePath: null });
    expect(native.recognize).toBeUndefined();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});
