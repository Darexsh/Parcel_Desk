import { readFileSync } from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FM_TRANSPORTES_API, FM_TRANSPORTES_PAGE, FmTransportesTracker } from './adapter.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const NUMBER = fixture().data.trackingCode as string;
const SERVICE = 'https://trawl.invalid';
const SECRET = 'SYNTHETIC-UNUSED-TURNSTILE-RESPONSE-731594268';
const SESSION = 'SYNTHETIC-GUEST-SESSION-DO-NOT-RETAIN';
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const bootstrap = (extra: Record<string, unknown> = {}) => response({ url: FM_TRANSPORTES_PAGE, statusCode: 200, tier: 3,
  userAgent: 'Mozilla/5.0 (Synthetic Browser)', html: `<body><input type="hidden" name="cf-turnstile-response" value="${SECRET}"></body>`, ...extra });
const apiReply = (path: '/c' | '/get', body: unknown, extra: Record<string, unknown> = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return response({ url: `${FM_TRANSPORTES_API}${path}`, tier: 1, statusCode: 200, html: text,
    body: Object.fromEntries([...brotliCompressSync(text)].map((value, index) => [index, value])), ...extra });
};
const session = () => apiReply('/c', { success: true, data: { t: SESSION } });
function harness(last: () => Response = () => apiReply('/get', fixture())) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(bootstrap()).mockResolvedValueOnce(session()).mockImplementationOnce(async () => last());
  const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
  return { fetcher, recorder, tracker: new FmTransportesTracker({ fetcher, recorder, trawl: new TrawlClient(SERVICE) }) };
}

describe('FM Transportes verified retrieval', () => {
  it('uses browser bootstrap then two bound HTTP-tier POSTs on the supplied transport', async () => {
    const h = harness();
    const result = await h.tracker.fetch(NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    for (const [url, init] of h.fetcher.mock.calls) {
      expect(String(url)).toBe(`${SERVICE}/scrape`);
      expect(init!.signal).toBeInstanceOf(AbortSignal);
    }
    const requests = h.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
    expect(requests[0]).toMatchObject({ url: FM_TRANSPORTES_PAGE, skipHttp: true, maxTier: 3,
      contentWaitForSelector: expect.stringContaining('body:has(') });
    expect(requests[1]).toMatchObject({ url: `${FM_TRANSPORTES_API}/c`, method: 'POST', maxTier: 1,
      headers: { 'User-Agent': 'Mozilla/5.0 (Synthetic Browser)' }, body: JSON.stringify({ token: SECRET }) });
    expect(requests[2]).toMatchObject({ url: `${FM_TRANSPORTES_API}/get`, method: 'POST', maxTier: 1,
      headers: { 'X-Session-Token': SESSION }, body: JSON.stringify({ trackingCode: NUMBER }) });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SESSION);
    expect(h.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok' }));
    expect(h.recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1, finalStep: 'trawl', outcome: 'ok' }));
  });

  it.each([{ success: true, data: {} }, { success: true, data: null }, { success: false }])('leaves empty or failed lookup data inconclusive', async body => {
    await expect(harness(() => apiReply('/get', body)).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps a no-content lookup inconclusive', async () => {
    await expect(harness(() => apiReply('/get', null, { statusCode: 204 })).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([401, 403, 404, 405, 410])('classifies rejected or unavailable tracking routes with HTTP %s', async statusCode => {
    const h = harness(() => apiReply('/get', { error: SECRET }, { statusCode }));
    let error: unknown;
    try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: [401, 403].includes(statusCode) ? 'challenge' : 'transport' });
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });

  it('preserves rate-limit classification and retry time without verification diagnostics', async () => {
    const h = harness(() => response({ error: 'Max tier reached without success', timings: [{ tier: 1, status: 'blocked', statusCode: 429,
      responseHeaders: { 'retry-after': '9' }, body: SECRET }] }, 500));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 9000 });
    const error = h.recorder.step.mock.calls[0]![0].error;
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect((error as Error).cause).toBeUndefined();
  });

  it.each(['<html>Changed API</html>', '<html><title>Just a moment...</title></html>'])('does not mistake HTML for missing history', async body => {
    await expect(harness(() => apiReply('/get', body)).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: body.includes('Just a moment') ? 'challenge' : 'schema' });
  });

  it('never forwards arbitrary service errors containing request credentials', async () => {
    const h = harness(() => response({ error: `${SECRET} ${SESSION}` }));
    let error: unknown;
    try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'transport' });
    expect(`${String(error)}${JSON.stringify(error)}${JSON.stringify(h.recorder.step.mock.calls)}`).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SESSION);
  });

  it.each([
    { html: '<body>Loading</body>' },
    { html: `<input name="cf-turnstile-response" value="${SECRET}"><input name="cf-turnstile-response" value="${SECRET}">` },
  ])('requires a unique unused verification response', async extra => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(bootstrap(extra));
    await expect(new FmTransportesTracker({ fetcher, trawl: new TrawlClient(SERVICE) }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects redirected guest pages and API replies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(bootstrap({ url: 'https://other.invalid/' }));
    await expect(new FmTransportesTracker({ fetcher, trawl: new TrawlClient(SERVICE) }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness(() => apiReply('/get', fixture(), { url: 'https://other.invalid/' })).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('reserves transport time under the lookup budget and starts no request after cancellation', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(h.fetcher).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort(new Error('Cancelled'));
    await expect(h.tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Cancelled');
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it('requires TRAWL and offers no browser activity through HTTP recognition', async () => {
    await expect(new FmTransportesTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const h = harness();
    const native = adapter({ fetcher: h.fetcher, recorder: h.recorder, env: {}, trawl: new TrawlClient(SERVICE), browserExecutablePath: null });
    expect(native.recognize).toBeUndefined();
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it('routes the existing detected carrier to native history with universal providers disabled', async () => {
    const h = harness();
    await expect(createTracker({ providers: [], trawlUrl: SERVICE, fetcher: h.fetcher }).track({ number: NUMBER }))
      .resolves.toMatchObject({ carrier: 'fm-transportes', source: 'fm-transportes', result: { status: 'delivered' } });
  });
});
