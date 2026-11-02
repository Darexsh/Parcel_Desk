import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FIRST_LINE_PAGE, FirstLineTracker } from './adapter.js';
import { normalizeFirstLineNumber, parseFirstLine, parseFirstLinePage } from './parser.js';
import { firstLineStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1ST00000000001';
const EXPORT = '1ST00000000002';
const UNKNOWN = '1ST00000000009';
const LOOKUP = 'query.php?meter=track_query&nonce=0000000000000000000000000000TEST&timestamp=1790000000&sign=0000000000000000000000000000000000000000';
const SESSION = 'PHPSESSID=0000000000000000000000abcd';
const TOKEN = 'tokenc=0000000000000000000000000000ef01';
// Long after every fixture's newest scan.
const READ_AT = Date.parse('2026-11-01T00:00:00Z');

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PAGE = text('page.html');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...init.headers } });
const page = (body = PAGE, cookies = [`${SESSION}; path=/`, `${TOKEN}; path=/`], status = 200) => new Response(body, { status,
  headers: [['Content-Type', 'text/html;charset=UTF-8'], ...cookies.map((cookie) => ['set-cookie', cookie] as [string, string])] });
/** A site that serves the tracking page, then `lookup` for the signed address. */
const site = (lookup: () => Response, opened: () => Response = () => page()) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => (String(url) === FIRST_LINE_PAGE ? opened() : lookup()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const BUSY = '服务器繁忙，请稍后再试';
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('FIRST LINE HTTP adapter', () => {
  it('opens the tracking page, then posts the number to the address it signed with both session cookies', async () => {
    const fetcher = site(() => html(text('delivered.txt')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FirstLineTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1st 0000000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(pageUrl).toBe(FIRST_LINE_PAGE);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(url).toBe(`http://www.firstline56.com/${LOOKUP}`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `track_number=${DELIVERED}`, headers: {
      'User-Agent': 'SyntheticHost/1.0', Cookie: `${SESSION}; ${TOKEN}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', Referer: FIRST_LINE_PAGE } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'first-line', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates the Chinese leg on Beijing’s clock, keeps the destination’s wall clocks and places without postcodes, in the tracker’s order, each once', () => {
    const result = parseFirstLine(text('delivered.txt'), DELIVERED, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered, Parcel Locker',
      last_update: null, last_update_local: '2026-03-17T15:30:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location, event.description, event.stage, event.stage_source])).toEqual([
      ['2026-03-17T15:30:00', 'SAMPLE TOWN FL', 'Delivered, Parcel Locker', 'delivered', 'wording:language'],
      ['2026-03-17T06:10:00', 'SAMPLE TOWN FL', 'Out for Delivery, Expected Delivery by 9:00pm', 'out_for_delivery', 'wording:language'],
      ['2026-03-15T21:04:00', 'EXAMPLE CITY FL DISTRIBUTION CENTER', 'Arrived at USPS Regional Facility', 'in_transit', 'wording:language'],
      ['2026-03-14T13:35:00', undefined, 'In Transit, Arriving Late', 'in_transit', 'wording:language'],
      ['2026-03-12T12:00:14', 'New York NY USA', 'Released from customs: customs cleared.', 'in_transit', 'wording:language'],
      ['2026-03-11T20:53:44', 'New York NY USA', 'Arrived at destination airport', 'in_transit', 'wording:language'],
      ['2026-03-11T03:15:15+08:00', 'HK international airport', 'Customs clearance begins', 'customs', 'wording:language'],
      ['2026-03-10T08:16:37+08:00', 'SHENZHEN', 'Depart from facility to service provider', 'in_transit', 'carrier_map'],
      ['2026-03-09T16:15:29+08:00', 'SHENZHEN', 'Packaged', 'in_transit', 'carrier_map'],
      ['2026-03-09T13:08:38+08:00', 'SHENZHEN', 'Shipment arrived', 'accepted', 'carrier_map'],
      ['2026-03-09T04:24:59', undefined, 'Parcel information received', 'registered', 'carrier_map'],
      ['2026-03-09T01:30:00', 'SAMPLE HUB GA', 'Shipping Label Created, USPS Awaiting Item', 'registered', 'wording:language'],
    ]);
    // The United States' clocks, and a row with no place that is not the shipper's order data, are not given an offset.
    expect(result.events!.filter((event) => event.local_time).map((event) => event.location ?? null))
      .toEqual(['SAMPLE TOWN FL', 'SAMPLE TOWN FL', 'EXAMPLE CITY FL DISTRIBUTION CENTER', null, 'New York NY USA', 'New York NY USA', null, 'SAMPLE HUB GA']);
    expect(JSON.stringify(result)).not.toMatch(/0000[12]|&nbsp;/);
  });

  it('reads a parcel at the Shenzhen warehouse after its export declaration as in transit', () => {
    const result = parseFirstLine(text('export.txt'), EXPORT, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Export customs declaration completed', last_update: '2026-10-20T16:41:31+08:00' });
    expect(result.last_update_local).toBeUndefined();
    // 17TRACK's copies of these rows have the same instants, the shipper's order data, which names no place, too.
    expect(result.events!.map((event) => [event.description, event.stage, event.time])).toEqual([
      ['Export customs declaration completed', 'in_transit', '2026-10-20T16:41:31+08:00'], ['Leaving Scan', 'in_transit', '2026-10-18T06:28:11+08:00'],
      ['Packaged', 'in_transit', '2026-10-18T02:34:12+08:00'], ['Barcode scanning', 'accepted', '2026-10-17T22:30:52+08:00'],
      ['Forecast has been received', 'registered', '2026-10-15T16:08:38+08:00'],
    ]);
  });

  it('holds back a row dated after the read on China’s clock, the latest it can be on', () => {
    // 16:41:31 in Shenzhen is 08:41:31 UTC.
    const rows = parseFirstLine(text('export.txt'), EXPORT, Date.parse('2026-10-20T08:41:30Z')).events!;
    expect(rows[0]).toMatchObject({ description: 'Leaving Scan' });
    expect(parseFirstLine(text('export.txt'), EXPORT, Date.parse('2026-10-20T08:41:31Z')).events![0]).toMatchObject({ description: 'Export customs declaration completed' });
    expect(() => parseFirstLine(text('export.txt'), EXPORT, Date.parse('2026-10-15T00:00:00Z'))).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads the tracker’s notice as no answer about the waybill, which another forwarder may hold, and a refused session as nothing', async () => {
    expect(() => parseFirstLine(text('not-found.txt'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    await expect(carrier(site(() => html(text('not-found.txt')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    expect(() => parseFirstLine(text('not-found.txt').replace('未找到此单号信息', '系统繁忙'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(site(() => html(text('refused.txt')))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(() => parseFirstLine('error{FGF}系统繁忙', DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps only a reply for the waybill asked for', () => {
    expect(() => parseFirstLine(text('delivered.txt'), EXPORT, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'FIRST LINE did not answer for the number once' }));
    const twice = text('delivered.txt').replace(/^ok\{FGF\}(.*)$/s, (_all, list: string) => `ok{FGF}${list}${list.slice(list.indexOf('<div class="track_list">'))}`);
    expect(() => parseFirstLine(twice, DELIVERED, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    const delivered = text('delivered.txt');
    for (const [index, body] of [
      '',
      '<html><body>Sample maintenance page</body></html>',
      delivered.replace('ok{FGF}', 'done{FGF}'),
      delivered.replaceAll('<div class="track_list">', '<div class="list">'),
      delivered.replace('2026-03-17 15:30:00&nbsp;', '17/03/2026 15:30&nbsp;'),
      delivered.replace('2026-03-17 15:30:00&nbsp;', '2026-03-17 24:00:00&nbsp;'),
      delivered.replace('2026-03-17 15:30:00&nbsp;', '2026-02-30 15:30:00&nbsp;'),
      delivered.replace('&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Delivered', ' Delivered'),
      delivered.replace(/(<ul[^>]*>)(.*?)(<\/ul>)/s, (_all, open: string, rows: string, close: string) => open + rows.repeat(40) + close),
    ].entries()) {
      expect(() => parseFirstLine(body, DELIVERED, READ_AT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseFirstLine(CLOUDFLARE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    // A listed waybill without scans or a notice is not settled.
    expect(() => parseFirstLine(delivered.replace(/<ul[^>]*>.*<\/ul>/s, ''), DELIVERED, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('needs the lookup address the page signed', () => {
    expect(parseFirstLinePage(PAGE)).toBe(LOOKUP);
    for (const changed of [PAGE.replace('&sign=', '&signature='), PAGE.replace('meter=track_query', 'meter=query'), '<html><body>Sample page</body></html>']) {
      expect(() => parseFirstLinePage(changed)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseFirstLinePage(CLOUDFLARE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps a missing session, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: () => Response, opened?: () => Response) => carrier(site(body, opened)).track({ number: DELIVERED });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    // The site's own throttle answers 403 "server busy"; another 403 refuses the visitor.
    await expect(lookup(() => html(BUSY, { status: 403 }))).rejects.toMatchObject({ kind: 'rate_limited', status: 403 });
    await expect(lookup(() => html('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'http://www.firstline56.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    // The tracking page itself: without both cookies, moved, behind a check or changed, the lookup is not made.
    for (const [response, expected] of [
      [() => page(PAGE, [`${SESSION}; path=/`]), { kind: 'indeterminate', reason: 'session_rejected' }],
      [() => page(PAGE, []), { kind: 'indeterminate', reason: 'session_rejected' }],
      [() => page('', [], 404), { kind: 'transport', status: 404 }],
      [() => page('', [], 301), { kind: 'transport', status: 301 }],
      [() => page(CLOUDFLARE), { kind: 'challenge' }],
      [() => page(BUSY, [`${SESSION}; path=/`], 403), { kind: 'rate_limited', status: 403 }],
      [() => page('<html><body>Forbidden</body></html>', [], 403), { kind: 'challenge', status: 403 }],
      [() => page('<html><body>Sample page</body></html>'), { kind: 'schema' }],
    ] as const) {
      const fetcher = site(() => html(text('delivered.txt')), response);
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject(expected);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s from the page and from the lookup', async (status, kind) => {
      const fromLookup = site(() => new Response('', { status }));
      await expect(carrier(fromLookup).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fromLookup).toHaveBeenCalledTimes(2);
      const fromPage = site(() => html(text('delivered.txt')), () => new Response('', { status }));
      await expect(carrier(fromPage).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fromPage).toHaveBeenCalledTimes(1);
    });

  it('refuses what the tracker cannot look up, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1ST0000000001', '1ST000000000011', '2ST00000000001', 'IST00000000001', '1ST0000000000A', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFirstLineNumber(' 1st-00000000001 ')).toBe(DELIVERED);
  });

  it('tries an attempt that hangs once more, in a new session, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url) === FIRST_LINE_PAGE)).toBe(true);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('routes a 1ST waybill to the adapter', async () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'first-line', confidence: 'high' });
    for (const number of ['1ST0000000001', '1ST000000000011', '1SZ00000000001']) expect(detectCarrierMatch(number).candidates).not.toContain('first-line');
    const fetcher = site(() => html(text('delivered.txt')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'first-line', source: 'first-line', result: { current_stage: 'delivered' } });
  });
});

describe('FIRST LINE status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'first-line', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('leaves the delivering partner’s wording to the shared rules', () => {
    expect(firstLineStage(null, 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'first-line', providerCode: null, description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
