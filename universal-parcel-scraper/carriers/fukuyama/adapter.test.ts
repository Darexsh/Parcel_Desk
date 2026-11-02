import { readFileSync } from 'node:fs';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FUKUYAMA_TRACKING, FukuyamaTracker } from './adapter.js';
import { decodeFukuyamaPage, normalizeFukuyamaNumber, parseFukuyama } from './parser.js';
import { fukuyamaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '10000000001';
// A ten-digit number, which the page prints padded to eleven digits.
const IN_TRANSIT = '1000000002';
const UNKNOWN = '10000000003';
const REFUSED = '10000000004';
const SJIS = 'text/html; charset=SJIS';
const PRIVATE = /000-000-000|見本市|試験区|個|tracking_(?:snd|rsv)_display|88888888888|99999999999|印刷/;
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
const history = ($: CheerioAPI) => $('.c-table_stripe tbody');
const row = (milestone: string) => `<tr><td class="u-bold">${milestone}</td><td>2026/03/18 10:00</td><td>見本支店</td><td>000-000-0001</td></tr>`;
const serving = (body: BodyInit, init: ResponseInit = { headers: { 'Content-Type': SJIS } }) =>
  vi.fn<typeof fetch>().mockImplementation(async () => new Response(typeof body === 'string' ? body : new Uint8Array(body as Uint8Array), init));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Fukuyama Transporting tracking page', () => {
  it('asks for the page of the whole number through the supplied transport', async () => {
    const fetcher = serving(bytes('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FukuyamaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 100-0000-0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`${FUKUYAMA_TRACKING}${DELIVERED}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', Accept: 'text/html', 'Accept-Language': 'ja' } });
    expect(init.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fukuyama', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the page in the charset its header or its meta tag declares', async () => {
    const delivered = { status: 'delivered', last_status_text: '配達完了です' };
    await expect(new FukuyamaTracker({ fetcher: serving(bytes('delivered')) }).fetch(DELIVERED)).resolves.toMatchObject(delivered);
    await expect(new FukuyamaTracker({ fetcher: serving(bytes('delivered'), { headers: { 'Content-Type': 'text/html' } }) }).fetch(DELIVERED))
      .resolves.toMatchObject(delivered);
    await expect(new FukuyamaTracker({ fetcher: serving(bytes('delivered'), {}) }).fetch(DELIVERED)).resolves.toMatchObject(delivered);
    const utf8 = new TextEncoder().encode(page('delivered').replace('charset="Shift_JIS"', 'charset="utf-8"'));
    expect(parseFukuyama(decodeFukuyamaPage(utf8, null), DELIVERED)).toMatchObject(delivered);
    expect(() => decodeFukuyamaPage(bytes('delivered'), 'text/html; charset=x-synthetic')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('dates each milestone in Japan’s zone, keeps the dispatch day alone, and drops phones, addresses and waybills', () => {
    const result = parseFukuyama(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '配達完了です', last_update: '2026-03-18T14:05:00+09:00', last_update_local: null, expected_delivery: null,
      delivered_at: '2026-03-18T14:05:00+09:00', weight_kg: 35, timezone: 'Asia/Tokyo' });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description, event.stage, event.location])).toEqual([
      ['2026-03-18T14:05:00+09:00', '配達完了', 'delivered', '試験センター'],
      ['2026-03-18T08:55:00+09:00', '持出', 'out_for_delivery', '試験センター'],
      ['2026-03-18T03:12:00+09:00', '到着', 'in_transit', '試験センター'],
      ['2026-03-17', '発送', 'in_transit', '見本支店'],
      ['2026-03-17T16:40:00+09:00', '受付', 'accepted', '見本支店'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('time' in event && 'local_time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toMatchObject({ adapter: 'fukuyama', steps: ['direct', 'retry'], recognition: { rank: 939 }, localClocks: true });
    expect(metadata.detection).toEqual([]);
  });

  it('reads a ten-digit number’s page, which pads the number, and leaves out the milestones not reached', () => {
    const result = parseFukuyama(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '輸送中です', last_update: null, last_update_local: '2026-03-19', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    // The page prints no weight as 0 kg.
    expect(result).not.toHaveProperty('weight_kg');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description])).toEqual([
      ['2026-03-19', '発送'], ['2026-03-19T11:20:00+09:00', '受付']]);
    expect(parseFukuyama(page('in-transit'), `0${IN_TRANSIT}`)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('takes the summary’s state over the milestones, and the newest milestone’s when the map does not know the state', () => {
    const state = (wording: string) => ($: CheerioAPI) => { $('p.u-red').text(wording); };
    expect(parseFukuyama(edited('in-transit', state('持戻です')), IN_TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map', last_status_text: '持戻です' });
    expect(parseFukuyama(edited('in-transit', state('合成の状態です')), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: '合成の状態です' });
    // A delivered summary over a page whose newest milestone is not the delivery has no delivery time.
    expect(parseFukuyama(edited('in-transit', state('配達完了です')), IN_TRANSIT)).not.toHaveProperty('delivered_at');
    const empty = ($: CheerioAPI) => { history($).find('td:nth-child(2)').text(''); };
    expect(parseFukuyama(edited('in-transit', empty), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', summary_only: true, events: [] });
    expect(() => parseFukuyama(edited('in-transit', ($) => { empty($); state('合成の状態です')($); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the tracker’s answer for a number it does not know as not found, and the search form’s refusal as invalid', async () => {
    expect(() => parseFukuyama(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(serving(bytes('not-found'))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const answer = ($: CheerioAPI) => { $('.p-recieve_detail_table_td').last().text('ただいま照会できません。'); };
    expect(() => parseFukuyama(edited('not-found', answer), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFukuyama(page('refused'), REFUSED)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    await expect(carrier(serving(bytes('refused'))).track({ number: REFUSED })).rejects.toMatchObject({ kind: 'invalid_input' });
    // The form for another number, or without the warning, is not the tracker's answer for this one.
    expect(() => parseFukuyama(page('refused'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFukuyama(edited('refused', ($) => { $('.c-form_warning_text').remove(); }), REFUSED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts a page only when it names the number asked', () => {
    expect(() => parseFukuyama(page('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Fukuyama Transporting answered for another shipment' }));
    expect(() => parseFukuyama(page('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A ten-digit number is not the eleven-digit one that ends the same way.
    expect(() => parseFukuyama(page('in-transit'), '11000000002')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const shown = (text: string) => ($: CheerioAPI) => { $('.p-recieve_detail_table_td').first().text(text); };
    expect(() => parseFukuyama(edited('delivered', shown('100-0000-00012')), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFukuyama(edited('delivered', shown(`100-0000-0001${'-'.repeat(40)}9`)), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed page', () => {
    const column = (label: string) => ($: CheerioAPI) => $(`.p-recieve_detail_table_th:contains("${label}")`).parent();
    for (const [name, change] of [
      ['no main', ($: CheerioAPI) => { $('main').replaceWith($('main').html()!); }],
      ['two mains', ($: CheerioAPI) => { $('body').append('<main></main>'); }],
      ['no summary', ($: CheerioAPI) => { $('.p-recieve_detail_table').remove(); }],
      ['two summaries', ($: CheerioAPI) => { $('.p-recieve_detail_table').after($.html($('.p-recieve_detail_table'))); }],
      ['no number', ($: CheerioAPI) => { column('お問い合わせ番号')($).remove(); }],
      ['number in words', ($: CheerioAPI) => { $('.p-recieve_detail_table_td').first().text('番号'); }],
      ['repeated label', ($: CheerioAPI) => { $('.p-recieve_detail_table_row').first().append($.html(column('重量')($))); }],
      ['label without a cell', ($: CheerioAPI) => { column('重量')($).children('.p-recieve_detail_table_td').remove(); }],
      ['no state', ($: CheerioAPI) => { column('現在の配達状況')($).remove(); }],
      ['empty state', ($: CheerioAPI) => { $('p.u-red').text(' '); }],
      ['state beside an answer', ($: CheerioAPI) => {
        $('.p-recieve_detail_table_row').first().append('<div class="p-recieve_detail_table_col"><div class="p-recieve_detail_table_th">照会結果：</div>'
          + '<div class="p-recieve_detail_table_td">該当データはありません。</div></div>');
      }],
      ['no history', ($: CheerioAPI) => { $('.c-table_stripe').remove(); }],
      ['two histories', ($: CheerioAPI) => { $('.c-table_stripe').after($.html($('.c-table_stripe'))); }],
      ['renamed column', ($: CheerioAPI) => { $('.c-table_stripe thead th').eq(2).text('店名'); }],
      ['extra column', ($: CheerioAPI) => { $('.c-table_stripe thead tr').append('<th>備考</th>'); }],
      ['no rows', ($: CheerioAPI) => { history($).empty(); }],
      ['too many rows', ($: CheerioAPI) => { history($).append(row('到着').repeat(50)); }],
      ['short row', ($: CheerioAPI) => { history($).find('tr').first().children('td').last().remove(); }],
      ['unnamed row', ($: CheerioAPI) => { history($).find('tr').first().children('td').first().text(' '); }],
      ['ISO date', ($: CheerioAPI) => { history($).find('tr').first().children('td').eq(1).text('2026-03-17 16:40'); }],
      ['impossible date', ($: CheerioAPI) => { history($).find('tr').first().children('td').eq(1).text('2026/02/30 16:40'); }],
      ['midnight as 24:00', ($: CheerioAPI) => { history($).find('tr').first().children('td').eq(1).text('2026/03/17 24:00'); }],
      ['seconds', ($: CheerioAPI) => { history($).find('tr').first().children('td').eq(1).text('2026/03/17 16:40:00'); }],
    ] as const) {
      expect(() => parseFukuyama(edited('delivered', change), DELIVERED), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseFukuyama('<html><body><main><p>合成</p></main></body></html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a browser check, a firewall refusal and a moved page apart from a missing shipment', async () => {
    const track = (fetcher: typeof fetch) => new FukuyamaTracker({ fetcher }).fetch(DELIVERED);
    expect(() => parseFukuyama(CHALLENGE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(track(serving(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(serving(CHALLENGE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(serving(REJECTED))).rejects.toMatchObject({ kind: 'challenge' });
    const turnstile = edited('delivered', ($) => { $('main').append('<div class="cf-turnstile" data-sitekey="0x0000000000000000000000"></div>'); });
    expect(() => parseFukuyama(turnstile, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
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

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Fukuyama does not issue', async () => {
    await expect(carrier(serving(bytes('delivered'))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-03-18T05:05:00.000Z' });
    await expect(carrier(serving(bytes('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(serving(bytes('refused'))).recognize!(REFUSED)).resolves.toEqual({ known: false });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('123456789')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => new Response(bytes('delivered'), { headers: { 'Content-Type': SJIS } }));
    await expect(new FukuyamaTracker({ fetcher }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects other numbers before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    // Other lengths, letters, two numbers and an oversized paste.
    for (const number of ['123456789', '123456789012', 'ABCDEFGHIJK', '1000000000A', `${DELIVERED},${IN_TRANSIT}`, '', '1'.repeat(65)]) {
      await expect(new FukuyamaTracker({ fetcher: unused }).fetch(number), number).rejects.toThrow(InvalidInputError);
    }
    await expect(new FukuyamaTracker({ fetcher: unused }).fetch(DELIVERED, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(unused).not.toHaveBeenCalled();
    expect(normalizeFukuyamaNumber(' 100 0000.0001 ')).toBe(DELIVERED);
    expect(normalizeFukuyamaNumber('010-0000-0002')).toBe(`0${IN_TRANSIT}`);
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(new FukuyamaTracker({ fetcher: hanging }).fetch(DELIVERED, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(new FukuyamaTracker({ fetcher: serving('x'.repeat(600_000)) }).fetch(DELIVERED)).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under Fukuyama to the adapter', async () => {
    const fetcher = serving(bytes('delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'fukuyama' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'fukuyama', source: 'fukuyama', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${FUKUYAMA_TRACKING}${DELIVERED}`)).toBe(true);
  });

  it('claims no number by its shape, which Japan Post and others share', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) expect(detectCarrierMatch(number).carrier, number).not.toBe('fukuyama');
  });
});

describe('Fukuyama Transporting status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(fukuyamaStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'fukuyama', providerCode: null, description: '配達完了です' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'fukuyama', providerCode: null, description: '合成の状態' })).toEqual({ kind: 'unknown' });
    // The tracker has no codes.
    expect(statusMap.stage('F-1', '配達完了')).toBeUndefined();
    expect(fukuyamaStage('配達完了済')).toBeNull();
  });
});
