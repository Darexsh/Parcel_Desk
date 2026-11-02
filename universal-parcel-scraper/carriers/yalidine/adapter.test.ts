import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, YALIDINE_PAGE, YalidineTracker } from './adapter.js';

const NUMBER = 'YALZQ8H7J', SERVICE = 'https://trawl.invalid';
const SECRET = 'SYNTHETIC-UNUSED-TURNSTILE-RESPONSE-731594268';
const COOKIE = 'SYNTHETIC-GUEST-COOKIE';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const page = (html = fixture(), extra: Record<string, unknown> = {}) => response({ url: YALIDINE_PAGE, tier: 3, statusCode: 200, html,
  userAgent: 'Mozilla/5.0 (Synthetic Browser)', cookies: [], ...extra });
const bootstrap = (extra: Record<string, unknown> = {}) => page(`<body><input type="hidden" name="cf-turnstile-response" value="${SECRET}"></body>`, {
  cookies: [{ name: 'guest_sid', value: COOKIE, domain: '.yalidine.com', path: '/', secure: true },
    { name: 'other_sid', value: 'FOREIGN-COOKIE-VALUE', domain: '.other.invalid', path: '/' }], ...extra });
function harness(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>(); for (const reply of replies) fetcher.mockResolvedValueOnce(reply);
  const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
  return { fetcher, recorder, tracker: new YalidineTracker({ fetcher, recorder, trawl: new TrawlClient(SERVICE) }) };
}

describe('Yalidine verified guest retrieval', () => {
  it('uses the supplied transport for a blank browser bootstrap then the whole-number browser POST', async () => {
    const h = harness(bootstrap(), page()); const result = await h.tracker.fetch(NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_update: null });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of h.fetcher.mock.calls) { expect(String(url)).toBe(`${SERVICE}/scrape`); expect(init!.signal).toBeInstanceOf(AbortSignal); }
    const requests = h.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
    expect(requests[0]).toMatchObject({ url: YALIDINE_PAGE, skipHttp: true, maxTier: 3, contentWaitForSelector: expect.stringContaining('body:has(') });
    expect(requests[1]).toMatchObject({ url: YALIDINE_PAGE, method: 'POST', skipHttp: true, maxTier: 3,
      headers: { 'User-Agent': 'Mozilla/5.0 (Synthetic Browser)', 'Content-Type': 'application/x-www-form-urlencoded' },
      cookies: [{ name: 'guest_sid', value: COOKIE, domain: '.yalidine.com', path: '/', secure: true }] });
    expect(Object.fromEntries(new URLSearchParams(requests[1].body))).toEqual({ tracking: 'yal-ZQ8H7J', 'cf-turnstile-response': SECRET });
    expect(`${JSON.stringify(result)}${JSON.stringify(h.recorder.step.mock.calls)}`).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(COOKIE);
    expect(h.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok' }));
    expect(h.recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1, finalStep: 'trawl', outcome: 'ok' }));
  });

  it('reads a verified explicit negative and keeps generic retries as challenges', async () => {
    await expect(harness(bootstrap(), page(fixture('not-found'))).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness(bootstrap(), page(fixture('not-found').replace("Le colis que vous avez saisi n'existe pas.", 'Veuillez réessayer.'))).tracker.fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it.each([401, 403, 404, 405, 410])('preserves rejected or unavailable page HTTP %s without declaring absence', async statusCode => {
    const h = harness(bootstrap(), page(fixture('not-found'), { statusCode }));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: [401, 403].includes(statusCode) ? 'challenge' : 'transport', status: statusCode });
  });

  it('retains rate limits and retry time without credential diagnostics', async () => {
    const h = harness(bootstrap(), response({ error: SECRET }, 429, { 'retry-after': '7' }));
    let error: unknown; try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 7000 });
    expect(`${String(error)}${JSON.stringify(error)}${JSON.stringify(h.recorder.step.mock.calls)}`).not.toContain(SECRET);
    expect((error as Error).cause).toBeUndefined();
  });

  it.each([{ url: 'https://other.invalid/' }, { url: undefined }, { tier: 1 }])('rejects an unbound or non-browser response', async extra => {
    const h = harness(bootstrap(), page(fixture(), extra));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each(['', 'short'])('refuses a missing or malformed unused verification response', async token => {
    const h = harness(bootstrap({ html: `<input name="cf-turnstile-response" value="${token}">` }));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses duplicate tokens, invalid browser identity and oversized pages', async () => {
    const duplicate = harness(bootstrap({ html: `<input name="cf-turnstile-response" value="${SECRET}"><input name="cf-turnstile-response" value="${SECRET}">` }));
    await expect(duplicate.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const identity = harness(bootstrap({ userAgent: 'invalid\r\nidentity' }));
    await expect(identity.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness(bootstrap({ html: 'x'.repeat(1_000_001) })).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('does not retain arbitrary service errors or their causes', async () => {
    const h = harness(bootstrap(), response({ error: `${SECRET} ${COOKIE}` }));
    let error: unknown; try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'transport' });
    expect(`${String(error)}${JSON.stringify(error)}${JSON.stringify(h.recorder.step.mock.calls)}`).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(COOKIE);
  });

  it('requires TRAWL, reserves transport time and starts no request after cancellation', async () => {
    await expect(new YalidineTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const h = harness(bootstrap(), page());
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    const controller = new AbortController(); controller.abort(new Error('Cancelled'));
    await expect(h.tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Cancelled');
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it('provides native tracking while HTTP recognition starts no browser flow', async () => {
    const h = harness(bootstrap(), page());
    const native = adapter({ fetcher: h.fetcher, recorder: h.recorder, env: {}, trawl: new TrawlClient(SERVICE), browserExecutablePath: null });
    expect(native.recognize).toBeUndefined(); expect(h.fetcher).not.toHaveBeenCalled();
    await expect(native.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
  });
});
