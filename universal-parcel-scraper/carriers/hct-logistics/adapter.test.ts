import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HCT_RESULT, HCT_SEARCH, HctTracker } from './adapter.js';
import { hctResultUrl, hctSearchFields, normalizeHctNumber, parseHct } from './parser.js';
import { hctMappedStage, hctStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '9000000004';
const IN_TRANSIT = '9000000015';
const PICKUP = '9000000026';
const UNKNOWN = '9000000030';
const RESULT = `${HCT_RESULT}?no=U3lu%2B3RoZXRp%2F2Nubz0%3D&v=0123456789ABCDEF0123456789ABCDEF`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
// The run of scan rows on a result page.
const ROWS = /(?:\s*<div style="margin:0px 15px 10px 15px[^>]*>\s*<span id="rtprt_ctl\d+_L_time"[\s\S]*?<\/span>\s*<\/div>)+/;
type Scan = [clock: string, sentence: string];
const row = ([clock, sentence]: Scan, index: number) => `<div style="margin:0px 15px 10px 15px; padding:5px 0px 5px 0px" data-role="header">`
  + `<span id="rtprt_ctl${String(index).padStart(2, '0')}_L_time" style="color:Gray;">${clock}</span>`
  + `<span id="rtprt_ctl${String(index).padStart(2, '0')}_L_cls" style="margin-left:10px">${sentence}</span></div>`;
const branch = (name: string) => `<a href="tel:0200000009">${name}</a>`;
/** A result page with its scans replaced, or its row run changed, under the number given. */
const page = (change: Scan[] | ((rows: string) => string), number = DELIVERED) => fixture('delivered')
  .replace(ROWS, (rows) => (typeof change === 'function' ? change(rows) : change.map(row).join('')))
  .replace('<span id="L_invno">9000000004</span>', `<span id="L_invno">${number}</span>`);
const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
type Reply = string | (() => Response | Promise<Response>);
/** HCT's three pages: the search page, the search's answer and the result page. */
const site = (result: Reply, { search = fixture('search'), answer = fixture('answer') }: { search?: Reply; answer?: Reply } = {}) =>
  vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const page = String(url) === HCT_SEARCH ? (init?.method === 'POST' ? answer : search) : result;
    return typeof page === 'string' ? reply(page) : page();
  });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('HCT Logistics HTTP adapter', () => {
  it('posts the number on the app’s search page and opens the result it points to, through the supplied transport', async () => {
    const fetcher = site(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HctTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9000-000-015 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const headers = { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' };
    expect(fetcher.mock.calls[0]).toEqual([HCT_SEARCH, expect.objectContaining({ method: 'GET', redirect: 'manual', headers, signal: expect.any(AbortSignal) })]);
    expect(fetcher.mock.calls[1]).toEqual([HCT_SEARCH, expect.objectContaining({ method: 'POST', redirect: 'manual',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Referer: HCT_SEARCH } })]);
    expect(Object.fromEntries(new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body)))).toEqual({
      __VIEWSTATE: 'U3ludGhldGljIHZpZXcgc3RhdGUgKyBzbGFzaC8=', __VIEWSTATEGENERATOR: '0A1B2C3D',
      __EVENTVALIDATION: 'U3ludGhldGljIGV2ZW50IHZhbGlkYXRpb24=', __EVENTTARGET: 'Button1', __EVENTARGUMENT: '', txtpKey2: IN_TRANSIT,
    });
    // The ciphertext's + and / are encoded, so the server reads them back unchanged.
    expect(fetcher.mock.calls[2]).toEqual([RESULT, expect.objectContaining({ method: 'GET', redirect: 'manual', headers })]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hct-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('lists the scans newest first, in Taipei time, with the branch or centre in charge', () => {
    const result = parseHct(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '貨件已由西範例集配站送達。貨物件數共2件。', last_update: '2026-03-12T14:07:00+08:00', expected_delivery: null,
      delivered_at: '2026-03-12T14:07:00+08:00' });
    expect(result.events!.map((event) => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2026-03-12T14:07:00+08:00', '西範例集配站', '貨件已由西範例集配站送達。貨物件數共2件。', 'delivered'],
      ['2026-03-12T08:21:00+08:00', '西範例集配站', '貨件由西範例集配站人員配送中。', 'out_for_delivery'],
      ['2026-03-11T18:02:00+08:00', undefined, '與客戶另約時間配送。', 'failed_attempt'],
      ['2026-03-11T08:15:00+08:00', '西範例集配站', '貨件由西範例集配站人員配送中。', 'out_for_delivery'],
      ['2026-03-11T06:40:00+08:00', '西範例集配站', '貨件已抵達西範例集配站，分貨中。', 'in_transit'],
      ['2026-03-11T01:12:00+08:00', '範例轉運所', '貨件已由範例轉運所發出，前往配送站途中。', 'in_transit'],
      ['2026-03-10T22:30:00+08:00', '北範例營業所', '貨件由北範例營業所保管中。', 'in_transit'],
      ['2026-03-10T17:46:00+08:00', '北範例營業所', '貨件已抵達北範例營業所，貨件整理中。貨物件數共2件。', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
    // The branches' phone links are not kept.
    expect(JSON.stringify(result)).not.toMatch(/tel:|0200000/);
  });

  it('reads a parcel on its way', () => {
    expect(parseHct(fixture('in-transit'), IN_TRANSIT)).toEqual({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: '貨件已由範例轉運所發出，前往配送站途中。', last_update: '2026-04-18T02:30:00+08:00',
      expected_delivery: null, events: [
        { time: '2026-04-18T02:30:00+08:00', location: '範例轉運所', description: '貨件已由範例轉運所發出，前往配送站途中。', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-17T19:55:00+08:00', location: '南範例營業所', description: '貨件已抵達南範例營業所，貨件整理中。貨物件數共1件。', stage: 'accepted', stage_source: 'carrier_map' },
      ] });
  });

  it('keeps the current use of a number issued again, with the pickup notice in its place', () => {
    const result = parseHct(fixture('pickup'), PICKUP);
    expect(result).toEqual({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: '東範例營業所已至客戶端取回貨件。', last_update: '2026-06-25T09:25:00+08:00', expected_delivery: null, events: [
        { time: '2026-06-25T09:25:00+08:00', location: '東範例營業所', description: '東範例營業所已至客戶端取回貨件。', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-06-25T07:17:00+08:00', location: '東範例營業所', description: '東範例營業所已派遣人員取件中。', stage: 'registered', stage_source: 'carrier_map' },
        { time: '2026-06-24T15:05:00+08:00', description: '取貨通知處理中', stage: 'registered', stage_source: 'carrier_map' },
      ] });
    // Rows a few weeks apart stay one use.
    const weeks = parseHct(page([['2026/03/12 14:07', `貨件已由${branch('範例集配站')}送達。`], ['2026/02/01 09:00', '取貨通知處理中']]), DELIVERED);
    expect(weeks.events).toHaveLength(2);
  });

  it('keeps a notice’s day as a local date, and a notice without a stage out of the current stage', () => {
    const dated = parseHct(fixture('pickup').replace('2026/06/24 15:05', '2026/06/24 '), PICKUP);
    expect(dated.events![2]).toEqual({ local_time: '2026-06-24', description: '取貨通知處理中', stage: 'registered', stage_source: 'carrier_map' });
    const only = parseHct(page([['2026/06/24 ', '取貨通知處理中']], PICKUP), PICKUP);
    expect(only).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: null, last_update_local: '2026-06-24' });
    const called = parseHct(page([['2026/06/25 10:00', '另約時間再次取件。'], ['2026/06/25 09:58', '已電話聯繫，無人接聽。'],
      ['2026/06/25 07:17', `${branch('東範例營業所')}已派遣人員取件中。`]], PICKUP), PICKUP);
    expect(called).toMatchObject({ current_stage: 'registered', last_status_text: '另約時間再次取件。', last_update: '2026-06-25T10:00:00+08:00' });
    expect(called.events!.slice(0, 2).map((event) => 'stage' in event)).toEqual([false, false]);
    const none = parseHct(page([['2026/06/25 10:00', '已電話聯繫，無人接聽。']], PICKUP), PICKUP);
    expect(none).toMatchObject({ status: 'unknown', last_status_text: '已電話聯繫，無人接聽。' });
    expect(none).not.toHaveProperty('current_stage');
  });

  it('keeps a row listed twice once, orders rows by their clocks and caps a long history', () => {
    const doubled = parseHct(page((rows) => rows + row(['2026/03/12 08:21', `貨件由${branch('西範例集配站')}人員配送中。`], 99)), DELIVERED);
    expect(doubled.events).toHaveLength(8);
    const shuffled = parseHct(page([['2026/03/10 17:46', '貨件已抵達北範例營業所，貨件整理中。'], ['2026/03/12 14:07', '貨件已由西範例集配站送達。'],
      ['2026/03/11 01:12', '貨件已由範例轉運所發出，前往配送站途中。']]), DELIVERED);
    expect(shuffled.events!.map((event) => event.stage)).toEqual(['delivered', 'in_transit', 'accepted']);
    expect(shuffled).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-12T14:07:00+08:00' });
    const scans = Array.from({ length: 120 }, (_, index): Scan => [
      `2026/03/${String(1 + Math.floor(index / 24)).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00`, '貨件已抵達範例營業所，分貨中。']);
    const long = parseHct(page(scans), DELIVERED);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ history_truncated: true, last_update: '2026-03-05T23:00:00+08:00' });
  });

  it('counts a page only when it names the number asked', () => {
    expect(() => parseHct(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'HCT answered for another number' }));
    expect(() => parseHct(page((rows) => rows, '9000000041'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the page’s notice for a number without scans as not found, and another notice as a broken reply', async () => {
    await expect(carrier(site(fixture('not-found'))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site(fixture('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // The page's answer to a ciphertext it cannot decrypt.
    expect(() => parseHct(fixture('not-found').replace('查無此配送資料!!', '請確認加密是否正確'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'HCT could not read the number it was sent' }));
    expect(() => parseHct(page((rows) => rows, ''), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema', message: 'HCT returned scans without their number' }));
  });

  it('rejects a changed result page', () => {
    for (const html of [
      fixture('delivered').replace('id="L_invno"', 'id="invno"'),
      fixture('delivered').replace('id="lbl_stats"', 'id="stats"'),
      fixture('delivered').replace('<span id="lbl_stats"></span>', '<span id="lbl_stats"></span><span id="L_invno"></span>'),
      page([]),
      page((rows) => rows.replace('rtprt_ctl03_L_cls', 'rtprt_ctl03_L_note')),
      page((rows) => rows.replace(/rtprt_ctl03_L_(time|cls)/g, 'rtprt_ct03_L_$1')),
      page((rows) => rows.replace('rtprt_ctl03_L_cls', 'rtprt_ctl02_L_cls')),
      page([['2026/03/12 08:21', '']]),
      page([['2026-03-12 08:21', '貨件已抵達範例營業所，分貨中。']]),
      page([['2026/02/30 08:21', '貨件已抵達範例營業所，分貨中。']]),
      page([['2026/03/12 24:00', '貨件已抵達範例營業所，分貨中。']]),
      page([['', '貨件已抵達範例營業所，分貨中。']]),
      page(Array.from({ length: 1001 }, (): Scan => ['2026/03/12 08:21', '貨件已抵達範例營業所，分貨中。'])),
      '',
      '<html><head><title>新竹物流</title></head><body>系統維護中</body></html>',
    ]) {
      expect(() => parseHct(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects a changed search page or answer', () => {
    expect(() => hctSearchFields(fixture('search').replace('id="Button1"', 'id="Search"'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => hctSearchFields(fixture('search').replace('name="txtpKey2"', 'name="txtNo"').replace('name="txtpKey2"', 'name="txtNo"'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => hctSearchFields(fixture('search').replace(/name="__EVENTVALIDATION"[^>]*>/, '>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'HCT returned a search page without its state' }));
    expect(() => hctResultUrl(fixture('search'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => hctResultUrl(fixture('answer').replace('&v=0123456789ABCDEF0123456789ABCDEF', '&v=')))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(hctResultUrl(fixture('answer'))).toBe(RESULT);
  });

  it('keeps a browser check, a refusal, a moved route and a broken page apart from missing parcels', async () => {
    const check = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    const lookup = (result: Reply, pages: Parameters<typeof site>[1] = {}) => carrier(site(result, pages)).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { search: () => reply(check, 403) })).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(fixture('not-found'), { search: check })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(fixture('not-found'), { answer: check })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(check)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('', 302, { Location: '/app/error.aspx' }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(fixture('not-found'), { answer: () => reply('', 302, { Location: '/' }) })).rejects.toMatchObject({ kind: 'transport' });
    // Every page carries Cloudflare's beacon script, which is no browser check.
    await expect(lookup(fixture('not-found').replace('id="L_invno"', 'id="invno"'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>新竹物流</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response(new Uint8Array(1_100_000)))).rejects.toThrow('unexpectedly large');
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const refusal = () => reply('<html><title>Error</title></html>', status);
      const fetcher = site(fixture('delivered'), { search: refusal });
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
      const late = site(refusal);
      await expect(carrier(late).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(late).toHaveBeenCalledTimes(3);
    });

  it('recognizes a known number, and asks nothing for one HCT does not issue', async () => {
    const fetcher = site(fixture('delivered'));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T06:07:00.000Z' });
    await expect(carrier(fetcher).recognize!('900000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers HCT does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['900000000', '90000000041', 'HCT9000000', '900000000A', '', `9${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeHctNumber(' 9000-000-004 ')).toBe(DELIVERED);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = site(fixture('delivered'));
    flaky.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(4);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under HCT to the adapter, and leaves its digit run unclaimed', async () => {
    const fetcher = site(fixture('delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'hct-logistics' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'hct-logistics', source: 'hct-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('https://www.hct.com.tw/app/'))).toBe(true);
    for (const number of [DELIVERED, IN_TRANSIT, PICKUP]) expect(detectCarrierMatch(number).carrier).not.toBe('hct-logistics');
  });
});

describe('HCT Logistics status vocabulary', () => {
  it('maps every recorded wording to the stage it records, and leaves the notices without one', () => {
    const entries = statuses.entries as { wording: string; stage?: string; confirmedBy: string }[];
    expect(entries.filter((entry) => entry.confirmedBy === 'live').length).toBeGreaterThanOrEqual(10);
    for (const entry of entries) {
      expect(hctStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(hctMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'hct-logistics', description: entry.wording }), entry.wording)
        .toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(statusMap.gaps.map((gap) => gap.wording)).toEqual(entries.filter((entry) => !entry.stage).map((entry) => entry.wording));
    expect(statusMapAnswer({ carrier: 'hct-logistics', description: '範例貨態' })).toEqual({ kind: 'unknown' });
  });
});
