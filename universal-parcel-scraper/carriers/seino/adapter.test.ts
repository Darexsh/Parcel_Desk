import { readFileSync } from 'node:fs';
import { load, type CheerioAPI } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SEINO_TRACKING, SeinoTracker } from './adapter.js';
import { normalizeSeinoNumber, parseSeino, seinoPageEncoding } from './parser.js';
import { seinoCodeStage, seinoMilestoneStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1000000001';
const IN_TRANSIT = '1000000002';
const UNKNOWN = '0000000000';
// The branches' and the driver's phone numbers, the vehicle, the driver and the destination area code.
const PRIVATE = /111-2222|333-4444|5555|Z123|246813|987654|TEL/;
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const WAF = '<!DOCTYPE html><html><head><script>window.gokuProps = {"key":"synthetic"};</script><script src="https://example.token.awswaf.com/challenge.js"></script></head><body></body></html>';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
/** The page with a change made through cheerio. */
const edited = (name: string, edit: ($: CheerioAPI) => void) => {
  const $ = load(fixture(name));
  edit($);
  return $.html();
};

/** Shift_JIS bytes for each character, read back from the runtime's own decoder. */
const SHIFT_JIS = (() => {
  const table = new Map<string, number[]>();
  const decoder = new TextDecoder('shift_jis');
  for (let byte = 0xa1; byte <= 0xdf; byte += 1) table.set(decoder.decode(Uint8Array.of(byte)), [byte]);
  for (const lead of [...Array.from({ length: 0x1f }, (_, i) => 0x81 + i), ...Array.from({ length: 0x1d }, (_, i) => 0xe0 + i)]) {
    for (let trail = 0x40; trail <= 0xfc; trail += 1) {
      if (trail === 0x7f) continue;
      const character = decoder.decode(Uint8Array.of(lead, trail));
      if (character.length === 1 && character !== '�' && !table.has(character)) table.set(character, [lead, trail]);
    }
  }
  return table;
})();
const shiftJis = (text: string) => Uint8Array.from([...text].flatMap((character) => {
  if (character.charCodeAt(0) < 0x80) return [character.charCodeAt(0)];
  const bytes = SHIFT_JIS.get(character);
  if (!bytes) throw new Error(`no Shift_JIS byte for ${character}`);
  return bytes;
}));
/** The page as the site serves it: Shift_JIS, declared Windows-31J. */
const page = (html: string, contentType: string | null = 'text/html;charset=Windows-31J') =>
  new Response(shiftJis(html), { headers: contentType ? { 'Content-Type': contentType } : {} });
const serving = (html: string) => vi.fn<typeof fetch>().mockImplementation(async () => page(html));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Seino tracking page', () => {
  it('looks the number up through the supplied transport with the host’s User-Agent', async () => {
    const fetcher = serving(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SeinoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 100-000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(`${SEINO_TRACKING}?GNPNO1=${IN_TRANSIT}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', Accept: 'text/html' } });
    expect(init.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'seino', step: 'direct', outcome: 'ok' }));
  });

  it('places each milestone on Japan’s clock across a month, and keeps the redelivery and the goods without contact details', () => {
    const result = parseSeino(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      provider_code: '22', last_status_text: '配達済みです（再配達）', last_update: '2026-10-03T10:45:00+09:00',
      delivered_at: '2026-10-03T10:45:00+09:00', expected_delivery: null, service_name: 'ミニ', weight_kg: 2 });
    expect(result).not.toHaveProperty('summary_only');
    // Newest first; the relay the shipment skipped has no time and is left out.
    expect(result.events!.map((event) => [event.time, event.description, event.location, event.stage])).toEqual([
      ['2026-10-03T10:45:00+09:00', '配達', 'サンプル南', 'delivered'],
      ['2026-10-03T08:20:00+09:00', '持出', 'サンプル南', 'out_for_delivery'],
      ['2026-10-01T02:15:00+09:00', '到着', 'サンプル南', 'in_transit'],
      ['2026-09-28T21:40:00+09:00', '発送', 'サンプル北', 'in_transit'],
      ['2026-09-28T16:05:00+09:00', '受付', 'サンプル北', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event) && !event.provider_code)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking).toEqual({ mode: 'automatic', adapter: 'seino', steps: ['direct', 'retry'], recognition: { rank: 943 } });
  });

  it('dates a shipment received in December and arrived in January, leaving out a planned relay', () => {
    const result = parseSeino(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', provider_code: '07',
      last_status_text: '配達店に到着しています', last_update: '2027-01-02T07:50:00+09:00', service_name: '一般', weight_kg: 1250 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.description, event.location])).toEqual([
      ['2027-01-02T07:50:00+09:00', '到着', 'サンプル南'],
      ['2026-12-30T22:05:00+09:00', '発送', 'サンプル北'],
      ['2026-12-30T17:30:00+09:00', '受付', 'サンプル北'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('stages by the status code, and by the newest milestone when the map does not know the code', () => {
    const status = (code: string, wording: string) => ($: CheerioAPI) => {
      $('input[name="haitatsuJokyoCode"]').attr('value', code);
      $('input[name="haitatsuJokyo"]').attr('value', wording);
    };
    // A shipment handed on to a partner company, with the milestone the page adds for it.
    const partner = parseSeino(edited('in-transit', ($) => {
      status('25', '協力会社へ中継しています')($);
      const arrival = $('table.package-detail1 tr').filter((_, row) => $(row).children('td.col1').text().includes('到 着'));
      arrival.after('<tr><td class="col1">配達回送&nbsp;</td><td class="col2">サンプル協力&nbsp;</td><td class="col3">2日8時30分&nbsp;</td></tr>');
    }), IN_TRANSIT);
    expect(partner).toMatchObject({ current_stage: 'in_transit', provider_code: '25', last_update: '2027-01-02T08:30:00+09:00' });
    expect(partner.events![0]).toMatchObject({ description: '配達回送', location: 'サンプル協力', stage: 'in_transit' });
    // Out for delivery, with the hour it is due by kept in the wording.
    const due = '現在配達中です【１１：００までに配達予定】';
    expect(parseSeino(edited('in-transit', status('14', due)), IN_TRANSIT)).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: due, expected_delivery: null });
    // The code decides over the milestones.
    expect(parseSeino(edited('delivered', status('07', '配達店に到着しています')), DELIVERED)).toMatchObject({ current_stage: 'in_transit' });
    expect(parseSeino(edited('delivered', status('07', '配達店に到着しています')), DELIVERED)).not.toHaveProperty('delivered_at');
    // A code the map does not know leaves the stage to the newest milestone.
    expect(parseSeino(edited('delivered', status('31', 'サンプル状況です')), DELIVERED)).toMatchObject({
      status: 'delivered', current_stage: 'delivered', provider_code: '31', last_status_text: 'サンプル状況です' });
    // A mapped code without milestones is a summary; an unknown one has nothing to say.
    const bare = ($: CheerioAPI) => { $('table.package-detail1 td.col3').text(''); };
    expect(parseSeino(edited('in-transit', bare), IN_TRANSIT)).toMatchObject({
      current_stage: 'in_transit', summary_only: true, last_update: null, events: [] });
    expect(() => parseSeino(edited('in-transit', ($) => { bare($); status('31', 'サンプル状況です')($); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // A phone number in the wording is dropped.
    expect(parseSeino(edited('delivered', status('08', '配達済みです TEL：000-111-2222')), DELIVERED))
      .toMatchObject({ last_status_text: '配達済みです' });
  });

  it('reads the carrier’s answer for an unknown number as not found, and its refusal of a number as invalid input', () => {
    expect(() => parseSeino(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The page's own check prints the number with エラー, without the echo.
    const refusal = (printed: string) => edited('not-found', ($) => {
      const row = $('input[name="inputGNPNO1"]').closest('tr');
      $('input[name="inputGNPNO1"]').remove();
      row.children('td.col3').text(`${printed}エラー`);
      row.children('td.col4').text('');
    });
    expect(() => parseSeino(refusal(UNKNOWN), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseSeino(refusal('000000000'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The list without its message or its detail is not an answer.
    const silent = edited('not-found', ($) => { $('td.col4').first().text(''); });
    expect(() => parseSeino(silent, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('counts an answer only when it names the whole number asked', () => {
    expect(() => parseSeino(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Seino answered for another number' }));
    expect(() => parseSeino(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The echo keeps the hyphens a visitor typed.
    const typed = edited('in-transit', ($) => { $('input[name="inputGNPNO1"]').attr('value', '100-000-0002'); });
    expect(parseSeino(typed, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    // A detail for another number is not this shipment's.
    const other = edited('in-transit', ($) => { $('input[name="gempyoNo"]').attr('value', '1000000003'); });
    expect(() => parseSeino(other, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const twice = edited('in-transit', ($) => { $('table.package-detail1').after($.html($('table.package-detail1'))); });
    expect(() => parseSeino(twice, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed page', () => {
    const hidden = (name: string, value: string) => ($: CheerioAPI) => { $(`input[name="${name}"]`).attr('value', value); };
    const milestone = (index: number, value: string) => ($: CheerioAPI) => { $('table.package-detail1 td.col3').eq(index).text(value); };
    for (const [name, change] of [
      ['no list', ($: CheerioAPI) => { $('form[name="gempyoNoShokaiListForm"]').remove(); }],
      ['no echo', ($: CheerioAPI) => { $('input[name="inputGNPNO1"]').remove(); }],
      ['no detail', ($: CheerioAPI) => { $('table.package-detail1').remove(); }],
      ['no code', hidden('haitatsuJokyoCode', '')],
      ['long code', hidden('haitatsuJokyoCode', '220')],
      ['no wording', hidden('haitatsuJokyo', '')],
      ['no page clock', hidden('mapDspDateT', '')],
      ['impossible page clock', hidden('mapDspDateT', '20261332101500')],
      ['no receipt date', hidden('uketsukeDate', '')],
      ['impossible receipt date', hidden('uketsukeDate', '2月30日')],
      ['time without minutes', milestone(0, '28日16時')],
      ['impossible hour', milestone(0, '28日25時5分')],
      ['impossible day', milestone(3, '32日2時15分')],
      ['milestone after the page clock', hidden('mapDspDateT', '20260928170000')],
      ['no label', ($: CheerioAPI) => { $('table.package-detail1 td.col1').eq(0).text(''); }],
      ['no milestones', ($: CheerioAPI) => { $('table.package-detail1 td.col1').parent().remove(); }],
      ['too many milestones', ($: CheerioAPI) => { $('table.package-detail1').append($.html($('table.package-detail1 td.col1').last().parent()).repeat(20)); }],
    ] as const) {
      expect(() => parseSeino(edited('delivered', change), DELIVERED), name).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // Goods the page does not name in a known form are left out.
    const goods = parseSeino(edited('delivered', ($) => { $('table[summary="商品情報"]').remove(); }), DELIVERED);
    expect(goods).not.toHaveProperty('weight_kg');
    expect(goods).not.toHaveProperty('service_name');
    const tons = parseSeino(edited('delivered', ($) => { $('table[summary="商品情報"] td').eq(2).text('2t'); }), DELIVERED);
    expect(tons).not.toHaveProperty('weight_kg');
  });

  it('reads a bot check as a challenge and a maintenance notice as maintenance, even with HTTP 200', async () => {
    for (const html of [CLOUDFLARE, WAF, '<html><head><title>Access Denied</title></head><body>Reference #0.0</body></html>']) {
      expect(() => parseSeino(html, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
      await expect(new SeinoTracker({ fetcher: serving(html) }).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
    }
    const maintenance = '<html><body><p>ただいまシステムメンテナンス中です。</p></body></html>';
    await expect(new SeinoTracker({ fetcher: serving(maintenance) }).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(new SeinoTracker({ fetcher: serving('<html><body>サンプル</body></html>') }).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('reads a redirect or a missing page as a moved tracker, not as a missing shipment', async () => {
    for (const status of [301, 302, 404, 410]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status, headers: { Location: '/' } }));
      await expect(new SeinoTracker({ fetcher }).fetch(DELIVERED), String(status)).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it('decodes the page as it declares', async () => {
    const html = fixture('delivered');
    for (const contentType of ['text/html;charset=Windows-31J', 'text/html; charset=Shift_JIS', 'text/html', null]) {
      await expect(new SeinoTracker({ fetcher: vi.fn<typeof fetch>().mockImplementation(async () => page(html, contentType)) }).fetch(DELIVERED),
        String(contentType)).resolves.toMatchObject({ last_status_text: '配達済みです（再配達）', service_name: 'ミニ' });
    }
    const utf8 = vi.fn<typeof fetch>().mockImplementation(async () => new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } }));
    await expect(new SeinoTracker({ fetcher: utf8 }).fetch(DELIVERED)).resolves.toMatchObject({ last_status_text: '配達済みです（再配達）' });
    for (const contentType of ['text/html; charset=EUC-JP', 'text/html; charset=x-synthetic']) {
      await expect(new SeinoTracker({ fetcher: vi.fn<typeof fetch>().mockImplementation(async () => page(html, contentType)) }).fetch(DELIVERED),
        contentType).rejects.toMatchObject({ kind: 'schema' });
    }
    expect(seinoPageEncoding(null, new TextEncoder().encode('<meta charset="utf-8">'))).toBe('utf-8');
    expect(seinoPageEncoding('text/html; charset=MS932', new Uint8Array())).toBe('shift_jis');
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Seino does not issue', async () => {
    await expect(carrier(serving(fixture('delivered'))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-10-03T01:45:00.000Z' });
    await expect(carrier(serving(fixture('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('123456789')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => page(fixture('delivered')));
    await expect(new SeinoTracker({ fetcher }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects other numbers before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    for (const number of ['123456789', '12345678901', 'ABCDEFGHIJ', 'SN1000000001', `${DELIVERED},${IN_TRANSIT}`, '', '1'.repeat(65)]) {
      await expect(new SeinoTracker({ fetcher: unused }).fetch(number), number).rejects.toThrow(InvalidInputError);
    }
    await expect(new SeinoTracker({ fetcher: unused }).fetch(DELIVERED, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(unused).not.toHaveBeenCalled();
    expect(normalizeSeinoNumber(' 100-000-0001 ')).toBe(DELIVERED);
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await expect(new SeinoTracker({ fetcher: hanging }).fetch(DELIVERED, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(hanging.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    const huge = vi.fn<typeof fetch>().mockImplementation(async () => new Response('x'.repeat(1_100_000)));
    await expect(new SeinoTracker({ fetcher: huge }).fetch(DELIVERED)).rejects.toThrow('unexpectedly large');
  });

  it('routes a number filed under Seino to the adapter', async () => {
    const fetcher = serving(fixture('delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'seino' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'seino', source: 'seino', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(SEINO_TRACKING))).toBe(true);
  });
});

describe('Seino status vocabulary', () => {
  it('records every code and milestone the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(entry.code ?? null, wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'seino', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // The milestones as the page prints them, with spaces.
    expect(seinoMilestoneStage('配 達')).toBe('delivered');
    expect(seinoCodeStage('31')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'seino', providerCode: '31', description: 'サンプル状況です' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'seino', providerCode: null, description: 'サンプル' })).toEqual({ kind: 'unknown' });
  });
});
