import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LBC_TRACK_PAGE, LBC_TRACK_REQUEST, LbcExpressTracker } from './adapter.js';
import { parseLbcMobile } from './mobile.js';
import { normalizeLbcNumber, parseLbcWebsite } from './parser.js';

type Json = Record<string, unknown>;

const NUMBER = '100000000001';
const website = (): Json => JSON.parse(readFileSync(new URL('./fixtures/website.json', import.meta.url), 'utf8')) as Json;
const mobileXml = () => readFileSync(new URL('./fixtures/mobile.xml', import.meta.url), 'utf8');
const trackingStatus = (reply: Json): Json => ['data', 'Body', 'LBCTrackAndTraceResponse', 'LBCTrackAndTraceResult', 'TrackingStatus']
  .reduce((node, key) => node[key] as Json, reply);
const details = (reply: Json): Json => (trackingStatus(reply).TrackingDetails as Json).TrackingDetails as Json;
const scans = (reply: Json): Json[] => (trackingStatus(reply).TrackingHistory as Json).TrackingHistory as Json[];
// The mobile API refuses its key, so the lookup goes on to the browser.
const refused: typeof fetch = async () => new Response('', { status: 401 });
const viaBrowser = () => new LbcExpressTracker({ executablePath: '/synthetic/chromium', fetcher: refused });

afterEach(() => vi.restoreAllMocks());

describe('LBC website history', () => {
  it('reads the app service’s result the website copies as the mobile tier reads it, without recipient data', () => {
    const result = parseLbcWebsite(website(), NUMBER);
    expect(result).toEqual(parseLbcMobile(mobileXml(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-10-02T15:40:01' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SYNTHETIC RECIPIENT/);
  });
  it('reads a single scan copied as an object and empty elements as blanks', () => {
    const reply = website();
    trackingStatus(reply).TrackingHistory = { TrackingHistory: { ...scans(reply)[0], CityName: [], ProvinceName: {} } };
    const result = parseLbcWebsite(reply, NUMBER);
    expect(result.events).toHaveLength(1);
    expect(result.events?.[0]).toMatchObject({ provider_code: '8000', stage: 'accepted', local_time: '2026-10-01T09:15:20' });
    expect(result.events?.[0]).not.toHaveProperty('location');
  });
  it.each(['wrong identity', 'missing identity', 'two shipments', 'nested text', 'numeric value', 'bad clock', 'missing history', 'bare WordPress answer'])(
    'rejects %s without exposing reply data', mode => {
      let reply: unknown = website();
      const edited = reply as Json;
      if (mode === 'wrong identity') details(edited).TrackingNo = '100000000002';
      if (mode === 'missing identity') delete details(edited).TrackingNo;
      if (mode === 'two shipments') trackingStatus(edited).TrackingDetails = { TrackingDetails: [details(edited), details(edited)] };
      if (mode === 'nested text') details(edited).TrackingNo = { Other: NUMBER };
      if (mode === 'numeric value') scans(edited)[0]!.StatusId = 8000;
      if (mode === 'bad clock') scans(edited)[0]!.DatePostedTime = '29:15:20 AM';
      if (mode === 'missing history') delete trackingStatus(edited).TrackingHistory;
      if (mode === 'bare WordPress answer') reply = -1;
      let error: unknown;
      try { parseLbcWebsite(reply, NUMBER); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ kind: 'schema' });
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain('PRIVATE');
    });
  it.each(['remittance', 'empty history', 'SOAP fault'])('keeps %s inconclusive', mode => {
    const reply = website();
    if (mode === 'remittance') Object.assign(trackingStatus(reply), { StatusCode: '103', TrackingDetails: [], TrackingHistory: [] });
    if (mode === 'empty history') trackingStatus(reply).TrackingHistory = [];
    if (mode === 'SOAP fault') (reply.data as Json).Body = { Fault: { faultstring: 'PRIVATE' } };
    expect(() => parseLbcWebsite(reply, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it('keeps WordPress’s error answer distinct from shipment absence', () => {
    expect(() => parseLbcWebsite({ success: false, data: 'PRIVATE' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'transport' }));
  });
  it('validates input before retrieval', () => {
    expect(normalizeLbcNumber(' 1000 0000 0001 ')).toBe(NUMBER);
    for (const number of ['1000000001', '10000000001', '10000000000001']) expect(normalizeLbcNumber(number)).toBe(number);
    for (const number of ['100000001', '1000000000001', '100000000000001']) {
      expect(() => normalizeLbcNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(() => normalizeLbcNumber('100000000001&x=1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

interface Exchange { method?: string; url?: string; body?: string; frame?: object; status?: number; headers?: Record<string, string>; raw?: string; reply?: unknown }

function browserSeam() {
  const mainFrame = {};
  let currentUrl = 'about:blank';
  // The page's requests in order; by default its tracking request for the number, answered with the fixture.
  const exchanges: Exchange[] = [{}];
  const body = vi.fn(async (exchange: Exchange) => Buffer.from(exchange.raw ?? JSON.stringify(exchange.reply ?? website())));
  const response = (exchange: Exchange) => ({
    request: () => ({ method: () => exchange.method ?? 'POST', url: () => exchange.url ?? LBC_TRACK_REQUEST, frame: () => exchange.frame ?? mainFrame,
      postData: () => exchange.body ?? `action=track_package&security=SYNTHETIC_NONCE&trackingNumber=${NUMBER}` }),
    status: () => exchange.status ?? 200,
    headers: () => exchange.headers ?? { 'content-type': 'application/json; charset=UTF-8' },
    body: () => body(exchange),
  });
  const page = {
    mainFrame: () => mainFrame,
    // Resolves with the first response the predicate accepts, as Playwright does.
    waitForResponse: vi.fn(async (predicate: (candidate: never) => boolean) => {
      for (const exchange of exchanges) {
        const candidate = response(exchange);
        if (predicate(candidate as never)) return candidate;
      }
      throw new Error('Synthetic timeout');
    }),
    goto: vi.fn(async (url: string) => { currentUrl = url; return { status: (): number => 200 }; }),
    url: () => currentUrl,
  };
  const context = { newPage: vi.fn(async () => page) };
  const browser = { version: () => '148.0.0.0', newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  const launch = vi.spyOn(chromium, 'launch').mockResolvedValue(browser as never);
  return { page, context, browser, launch, exchanges, body };
}

describe('LBC bounded anonymous browser transport', () => {
  it('recovers from an explicit mobile origin failure and preserves transport provenance', async () => {
    const seam = browserSeam(), recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const fetcher: typeof fetch = async () => new Response(
      '<html><title>DNS points to prohibited IP | tracking.example | Cloudflare</title><h1>Error 1000</h1></html>', { status: 403 });
    const instance = adapter({ browserExecutablePath: '/synthetic/chromium', trawl: null, recorder, fetcher, env: {} });
    await expect(instance.track({ number: NUMBER }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(recorder.step.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({ step: 'direct', outcome: 'transport' }),
      expect.objectContaining({ step: 'browser', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'transport' }),
    ]);
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });
  it('recovers from a refused mobile key with browser history and records the refusal', async () => {
    const seam = browserSeam(), recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const instance = adapter({ browserExecutablePath: '/synthetic/chromium', trawl: null, recorder, fetcher: refused, env: {} });
    await expect(instance.track({ number: NUMBER }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(recorder.step.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({ step: 'direct', outcome: 'challenge' }),
      expect.objectContaining({ step: 'browser', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'challenge' }),
    ]);
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });
  it('opens the page’s own link for the number in a fresh session and observes its request before navigating', async () => {
    const seam = browserSeam(), recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const instance = adapter({ browserExecutablePath: '/synthetic/chromium', trawl: null, recorder, fetcher: refused, env: {} });
    await expect(instance.track({ number: NUMBER }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(seam.page.goto.mock.calls.map(call => call[0])).toEqual([`${LBC_TRACK_PAGE}?tracking-number=${NUMBER}`]);
    expect(seam.page.waitForResponse.mock.invocationCallOrder[0]).toBeLessThan(seam.page.goto.mock.invocationCallOrder[0]!);
    expect(Object.keys(seam.launch.mock.calls[0]![0]!.env!)).toEqual(['PATH', 'HOME', 'LANG']);
    expect(seam.browser.close).toHaveBeenCalledOnce();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'browser', outcome: 'ok' }));
  });
  it('reads only the page’s tracking request for the whole number', async () => {
    const seam = browserSeam(), refusal = { success: false, data: 'PRIVATE' };
    seam.exchanges.unshift(
      { body: `action=get_domestic_cities&security=SYNTHETIC_NONCE&trackingNumber=${NUMBER}`, reply: refusal },
      { body: `action=track_package&security=SYNTHETIC_NONCE&trackingNumber=${NUMBER}0`, reply: refusal },
      { body: 'action=track_package&security=SYNTHETIC_NONCE&trackingNumber=100000000002', reply: refusal },
      { method: 'GET', reply: refusal },
      { url: 'https://other.example/wp-admin/admin-ajax.php', reply: refusal },
      { frame: {}, reply: refusal },
    );
    await expect(viaBrowser().fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(seam.body).toHaveBeenCalledOnce();
  });
  it.each([403, 404, 410, 429, 503])('keeps tracking request HTTP %s distinct from shipment absence', async status => {
    const seam = browserSeam(); seam.exchanges[0]!.status = status;
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ status,
      kind: status === 403 ? 'challenge' : status === 429 ? 'rate_limited' : status === 503 ? 'maintenance' : 'transport' });
    expect(seam.body).not.toHaveBeenCalled();
  });
  it('keeps a missing tracking page distinct from shipment absence', async () => {
    const seam = browserSeam(); seam.page.goto.mockResolvedValue({ status: () => 404 });
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status: 404 });
    expect(seam.body).not.toHaveBeenCalled();
  });
  it.each(['declared size', 'body size', 'invalid JSON'])('rejects tracking data by its %s', async mode => {
    const seam = browserSeam();
    if (mode === 'declared size') seam.exchanges[0]!.headers = { 'content-length': '1000001' };
    if (mode === 'body size') seam.exchanges[0]!.raw = 'x'.repeat(1_000_001);
    if (mode === 'invalid JSON') seam.exchanges[0]!.raw = '<html>PRIVATE</html>';
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(seam.body).toHaveBeenCalledTimes(mode === 'declared size' ? 0 : 1);
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });
  it('keeps the website’s inconclusive answer for a remittance number', async () => {
    const seam = browserSeam(), reply = website();
    Object.assign(trackingStatus(reply), { StatusCode: '103', TrackingDetails: [], TrackingHistory: [] });
    seam.exchanges[0]!.reply = reply;
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });
  it('rejects a page that redirected away from the tracking page', async () => {
    const seam = browserSeam(), navigate = seam.page.goto.getMockImplementation()!;
    seam.page.goto.mockImplementation(async () => navigate('https://www.lbcexpress.com/'));
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema', message: 'LBC redirected away from the tracking page' });
  });
  it('does not expose the number or request from a failed browser navigation', async () => {
    const seam = browserSeam();
    seam.page.goto.mockImplementation(async url => { throw new Error(`page.goto failed ${url}`); });
    const error: unknown = await viaBrowser().fetch(NUMBER).catch(caught => caught);
    expect(error).toMatchObject({ kind: 'transport', message: 'LBC browser tracking failed' });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain(NUMBER);
  });
  it('waits for the website’s automatic JavaScript reload after an initial challenge document', async () => {
    const seam = browserSeam(), navigate = seam.page.goto.getMockImplementation()!;
    seam.page.goto.mockImplementation(async url => { await navigate(url); return { status: () => 403 }; });
    await expect(viaBrowser().fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
  });
  it('keeps an unfinished website challenge distinct from shipment absence', async () => {
    const seam = browserSeam(), navigate = seam.page.goto.getMockImplementation()!;
    seam.page.goto.mockImplementation(async url => { await navigate(url); return { status: () => 403 }; });
    seam.exchanges.length = 0;
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });
  it('reports a page that sends no tracking request as a transport failure', async () => {
    const seam = browserSeam(); seam.exchanges.length = 0;
    await expect(viaBrowser().fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', message: 'LBC tracking page sent no tracking request' });
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });
  it('closes its browser when the lookup is cancelled while the page answers', async () => {
    const seam = browserSeam(), controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    seam.page.waitForResponse.mockImplementation(() => { entered(); return new Promise(() => {}); });
    const pending = viaBrowser().fetch(NUMBER, { signal: controller.signal });
    await ready; controller.abort(new Error('Synthetic cancellation'));
    await expect(pending).rejects.toThrow('Synthetic cancellation');
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });
  it('rejects invalid or pre-aborted input before browser work', async () => {
    const seam = browserSeam();
    expect(() => viaBrowser().fetch('bad')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    await expect(viaBrowser().fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(seam.launch).not.toHaveBeenCalled();
  });
});
