import { readFileSync } from 'node:fs';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LastOneMileTracker, lastOneMileUrl } from './adapter.js';
import { decodeLastOneMilePage, normalizeLastOneMileNumber, parseLastOneMile } from './parser.js';
import { lastOneMileStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000000015';
const IN_TRANSIT = '100000000026';
const UNKNOWN = '100000000030';
const SJIS = 'text/html;charset=Shift_JIS';
// The companies, the offices' contact links, the parcel count and the drop-off button.
const PRIVATE = /ラストワンマイル協同組合|SearchServlet|company_code|個|置/;
// Cloudflare's managed challenge, which a CDN in front of the site could serve in place of the page.
const CHALLENGE = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>'
  + '<script>(function(){window._cf_chl_opt={cvId:"3",cType:"managed"};})();</script></body></html>';
// The refusal an F5 firewall serves.
const REJECTED = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. '
  + 'Please consult with your administrator.<br><br>Your support ID is: 0000000000000000000</body></html>';

/** A fixture's bytes, in Shift_JIS as the tracker serves them. */
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url)));
const page = (name: string) => new TextDecoder('shift_jis').decode(bytes(name));
/** The page with a change made through cheerio. */
const edited = (name: string, edit: ($: CheerioAPI) => void) => {
  const $ = load(page(name));
  edit($);
  return $.html();
};
const listRow = ($: CheerioAPI) => $('input[name="number01"]').closest('tr').children('td');
const detail = ($: CheerioAPI) => $('a[name="A00"]').next('table');
const history = ($: CheerioAPI) => $('td').filter((_, cell) => $(cell).text().trim() === '貨物状況').closest('table').children('tbody');
const firstRow = ($: CheerioAPI) => history($).children('tr').eq(1).children('td');
const row = (state: string, number = DELIVERED) => `<tr><td>${state}<br></td><td>2026/03/18<br>14:00:00</td>`
  + `<td>見本運輸株式会社<br></td><td>見本営業所<br></td><td>${number}<br></td></tr>`;
const serving = (body: BodyInit, init: ResponseInit = { headers: { 'Content-Type': SJIS } }) =>
  vi.fn<typeof fetch>().mockImplementation(async () => new Response(typeof body === 'string' ? body : new Uint8Array(body as Uint8Array), init));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Last One Mile Co-op tracking page', () => {
  it('asks for the co-op’s page of the whole number through the supplied transport', async () => {
    const fetcher = serving(bytes('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LastOneMileTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000-0000-0015 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`https://y-track.jp/ytrack/inqservlet?cd=81118&id=02116&number01=${DELIVERED}`);
    expect(lastOneMileUrl(DELIVERED)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', Accept: 'text/html', 'Accept-Language': 'ja' } });
    expect(init.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'last-one-mile-coop', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the page in the charset its header or its meta tag declares', async () => {
    const delivered = { status: 'delivered', last_status_text: '配達完了' };
    await expect(new LastOneMileTracker({ fetcher: serving(bytes('delivered')) }).fetch(DELIVERED)).resolves.toMatchObject(delivered);
    await expect(new LastOneMileTracker({ fetcher: serving(bytes('delivered'), { headers: { 'Content-Type': 'text/html' } }) }).fetch(DELIVERED))
      .resolves.toMatchObject(delivered);
    await expect(new LastOneMileTracker({ fetcher: serving(bytes('delivered'), {}) }).fetch(DELIVERED)).resolves.toMatchObject(delivered);
    const utf8 = new TextEncoder().encode(page('delivered').replace('charset=Shift_JIS">', 'charset=utf-8">'));
    expect(parseLastOneMile(decodeLastOneMilePage(utf8, null), DELIVERED)).toMatchObject(delivered);
    expect(() => decodeLastOneMilePage(bytes('delivered'), 'text/html; charset=x-synthetic')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('dates each row in Japan’s zone and drops the companies, the contact links and the parcel count', () => {
    const result = parseLastOneMile(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '配達完了', last_update: '2026-03-18T13:52:09+09:00', expected_delivery: null,
      delivered_at: '2026-03-18T13:52:09+09:00', timezone: 'Asia/Tokyo' });
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events!.map((event) => [event.time, event.description, event.stage, event.location])).toEqual([
      ['2026-03-18T13:52:09+09:00', '配達完了', 'delivered', '見本営業所'],
      ['2026-03-18T09:16:20+09:00', '配達中', 'out_for_delivery', '見本営業所'],
      ['2026-03-18T09:15:20+09:00', '中継連絡', 'in_transit', 'LOM試験本部'],
      ['2026-03-17T23:03:44+09:00', '引受', 'accepted', '見本運輸株式会社'],
      ['2026-03-17T23:02:44+09:00', '中継連絡', 'in_transit', 'LOM試験本部'],
      ['2026-03-17T22:41:05+09:00', '引受', 'accepted', '見本センター'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toEqual({ mode: 'automatic', adapter: 'last-one-mile-coop', steps: ['direct', 'retry'], recognition: { rank: 585 } });
    expect(metadata.detection).toEqual([]);
  });

  it('takes each row’s year from the page across New Year', () => {
    const result = parseLastOneMile(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: '引受', last_update: '2026-01-01T00:21:12+09:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.description, event.location])).toEqual([
      ['2026-01-01T00:21:12+09:00', '引受', '見本営業所'],
      ['2026-01-01T00:20:12+09:00', '中継連絡', 'LOM試験本部'],
      ['2025-12-31T23:48:31+09:00', '引受', '試験ハブセンター'],
    ]);
  });

  it('takes the list’s state over the rows, and the newest staged row’s when the map does not know the state', () => {
    const state = (wording: string) => ($: CheerioAPI) => { listRow($).eq(4).html(`${wording}<br>`); };
    expect(parseLastOneMile(edited('in-transit', state('配達中')), IN_TRANSIT))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map', last_status_text: '配達中' });
    expect(parseLastOneMile(edited('in-transit', state('合成の状態')), IN_TRANSIT))
      .toMatchObject({ current_stage: 'accepted', current_stage_source: 'carrier_map', last_status_text: '合成の状態' });
    // A delivered state over a history whose newest row is not the delivery has no delivery time.
    expect(parseLastOneMile(edited('in-transit', state('配達完了')), IN_TRANSIT)).not.toHaveProperty('delivered_at');
    const unknownRow = ($: CheerioAPI) => { firstRow($).eq(0).html('合成の状態<br>'); };
    expect(parseLastOneMile(edited('in-transit', unknownRow), IN_TRANSIT).events!.at(-1)).not.toHaveProperty('stage');
    const empty = ($: CheerioAPI) => { history($).children('tr').slice(1).remove(); };
    expect(parseLastOneMile(edited('in-transit', empty), IN_TRANSIT))
      .toMatchObject({ current_stage: 'accepted', summary_only: true, last_update: null, events: [] });
    expect(() => parseLastOneMile(edited('in-transit', ($) => { empty($); state('合成の状態')($); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the tracker’s answer for a number it does not know as not found', async () => {
    expect(() => parseLastOneMile(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(serving(bytes('not-found'))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const state = (wording: string) => ($: CheerioAPI) => { listRow($).eq(4).html(wording); };
    expect(() => parseLastOneMile(edited('not-found', state('ただいま照会できません<br>')), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLastOneMile(edited('not-found', state('<br>')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // Details beside the not-found answer, or without any state, are a changed page.
    expect(() => parseLastOneMile(edited('delivered', state('送り状番号未登録<br>')), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLastOneMile(edited('delivered', state('<br>')), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts a page only when its list, its details and every row name the number asked', () => {
    const other = '100000000041';
    expect(() => parseLastOneMile(page('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Last One Mile Co-op answered for another shipment' }));
    expect(() => parseLastOneMile(page('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const heading = ($: CheerioAPI) => { detail($).find('b').first().text(`\u3000１件目\u3000送り状番号\u3000${other}`); };
    expect(() => parseLastOneMile(edited('delivered', heading), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const rowNumber = ($: CheerioAPI) => { firstRow($).eq(4).html(`${other}<br>${DELIVERED}`); };
    expect(() => parseLastOneMile(edited('delivered', rowNumber), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The member company's number on a row's second line is not read.
    const memberNumber = ($: CheerioAPI) => { firstRow($).eq(4).html(`${DELIVERED}<br>${other}`); };
    expect(parseLastOneMile(edited('delivered', memberNumber), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    // A second parcel under the number cannot be told from the one asked about.
    const second = ($: CheerioAPI) => { detail($).after(`<a name="A01">\u3000</a>${$.html(detail($))}`); };
    expect(() => parseLastOneMile(edited('delivered', second), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Last One Mile Co-op lists more than one parcel under the waybill' }));
  });

  it('rejects a changed page', () => {
    for (const [name, change] of [
      ['no number field', ($: CheerioAPI) => { $('input[name="number01"]').remove(); }],
      ['another company’s form', ($: CheerioAPI) => { $('input[name="cd"]').attr('value', '80000'); }],
      ['another form id', ($: CheerioAPI) => { $('input[name="id"]').attr('value', '00000'); }],
      ['short list row', ($: CheerioAPI) => { listRow($).slice(3).remove(); }],
      ['list without the number', ($: CheerioAPI) => { listRow($).eq(2).empty(); }],
      ['no details', ($: CheerioAPI) => { detail($).remove(); }],
      ['heading without the number', ($: CheerioAPI) => { detail($).find('b').first().text('１件目'); }],
      ['no history', ($: CheerioAPI) => { history($).closest('table').remove(); }],
      ['renamed heading', ($: CheerioAPI) => { history($).children('tr').first().children('td').eq(3).text('店名'); }],
      ['two histories', ($: CheerioAPI) => { history($).closest('table').after($.html(history($).closest('table'))); }],
      ['too many rows', ($: CheerioAPI) => { history($).append(row('配達中').repeat(101)); }],
      ['short row', ($: CheerioAPI) => { firstRow($).last().remove(); }],
      ['row without a state', ($: CheerioAPI) => { firstRow($).eq(0).html('<br>'); }],
      ['state on two lines', ($: CheerioAPI) => { firstRow($).eq(0).html('引受<br>合成'); }],
      ['two offices', ($: CheerioAPI) => { firstRow($).eq(3).html('見本センター<br>試験センター'); }],
      ['row without the number', ($: CheerioAPI) => { firstRow($).eq(4).html('<br>'); }],
      ['ISO date', ($: CheerioAPI) => { firstRow($).eq(1).html('2026-03-17<br>22:41:05'); }],
      ['impossible date', ($: CheerioAPI) => { firstRow($).eq(1).html('2026/02/30<br>22:41:05'); }],
      ['midnight as 24:00', ($: CheerioAPI) => { firstRow($).eq(1).html('2026/03/17<br>24:00:00'); }],
      ['clock to the minute', ($: CheerioAPI) => { firstRow($).eq(1).html('2026/03/17<br>22:41'); }],
      ['no clock', ($: CheerioAPI) => { firstRow($).eq(1).html('2026/03/17<br>'); }],
      ['day without the year', ($: CheerioAPI) => { firstRow($).eq(1).html('03/17<br>22:41:05'); }],
    ] as const) {
      expect(() => parseLastOneMile(edited('delivered', change), DELIVERED), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLastOneMile('<html><body><p>合成</p></body></html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a browser check, a firewall refusal and a moved page apart from a missing shipment', async () => {
    const track = (fetcher: typeof fetch) => new LastOneMileTracker({ fetcher }).fetch(DELIVERED);
    expect(() => parseLastOneMile(CHALLENGE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(track(serving(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(serving(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(serving(REJECTED))).rejects.toMatchObject({ kind: 'challenge' });
    for (const status of [301, 302, 303, 307, 308, 404, 410]) {
      const moved = serving('', { status, headers: { Location: '/' } });
      await expect(track(moved), String(status)).rejects.toMatchObject({ kind: 'transport' });
      expect(moved).toHaveBeenCalledOnce();
    }
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = serving('', { status });
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number the co-op does not issue', async () => {
    await expect(carrier(serving(bytes('delivered'))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-03-18T04:52:09.000Z' });
    await expect(carrier(serving(bytes('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('100000000016')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => new Response(bytes('delivered'), { headers: { 'Content-Type': SJIS } }));
    await expect(new LastOneMileTracker({ fetcher }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects other numbers before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    // A failed check digit, other lengths, letters, two numbers and an oversized paste.
    for (const number of ['100000000016', '10000000001', '1000000000150', 'ABCDEFGHIJKL', '10000000001A', `${DELIVERED},${IN_TRANSIT}`, '', '1'.repeat(65)]) {
      await expect(new LastOneMileTracker({ fetcher: unused }).fetch(number), number).rejects.toThrow(InvalidInputError);
    }
    await expect(new LastOneMileTracker({ fetcher: unused }).fetch(DELIVERED, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(unused).not.toHaveBeenCalled();
    expect(normalizeLastOneMileNumber(' 1000 0000.0015 ')).toBe(DELIVERED);
    expect(normalizeLastOneMileNumber('１０００－００００－００１５')).toBe(DELIVERED);
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(new LastOneMileTracker({ fetcher: hanging }).fetch(DELIVERED, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(new LastOneMileTracker({ fetcher: serving('x'.repeat(600_000)) }).fetch(DELIVERED)).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under the co-op to the adapter', async () => {
    const fetcher = serving(bytes('delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'last-one-mile-coop' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'last-one-mile-coop', source: 'last-one-mile-coop', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === lastOneMileUrl(DELIVERED))).toBe(true);
  });

  it('claims no number by its shape, which Yamato, Sagawa and Japan Post share', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) expect(detectCarrierMatch(number).carrier, number).not.toBe('last-one-mile-coop');
  });
});

describe('Last One Mile Co-op status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      // The not-found answer is no state.
      if (!entry.stage) continue;
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(lastOneMileStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'last-one-mile-coop', providerCode: null, description: '配達完了' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'last-one-mile-coop', providerCode: null, description: '合成の状態' })).toEqual({ kind: 'unknown' });
    // The tracker has no codes.
    expect(statusMap.stage('L-1', '配達完了')).toBeUndefined();
    expect(lastOneMileStage('配達完了済')).toBeNull();
  });
});
