import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { ArasKargoTracker, adapter, arasTrackingUrl } from './adapter.js';
import { arasWaybillFrame, normalizeArasNumber, parseAras, parseArasLookup } from './parser.js';
import { arasStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '9900000000001';
const OTHER = '9900000000002';
const ORIGIN = 'https://kargotakip.araskargo.com.tr';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const summary = fixture('summary');
const movements = fixture('movements');
const tracker = fixture('tracker');
const absent = fixture('not-found');
const WAYBILL = 'CargoInfoWaybillAndDelivered.aspx?shipmentid=0123456789ABCDEF0123456789ABCDEF&subekod=';
const edit = (body: string, change: (document: ReturnType<typeof load>) => void) => { const $ = load(body); change($); return $.html(); };
const row = (...cells: string[]) => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
const status = (text: string, delivered = '') => edit(summary, $ => { $('#Son_Durum').text(text); $('#Teslim_Tarihi').text(delivered); });
const reply = (body: string, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(body, { status: init.status ?? 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const found = () => new Response(null, { status: 302, headers: [['Location', '/kargotakip.aspx'],
  ['Set-Cookie', 'ASP.NET_SessionId=syntheticsession0000000000; path=/; HttpOnly; SameSite=Lax'],
  ['Set-Cookie', 'Cus_int_nlb=synthetic-route;expires=Thu, 01-Jan-2099 00:00:00 GMT;path=/;secure;httponly']] });
/** The four pages of one lookup, in the order the tracker serves them. */
const session = (pages: Partial<Record<'lookup' | 'tracker' | 'summary' | 'movements', () => Response>> = {}) => {
  const order = [pages.lookup ?? found, pages.tracker ?? (() => reply(tracker)), pages.summary ?? (() => reply(summary)),
    pages.movements ?? (() => reply(movements))];
  return vi.fn<typeof fetch>(async () => order.shift()!());
};
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('Aras Kargo direct tracking', () => {
  it('reads the movements, the failed deliveries and the delivery as wall clocks, newest first', () => {
    const result = normalizeCarrierResult(parseAras(summary, movements, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'TESLİM EDİLDİ', last_update: null, last_update_local: '2026-01-12T10:20:00', expected_delivery: null });
    expect(result.events?.map(event => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-01-12T10:20:00', 'TESLİM EDİLDİ', 'ÖRNEK', 'delivered'],
      ['2026-01-11', 'UĞRAMA NOTU BIRAKILDI (1-2)', undefined, 'failed_attempt'],
      ['2026-01-11T08:30:12', 'ŞUBEDE ARAÇ İNDİRME', 'ÖRNEK, ÖRNEKİL', 'in_transit'],
      ['2026-01-10T23:00:00', 'AKTARMADA SUBE ARACI YUKLEME', 'ÖRNEKİL TRANSFER', 'in_transit'],
      ['2026-01-10T06:40:00', 'AKTARMADA TORBA DOLDURMA', 'ÖRNEKİL TRANSFER', 'in_transit'],
      ['2026-01-10T06:40:00', 'AKTARMADA HAT ARACI İNDİRME', 'ÖRNEKİL TRANSFER', 'in_transit'],
      ['2026-01-09T23:05:44', 'AKTARMADA HAT ARACI YÜKLEME', 'TESTİL TRANSFER', 'in_transit'],
      ['2026-01-09T21:30:00', 'AKTARMADA SUBE ARACI INDIRME', 'TESTİL TRANSFER', 'in_transit'],
      ['2026-01-09T17:10:05', 'ŞUBEDE ARAÇ YÜKLEME', 'DENEME, TESTİL', 'in_transit'],
    ]);
    expect(result.events?.every(event => event.stage_source === 'carrier_map' && !event.time && !event.provider_code)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
    expect(result.summary_only).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
  });

  it('binds both frames to the whole number', () => {
    for (const [body, other] of [[edit(summary, $ => $('#labelShipmentCode').text(OTHER)), movements],
      [summary, edit(movements, $ => $('.sno-value').text(OTHER))],
      [summary, edit(movements, $ => $('.sno-value').text(`${NUMBER}1`))],
      [edit(summary, $ => $('#labelShipmentCode').clone().appendTo('body')), movements],
      [edit(summary, $ => $('html').attr('lang', 'en')), movements], [summary, edit(movements, $ => $('html').removeAttr('lang'))]]) {
      expect(() => parseAras(body!, other!, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    // A frame opened outside the session that found the parcel comes back empty.
    for (const [body, other] of [[edit(summary, $ => $('#labelShipmentCode').text('')), movements],
      [summary, edit(movements, $ => $('.sno-value').text(''))], [summary, edit(movements, $ => $('#transactionsDataGrid').remove())],
      [summary, edit(movements, $ => $('#redirectionDataGrid').remove())], [edit(summary, $ => $('#notDeliveredDataGrid').remove()), movements]]) {
      expect(() => parseAras(body!, other!, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('takes thirteen digits and nothing else', () => {
    expect(normalizeArasNumber(' 9900 0000 00001 ')).toBe(NUMBER);
    for (const number of ['', '990000000000', '99000000000012', 'A900000000001', '9900000000001X']) {
      expect(() => normalizeArasNumber(number), number).toThrow(InvalidInputError);
    }
    expect(arasTrackingUrl(NUMBER)).toBe(`${ORIGIN}/mainpage.aspx?code=${NUMBER}`);
  });

  it('is offered for thirteen digits starting with 60 or 65, and asked first from Turkey', () => {
    // Synthetic numbers of the prefixes every number the tracker knew carries.
    for (const number of ['6000000000001', '6500000000001']) {
      expect(detectCarrierMatch(number).candidates, number).toContain('aras-kargo');
      expect(recognitionAskedCarriers(number, { countryHint: 'TR' })[0], number).toBe('aras-kargo');
    }
    for (const number of ['6100000000001', '9900000000001', '65000000000012']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('aras-kargo');
    }
  });

  it('reports a parcel absent only on the notice for that number', () => {
    expect(() => parseArasLookup(absent, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const body of [absent.replace(`code=${NUMBER}`, `code=${OTHER}`), absent.replace('bulunamamıştır', 'bulunamadı'),
      edit(absent, $ => $('#Label1').clone().appendTo('body')), edit(absent, $ => $('#Label1').remove()),
      edit(absent, $ => $('form').removeAttr('id')), '<html><body>Bakım çalışması</body></html>', '']) {
      expect(() => parseArasLookup(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('opens only the summary frame the tracking page names', () => {
    expect(arasWaybillFrame(tracker)).toBe(WAYBILL);
    expect(() => arasWaybillFrame('<html><body>Bakım çalışması</body></html>')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    for (const src of [`https://other.test/${WAYBILL}`, WAYBILL.toLowerCase(), `${WAYBILL}&x=1`, WAYBILL.replace('ABCDEF&', 'ABCDE&'), '']) {
      expect(() => arasWaybillFrame(edit(tracker, $ => $('#panel0').attr('src', src))), src).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [edit(tracker, $ => $('#panel1').attr('data-src', 'Other.aspx')), edit(tracker, $ => $('#panel0').clone().appendTo('#tabPanels'))]) {
      expect(() => arasWaybillFrame(body)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('makes a failed delivery after the last movement the news, and keeps a current estimate', () => {
    const waiting = status('TESLİMAT ŞUBESİNDE');
    expect(parseAras(waiting, movements, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt',
      last_status_text: 'UĞRAMA NOTU BIRAKILDI (1-2)', last_update_local: '2026-01-11', expected_delivery: null });
    const moved = edit(movements, $ => $('#transactionsDataGrid').append(row('12.1.2026 09:00:00', 'ÖRNEKİL', 'ÖRNEK', 'ŞUBEDE ARAÇ İNDİRME')));
    expect(parseAras(waiting, moved, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'TESLİMAT ŞUBESİNDE', last_update_local: '2026-01-12T09:00:00', expected_delivery: null });
    const clear = edit(waiting, $ => $('#notDeliveredDataGrid tr').slice(1).remove());
    expect(parseAras(clear, movements, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'TESLİMAT ŞUBESİNDE', expected_delivery: '2026-01-11' });
    expect(parseAras(edit(clear, $ => $('#planlanan_teslim_tarihi').text('10.01.2026')), movements, NUMBER).expected_delivery).toBeNull();
    expect(parseAras(edit(clear, $ => $('#planlanan_teslim_tarihi').text('')), movements, NUMBER).expected_delivery).toBeNull();
    expect(parseAras(edit(clear, $ => $('#Son_Durum').text('YOLDA')), movements, NUMBER)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'YOLDA' });
  });

  it('keeps a delivery without its time, and new wording unstaged', () => {
    const untimed = parseAras(status('TESLİM EDİLDİ'), movements, NUMBER);
    expect(untimed).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'TESLİM EDİLDİ',
      last_update_local: '2026-01-11', expected_delivery: null });
    expect(untimed.events).toHaveLength(8);
    expect(untimed.events?.some(event => event.stage === 'delivered')).toBe(false);
    const fresh = edit(movements, $ => $('#transactionsDataGrid').append(row('12.1.2026 07:00:00', 'ÖRNEKİL', 'ÖRNEK', 'YENİ İŞLEM')));
    const unknown = parseAras(status('YENİ DURUM'), fresh, NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'YENİ DURUM', expected_delivery: null });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events?.[0]).toEqual({ local_time: '2026-01-12T07:00:00', description: 'YENİ İŞLEM', location: 'ÖRNEK, ÖRNEKİL' });
    // A delivery time with wording the map does not know is still the scan of that time.
    expect(parseAras(status('YENİ TESLİMAT', '12.01.2026 11:00'), movements, NUMBER).events?.[0])
      .toEqual({ local_time: '2026-01-12T11:00:00', description: 'YENİ TESLİMAT', location: 'ÖRNEK' });
  });

  it('reads a redirection with its reason, after the clocked movements of its day', () => {
    const redirected = edit(movements, $ => $('#redirectionDataGrid').append(
      row('10.01.2026', 'NORMAL', 'YÖNLENDİRİLDİ', 'ÖRNEKİL TRANSFER', 'ÖRNEK', 'VARIŞ MERKEZİ HATASI'),
      row('10.01.2026', 'NORMAL', 'YÖNLENDİRİLDİ', 'ÖRNEKİL TRANSFER', 'ÖRNEK', 'VARIŞ MERKEZİ HATASI'),
      row('10.01.2026', 'NORMAL', 'YÖNLENDİRİLDİ', '', 'ÖRNEK', '')));
    const events = parseAras(summary, redirected, NUMBER).events!;
    expect(events.slice(3, 6)).toEqual([
      { local_time: '2026-01-10', description: 'YÖNLENDİRİLDİ', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-01-10', description: 'YÖNLENDİRİLDİ (VARIŞ MERKEZİ HATASI)', location: 'ÖRNEKİL TRANSFER', stage: 'in_transit', stage_source: 'carrier_map' },
      expect.objectContaining({ local_time: '2026-01-10T23:00:00' }),
    ]);
    expect(events).toHaveLength(11);
  });

  it('answers with the status alone before the first movement, and rejects malformed rows', () => {
    const empty = edit(movements, $ => $('#transactionsDataGrid tr').slice(1).remove());
    const taken = edit(status('ÇIKIŞ ŞUBESİNDE'), $ => $('#notDeliveredDataGrid tr').slice(1).remove());
    expect(parseAras(taken, empty, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'ÇIKIŞ ŞUBESİNDE',
      expected_delivery: '2026-01-11', summary_only: true, events: [] });
    expect(() => parseAras(edit(taken, $ => $('#Son_Durum').text('')), empty, NUMBER)).toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
    for (const [body, other] of [[summary, edit(movements, $ => $('#transactionsDataGrid td').first().text('Tarih'))],
      [summary, edit(movements, $ => $('#transactionsDataGrid').append(row('31.2.2026 10:00:00', 'ÖRNEKİL', 'ÖRNEK', 'ŞUBEDE ARAÇ İNDİRME')))],
      [summary, edit(movements, $ => $('#transactionsDataGrid').append(row('12.1.2026', 'ÖRNEKİL', 'ÖRNEK', 'ŞUBEDE ARAÇ İNDİRME')))],
      [summary, edit(movements, $ => $('#transactionsDataGrid').append(row('12.1.2026 10:00:00', 'ÖRNEKİL', 'ÖRNEK', '')))],
      [summary, edit(movements, $ => $('#transactionsDataGrid').append(row('12.1.2026 10:00:00', 'ÖRNEKİL', 'ÖRNEK', 'ŞUBEDE ARAÇ İNDİRME', 'X')))],
      [summary, edit(movements, $ => $('#redirectionDataGrid').append(row('2026-01-10', 'NORMAL', 'YÖNLENDİRİLDİ', 'A', 'B', 'C')))],
      [edit(summary, $ => $('#notDeliveredDataGrid').append(row('11.01.2026 10:00', 'UĞRAMA NOTU BIRAKILDI (1-2)', '')))],
      [edit(summary, $ => $('#notDeliveredDataGrid').append(row('11.01.2026', '', 'PRIVATE_SYNTHETIC_NOTE')))],
      [status('TESLİM EDİLDİ', '12.01.2026'), movements], [status('', '12.01.2026 10:20'), movements],
      [edit(summary, $ => $('#Son_Durum').remove()), movements], [edit(summary, $ => $('#varis_subesi').clone().appendTo('body')), movements],
      [summary, edit(movements, $ => $('#transactionsDataGrid').clone().appendTo('body'))],
      [summary, edit(movements, $ => $('#transactionsDataGrid').append(row('9.1.2026 10:00:00', 'A', 'B', 'C').repeat(301)))]]) {
      expect(() => parseAras(body!, other ?? movements, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const long = edit(movements, $ => $('#transactionsDataGrid').append(Array.from({ length: 120 },
      (_, index) => row(`8.1.2026 10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`, 'A', 'B', 'C')).join('')));
    expect(parseAras(summary, long, NUMBER).events).toHaveLength(100);
  });

  it('maps every recorded wording, and the status map answers as the parser stages', () => {
    for (const entry of statuses.entries) {
      expect(arasStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'aras-kargo', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'aras-kargo', description: '  TESLİM   EDİLDİ ' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'aras-kargo', description: 'YÖNLENDİRİLDİ (VARIŞ MERKEZİ HATASI)' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'aras-kargo', providerCode: '5', description: 'TESLİM EDİLDİ' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', 'TESLİM', 'TESLİM EDİLDİ (X)', 'UĞRAMA NOTU BIRAKILDI', 'YÖNLENDİRİLDİX', '(X) YÖNLENDİRİLDİ']) {
      expect(arasStage(wording), wording).toBeUndefined();
    }
  });

  it('reads the merchants\' tracking link as an Aras Kargo number', () => {
    for (const link of [`${ORIGIN}/mainpage.aspx?code=${NUMBER}`, `https://kargotakip.araskargo.com.tr/mainPage.aspx?code=${NUMBER}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: NUMBER, carrier: 'aras-kargo', source: 'link' });
    }
  });

  it('walks the tracker in one anonymous session and follows no redirect', async () => {
    const fetcher = session();
    const instance = adapter(environment(fetcher));
    expect(await instance.track({ number: ` ${NUMBER} `, postcode: 'PRIVATE_SYNTHETIC_POSTCODE' })).toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${ORIGIN}/mainpage.aspx?code=${NUMBER}`, `${ORIGIN}/kargotakip.aspx`,
      `${ORIGIN}/${WAYBILL}`, `${ORIGIN}/CargoInfoTransactionAndRedirection.aspx`]);
    for (const [index, [, init]] of fetcher.mock.calls.entries()) {
      expect(init).toMatchObject({ redirect: 'manual', cache: 'no-store' });
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBeTruthy();
      expect(headers.get('accept-language')).toMatch(/^tr-TR/);
      expect(headers.get('cookie')).toBe(index ? 'ASP.NET_SessionId=syntheticsession0000000000; Cus_int_nlb=synthetic-route' : null);
    }
    await expect(instance.track({ number: '990000000000' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('reports not found from the lookup page alone, and a session it cannot follow as inconclusive', async () => {
    const unknown = session({ lookup: () => reply(absent) });
    await expect(new ArasKargoTracker({ fetcher: unknown }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(unknown).toHaveBeenCalledTimes(1);
    const moved = (location: string) => () => new Response(null, { status: 302, headers: [['Location', location],
      ['Set-Cookie', 'ASP.NET_SessionId=syntheticsession0000000000; path=/']] });
    for (const pages of [{ lookup: moved('/mainPage.aspx') }, { lookup: moved('https://other.test/kargotakip.aspx') },
      { lookup: moved('/kargotakip.aspx?x=1') }, { lookup: () => new Response(null, { status: 302, headers: { Location: '/kargotakip.aspx' } }) },
      { lookup: () => reply('<html><body>Bakım çalışması</body></html>') },
      { tracker: moved('/mainPage.aspx') }, { tracker: () => reply('', { status: 404 }) },
      { summary: () => reply(edit(summary, $ => $('#labelShipmentCode').text(''))) }, { movements: () => reply('', { status: 410 }) }]) {
      await expect(new ArasKargoTracker({ fetcher: session(pages) }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const crowded = () => new Response(null, { status: 302, headers: [['Location', '/kargotakip.aspx'],
      ...Array.from({ length: 17 }, (_, index) => ['Set-Cookie', `c${index}=v; path=/`] as [string, string])] });
    await expect(new ArasKargoTracker({ fetcher: session({ lookup: crowded }) }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps the HTTP failure taxonomy, starts again once after a failed connection and bounds bodies', async () => {
    for (const [code, kind] of [[404, 'indeterminate'], [410, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      await expect(new ArasKargoTracker({ fetcher: session({ lookup: () => reply(absent, { status: code }) }) }).fetch(NUMBER), String(code))
        .rejects.toMatchObject({ kind });
      await expect(new ArasKargoTracker({ fetcher: session({ movements: () => reply('', { status: code }) }) }).fetch(NUMBER), String(code))
        .rejects.toMatchObject({ kind });
    }
    let failed = false;
    const pages = session();
    const flaky = vi.fn<typeof fetch>(async (url, init) => {
      if (!failed && String(url).includes('kargotakip.aspx')) { failed = true; throw new TypeError('fetch failed'); }
      return pages(url, init);
    });
    // The retry opens a new session from the lookup page.
    pages.mockImplementationOnce(async () => found());
    expect(await new ArasKargoTracker({ fetcher: flaky }).fetch(NUMBER)).toMatchObject({ status: 'delivered' });
    expect(flaky.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/mainpage.aspx', '/kargotakip.aspx', '/mainpage.aspx',
      '/kargotakip.aspx', '/CargoInfoWaybillAndDelivered.aspx', '/CargoInfoTransactionAndRedirection.aspx']);
    const large = session({ summary: () => new Response(new Uint8Array(600_000)) });
    await expect(new ArasKargoTracker({ fetcher: large }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });

  it('recognizes a known parcel and treats only the absent answer as unknown', async () => {
    const known = session();
    const instance = adapter(environment(known));
    expect(await instance.recognize!('990000000000')).toEqual({ known: false });
    expect(known).not.toHaveBeenCalled();
    // A local clock dates the last activity without an instant.
    expect(await instance.recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-12T10:20:00' });
    expect(await adapter(environment(session({ lookup: () => reply(absent) }))).recognize!(NUMBER)).toEqual({ known: false });
    await expect(adapter(environment(session({ lookup: () => reply('<html>Bakım</html>') }))).recognize!(NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = session();
    await expect(new ArasKargoTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new ArasKargoTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    // A request that hangs ends with the budget, started again at most once.
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new ArasKargoTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
