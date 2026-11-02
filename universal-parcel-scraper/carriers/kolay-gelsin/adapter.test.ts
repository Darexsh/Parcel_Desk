import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { isPartialAnswer } from '../../core/result/partial.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KOLAY_GELSIN_CHECK, KOLAY_GELSIN_PAGE, KolayGelsinTracker } from './adapter.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const NUMBER = fixture().props.pageProps.q as string;
const SERVICE = 'https://trawl.invalid';
const SECRET = 'SYNTHETIC-UNUSED-TURNSTILE-RESPONSE-731594268';
const CAPABILITY = 'SYNTHETIC-PRIVATE-GUEST-QID';
const SESSION = 'SYNTHETIC-PRIVATE-GUEST-COOKIE';
const BOOT = `${KOLAY_GELSIN_PAGE}?${new URLSearchParams({ q: NUMBER })}`;
const LANDING = `${KOLAY_GELSIN_PAGE}?${new URLSearchParams({ q: NUMBER, qid: CAPABILITY })}`;
const owned = { name: 'sendeo_sid', value: SESSION, domain: '.kolaygelsin.com', path: '/', secure: true, httpOnly: true };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const page = (url: string, html: string, extra: Record<string, unknown> = {}) => response({ url, html, tier: 3, statusCode: 200, cookies: [], ...extra });
const bootstrap = () => page(BOOT, `<body><input type="hidden" name="cf-turnstile-response" value="${SECRET}"></body>`);
const check = (data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => page(KOLAY_GELSIN_CHECK, JSON.stringify({
  success: true, result: true, isKG: false, isSENDEO: true, trackingNumber: NUMBER, qid: CAPABILITY, ...data,
}), { cookies: [owned, { ...owned, domain: '.other.invalid' }, { ...owned, name: 'account_sid', path: '/account' }], ...extra });
const landing = (change?: (data: ReturnType<typeof fixture>) => void, url = LANDING) => {
  const data = fixture(); data.query.qid = CAPABILITY; change?.(data);
  return page(url, `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`);
};
function harness(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>(); for (const reply of replies) fetcher.mockResolvedValueOnce(reply);
  const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
  return { fetcher, recorder, tracker: new KolayGelsinTracker({ fetcher, recorder, trawl: new TrawlClient(SERVICE) }) };
}

describe('Kolay Gelsin guest retrieval', () => {
  it('verifies the whole number and imports only its carrier guest cookie into the landing browser', async () => {
    const h = harness(bootstrap(), check(), landing());
    const result = await h.tracker.fetch(NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', history_truncated: true });
    expect(result.events).toHaveLength(5);
    expect(isPartialAnswer(result)).toBe(true);
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    const requests = h.fetcher.mock.calls.map(([url, init]) => {
      expect(String(url)).toBe(`${SERVICE}/scrape`); expect(init!.signal).toBeInstanceOf(AbortSignal);
      return JSON.parse(String(init!.body));
    });
    expect(requests.every(request => request.skipHttp === true && request.maxTier === 3)).toBe(true);
    expect(requests[1]).toMatchObject({ url: KOLAY_GELSIN_CHECK, method: 'POST',
      body: JSON.stringify({ trackNumber: NUMBER, captchaCode: SECRET, isRedirected: false }) });
    expect(requests[2]).toMatchObject({ url: LANDING, cookies: [owned] });
    for (const request of requests) expect(request.headers?.Cookie).toBeUndefined();
    for (const value of [SECRET, SESSION, CAPABILITY]) expect(`${JSON.stringify(result)}${JSON.stringify(h.recorder.step.mock.calls)}`).not.toContain(value);
  });

  it('uses the official KG branch without adopting an opaque tracking link', async () => {
    const target = `${KOLAY_GELSIN_PAGE}?${new URLSearchParams({ q: NUMBER, qid: NUMBER, redirected: 'true' })}`;
    const h = harness(bootstrap(), check({ isKG: true, isSENDEO: false, qid: undefined }), landing(data => {
      data.props.pageProps.shipmentDetails.isKGShipment = true; data.query.qid = NUMBER;
    }, target));
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(JSON.parse(String(h.fetcher.mock.calls[2]![1]!.body)).url).toBe(target);
  });

  it.each([399, 401, 403])('preserves rejected verification as challenge with HTTP %s', async statusCode => {
    const h = harness(bootstrap(), check({}, { statusCode }));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', status: statusCode });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { trackingNumber: NUMBER + '7' }, { trackingNumber: {} }, { isKG: false, isSENDEO: false },
    { isKG: true, isSENDEO: true }, { referenceCode: 'SYNTHETIC-RECIPIENT-VERIFICATION' }, { success: false },
  ])('rejects wrong identities, other networks and additional verification', async changed => {
    const h = harness(bootstrap(), check(changed));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not load an unauthenticated Sendeo result or invent a session cookie', async () => {
    const h = harness(bootstrap(), check({}, { cookies: [{ ...owned, domain: '.other.invalid' }] }));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    (data: ReturnType<typeof fixture>) => { data.props.pageProps.shipmentDetails.isKGShipment = true; },
    (data: ReturnType<typeof fixture>) => { data.query.qid = 'SYNTHETIC-OTHER-QID'; },
    (data: ReturnType<typeof fixture>) => { data.props.pageProps.shipmentDetails.IsOtpRequired = true; },
  ])('keeps platform, capability and recipient-verification ambiguity inconclusive', async change => {
    await expect(harness(bootstrap(), check(), landing(change)).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('never exposes a private capability from a landing transport error', async () => {
    const h = harness(bootstrap(), check(), response({ error: `${CAPABILITY} ${SESSION}` }));
    let error: unknown;
    try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'transport' });
    for (const value of [SECRET, SESSION, CAPABILITY]) expect(`${String(error)}${JSON.stringify(error)}${JSON.stringify(h.recorder.step.mock.calls)}`).not.toContain(value);
    expect((error as Error).cause).toBeUndefined();
  });

  it.each([404, 405, 410])('treats unavailable routes as transport failures (%s)', async statusCode => {
    await expect(harness(bootstrap(), check({}, { statusCode })).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('does not substitute a wrong or redirected landing page', async () => {
    const h = harness(bootstrap(), check(), landing(undefined, 'https://other.invalid/'));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('requires TRAWL, respects the budget reserve and does not start after cancellation', async () => {
    await expect(new KolayGelsinTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const h = harness(bootstrap());
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    const controller = new AbortController(); controller.abort(new Error('Cancelled'));
    await expect(h.tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Cancelled');
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it('tracks the explicit carrier with providers disabled and keeps HTTP recognition browserless', async () => {
    const h = harness(bootstrap(), check(), landing());
    const native = adapter({ fetcher: h.fetcher, recorder: h.recorder, env: {}, trawl: new TrawlClient(SERVICE), browserExecutablePath: null });
    expect(native.recognize).toBeUndefined();
    await expect(createTracker({ providers: [], trawlUrl: SERVICE, fetcher: h.fetcher })
      .track({ number: NUMBER, carrier: 'kolay-gelsin' })).resolves.toMatchObject({ source: 'kolay-gelsin', result: { status: 'delivered', history_truncated: true } });
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });
});
