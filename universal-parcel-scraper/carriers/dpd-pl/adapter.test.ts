import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { dpdParcelNumber } from '../../core/detection/dpd.js';
import { detectCarrierMatch, isValidDpdParcelNumber, parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult, type CarrierEvent, type CarrierResult } from '../../core/result/index.js';
import { DpdPlTracker, adapter } from './adapter.js';
import { normalizeDpdPlNumber, parseDpdPl, validateDpdPlBootstrap } from './parser.js';
import { DPD_PL_POLISH, dpdPlScanStage, isDpdPlCollection, isDpdPlNotice } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '9999000000001U';
const SECOND = '9999000000002U';
const html = readFileSync(new URL('./fixtures/history.html', import.meta.url), 'utf8');
const landing = '<form id="searchForm" action="./parcelDetails" class="form-block"><input type="text" name="p1" maxlength="28"/>'
  + '<input type="radio" name="typ" value="1" checked /><input type="radio" name="typ" value="2" /></form>';
const absent = (number = NUMBER) => `<div class="single-package"><fieldset class="compact"><p>There is no trace for this parcel (${number})</p>`
  + '<p>The reasons can be</p><ul><li><p>The number you have entered is incorrect</p></li></ul></fieldset></div>';
const absentInPolish = `<div class="single-package"><fieldset class="compact"><p>Wprowadzono błędny numer przesyłki (${NUMBER})</p><p>Powodem tego może być</p></fieldset></div>`;
const edit = (change: (document: ReturnType<typeof load>) => void) => { const $ = load(html, null, false); change($); return $.html(); };
const history = (...rows: [string, string, string, string][]) => edit($ => $('tbody').html(rows
  .map(([day, time, description, depot]) => `<tr><td>${day}</td><td>${time}</td><td>${description}</td><td>${depot}</td></tr>`).join('')));
// A page as the Polish session gives it: its heading, columns and labels in Polish.
const inPolish = (body: string) => { const $ = load(body, null, false);
  $('th').each((index, node) => { $(node).text(['Data', 'Godzina', 'Opis', 'Oddział'][index]!); });
  $('h3').text('Historia przesyłki');
  $('.form-group > .label').each((_, node) => { $(node).text(({ Parcel: 'Przesyłka', Package: 'Paczka' } as Record<string, string>)[$(node).text()] ?? $(node).text()); });
  return $.html(); };
const COOKIES = ['JSESSIONID=synthetic~session; Path=/; Secure; HttpOnly', '__cf_bm=synthetic.bot-score_1; HttpOnly; SameSite=None; Secure; Path=/'];
const page = (cookies = COOKIES, body = landing) => {
  const headers = new Headers({ 'Content-Type': 'text/html;charset=UTF-8' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(body, { headers });
};
const reply = (body = html, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('DPD Poland direct tracking', () => {
  it('projects the package history, with Polish clocks only where a Polish depot or pickup point scanned', () => {
    const result = normalizeCarrierResult(parseDpdPl(html, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Parcel delivered',
      last_update: '2026-03-05T14:10:00+01:00', delivered_at: '2026-03-05T14:02:11+01:00' });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events?.map(event => [event.description, event.stage, event.stage_source])).toEqual([
      ['Mail notification', 'delivered', 'none'],
      ['Parcel delivered', 'delivered', 'carrier_map'],
      ['SMS notification', 'ready_for_pickup', 'none'],
      ['Parcel collected by pickup point', 'ready_for_pickup', 'carrier_map'],
      ['Parcel dispatched to be collected by pickup point', 'in_transit', 'carrier_map'],
      ['Parcel received by DPD depot', 'in_transit', 'carrier_map'],
      ['Mail notification', 'accepted', 'none'],
      ['Parcel collected by courier', 'accepted', 'carrier_map'],
      ['Registered parcel data, parcel not dispatched yet', 'registered', 'carrier_map'],
    ]);
    expect(result.events?.[3]!.time).toBe('2026-03-04T09:25:41+01:00');
    expect(result.events?.[7]).toEqual({ local_time: '2026-03-03T18:47:30', provider_time_text: '2026-03-03 18:47:30',
      description: 'Parcel collected by courier', stage: 'accepted', stage_source: 'carrier_map' });
    expect(result.events?.every(event => event.location === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SYNTHETIC|PL99001|9999000000002U/);
  });

  it('binds the reply to the requested package, including a second package of the parcel', () => {
    const second = edit($ => { $('input.js-waybill-paczki').attr('value', SECOND); $('.input-text').eq(1).text(SECOND); });
    expect(parseDpdPl(second, SECOND).status).toBe('delivered');
    for (const body of [second, edit($ => $('input.js-waybill-paczki').attr('value', SECOND)), edit($ => $('.input-text').eq(1).text(SECOND)),
      edit($ => $('input.js-waybill-paczki').clone().appendTo('.single-package')), edit($ => $('input.js-waybill').remove()),
      edit($ => $(`option[value="${NUMBER}"]`).remove()), edit($ => $('table.table-track').clone().appendTo('.single-package'))]) {
      expect(() => parseDpdPl(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes a waybill or a DPD parcel number, without its check character', () => {
    const check = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(character => isValidDpdParcelNumber(`13000000000002${character}`))!;
    const wrong = check === 'A' ? 'B' : 'A';
    expect(normalizeDpdPlNumber(' 9999 0000 0000 1u ')).toBe(NUMBER);
    expect(normalizeDpdPlNumber('13000000000002')).toBe('13000000000002');
    expect(normalizeDpdPlNumber(`13000000000002${check}`)).toBe('13000000000002');
    for (const number of ['', '999900000001U', '99990000000001UU', '1300000000000', `13000000000002${wrong}`, 'ABCDEFGHIJKLMN']) {
      expect(() => normalizeDpdPlNumber(number)).toThrow(InvalidInputError);
    }
  });

  it('selects its waybill, lists its fourteen-digit range first, and reads its links whatever search type they name', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'dpd-pl', confidence: 'high' });
    const shared = detectCarrierMatch('13000000000002');
    expect(shared).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['dpd-pl'] });
    expect(shared.candidates[0]).toBe('dpd-pl');
    expect(parseTrackingInput(`https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'dpd-pl', confidence: 'high', source: 'link' });
    expect(parseTrackingInput('https://tt.dpd.com.pl/EN/parcelDetails?p1=13000000000002&typ=3'))
      .toMatchObject({ trackingNumber: '13000000000002', carrier: 'dpd-pl', confidence: 'high', source: 'link' });
  });

  it('lists its range first for a parcel number typed with its check character, and only when the character matches', () => {
    const checked = (digits: string) => `${digits}${[...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(character => dpdParcelNumber(`${digits}${character}`))!}`;
    for (const number of [checked('13000000000002'), checked('13000000000038')]) {
      const match = detectCarrierMatch(number);
      expect(match).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['dpd-pl'] });
      expect(match.candidates[0]).toBe('dpd-pl');
      expect(match.candidates).toEqual(expect.arrayContaining(['dpd', 'dpd-de', 'dpd-uk', 'chronopost']));
      expect(recognitionAskedCarriers(number)[0]).toBe('dpd-pl');
    }
    // The second check character is a digit, so fifteen-digit rules of other carriers match too.
    expect(detectCarrierMatch(checked('13000000000038')).candidates).toEqual(expect.arrayContaining(['dpd-fr', 'brt', 'yunda']));
    const valid = checked('13000000000002');
    const wrong = `${valid.slice(0, 14)}${valid.endsWith('A') ? 'B' : 'A'}`;
    expect(detectCarrierMatch(wrong).candidates).not.toContain('dpd-pl');
    expect(detectCarrierMatch(checked('14000000000002'))).not.toMatchObject({ preferred: ['dpd-pl'] });
    expect(detectCarrierMatch(checked('14000000000002')).candidates).not.toContain('dpd-pl');
  });

  it('reports a parcel absent only on the scoped no-trace answer naming the number', () => {
    expect(() => parseDpdPl(absent(), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDpdPl(absentInPolish, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDpdPl(absent(SECOND), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const body of ['<html>Maintenance</html>', absent().replace('There is no trace', 'There is a problem'),
      absent().replace('</fieldset>', '</fieldset><fieldset class="compact"><p>Notice</p></fieldset>'), edit($ => $('table').remove())]) {
      expect(() => parseDpdPl(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseDpdPl('<html><head><title>Just a moment...</title></head></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps wording it does not know and leaves out a row without any', () => {
    const result = parseDpdPl(history(['2026-03-05', '15:00:00', '2nd attempt / "Example" &amp; more!', 'ZZZ'],
      ['2026-03-05', '14:30:00', '', 'ZZZ'], ['2026-03-05', '14:02:11', 'Parcel delivered', 'ZZZ']), NUMBER);
    expect(result.events?.map(event => [event.description, event.stage])).toEqual([
      ['2nd attempt / "Example" & more!', undefined], ['Parcel delivered', 'delivered'],
    ]);
    expect(() => parseDpdPl(history(['2026-03-05', '14:30:00', '', 'ZZZ']), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects mixed languages, changed columns and malformed rows, and bounds the history', () => {
    for (const body of [edit($ => $('th').first().text('Data')), edit($ => $('h3').text('Historia przesyłki')),
      inPolish(history(['2026-03-05', '14:02:11', 'Przesyłka doręczona', 'ZZZ'])).replace('>Paczka<', '>Package<'),
      history(['2026-03-05', '14:02:11', 'Parcel delivered', 'ZZZ']).replace('<td>ZZZ</td>', '<td>ZZZ</td><td>Extra</td>'),
      history(['05.03.2026', '14:02:11', 'Parcel delivered', 'ZZZ']), history(['2026-03-05', '14:02', 'Parcel delivered', 'ZZZ']),
      history(['2026-02-30', '14:02:11', 'Parcel delivered', 'ZZZ']),
      history(...Array.from({ length: 501 }, () => ['2026-03-05', '14:02:11', 'Parcel received by DPD depot', 'ZZZ'] as [string, string, string, string]))]) {
      expect(() => parseDpdPl(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDpdPl(history(), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDpdPl(history(['2026-03-05', '14:02:11', 'Mail notification', 'XX1']), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const long = history(...Array.from({ length: 120 }, (_, index) => ['2026-03-05', `14:${String(index % 60).padStart(2, '0')}:${String(Math.floor(index / 60)).padStart(2, '0')}`,
      'Parcel received by DPD depot', 'ZZZ'] as [string, string, string, string]));
    expect(parseDpdPl(long, NUMBER).events).toHaveLength(100);
  });

  it('stages a collection by the scans before it', () => {
    const droppedOff = parseDpdPl(history(['2026-07-02', '08:00:00', 'Parcel received by DPD depot', 'ZZ1'],
      ['2026-07-01', '18:00:00', 'Parcel collected by courier', 'ZZ1'], ['2026-07-01', '12:00:00', 'Mail notification', 'XX1'],
      ['2026-07-01', '11:00:00', 'Parcel dropped-off in pickup point', 'ZZ1/PL99001'],
      ['2026-06-30', '10:00:00', 'Registered parcel data, parcel not dispatched yet', '']), NUMBER);
    expect(droppedOff.events?.map(event => event.stage)).toEqual(['in_transit', 'in_transit', 'accepted', 'accepted', 'registered']);
    expect(droppedOff.events?.[0]!.time).toBe('2026-07-02T08:00:00+02:00');
    const inbound = parseDpdPl(history(['2026-07-03', '09:00:00', 'Parcel received by DPD depot', 'ZZZ'],
      ['2026-07-02', '21:00:00', 'Parcel collected by courier', ''], ['2026-07-02', '08:00:00', 'Parcel received by DPD depot', ''],
      ['2026-07-01', '17:00:00', 'Parcel collected', ''], ['2026-07-01', '09:00:00', 'Registered parcel data, parcel not dispatched yet', '']), NUMBER);
    expect(inbound.events?.map(event => [event.stage, event.time ?? event.local_time])).toEqual([['in_transit', '2026-07-03T09:00:00+02:00'],
      ['in_transit', '2026-07-02T21:00:00'], ['in_transit', '2026-07-02T08:00:00'], ['accepted', '2026-07-01T17:00:00'], ['registered', '2026-07-01T09:00:00']]);
    const noticeFirst = parseDpdPl(history(['2026-07-02', '09:00:00', 'Parcel received by DPD depot', 'ZZZ'], ['2026-07-01', '09:00:00', 'SMS notification', 'XX1']), NUMBER);
    expect(noticeFirst.events?.map(event => [event.stage, event.stage_source])).toEqual([['in_transit', 'carrier_map'], ['registered', 'none']]);
  });

  it('ends delivery at a refusal or a return without keeping the return number', () => {
    const result = parseDpdPl(history(['2026-07-04', '10:00:00', 'Parcel return<br>Return parcel number:&nbsp;<a href="./parcelDetails?p1=9999000000003L">9999000000003L</a>', 'ZZ1'],
      ['2026-07-03', '10:00:00', 'Parcel not delivered - recipient resigned', ''], ['2026-07-02', '10:00:00', 'Parcel collected by courier', ''],
      ['2026-07-01', '10:00:00', 'Registered parcel data, parcel not dispatched yet', '']), NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Parcel return' });
    expect(result.events?.map(event => event.stage)).toEqual(['exception', 'exception', 'accepted', 'registered']);
    expect(JSON.stringify(result)).not.toContain('9999000000003L');
  });

  it('keeps new wording unstaged and never derives an older delivery or a foreign clock', () => {
    const unknown = parseDpdPl(history(['2026-07-03', '09:00:00', 'Parcel teleported<br>Recipient: PRIVATE_SYNTHETIC_NAME', 'ZZZ'],
      ['2026-07-03', '08:00:00', 'Recipient: PRIVATE_SYNTHETIC_NAME', 'ZZZ'], ['2026-07-02', '09:00:00', 'Parcel delivered', 'ZZZ']), NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Parcel teleported' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.delivered_at).toBeUndefined();
    expect(unknown.events?.slice(0, 2).map(event => [event.description, event.stage])).toEqual([['Parcel teleported', undefined], ['Recipient', undefined]]);
    expect(JSON.stringify(unknown)).not.toContain('PRIVATE_SYNTHETIC');
    for (const depot of ['', '0176', 'zz1', 'ZZZ/XX99001']) {
      const abroad = parseDpdPl(history(['2026-07-02', '09:00:00', 'Parcel delivered', depot]), NUMBER);
      expect(abroad).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-07-02T09:00:00' });
      expect(abroad.delivered_at).toBeUndefined();
      expect(abroad.events?.[0]).toMatchObject({ local_time: '2026-07-02T09:00:00', provider_time_text: '2026-07-02 09:00:00' });
    }
    expect(parseDpdPl(history(['2026-07-02', '09:00:00', 'Parcel delivered', '/PL99001']), NUMBER).delivered_at).toBe('2026-07-02T09:00:00+02:00');
  });

  it('maps every recorded wording, and the status map answers as the parser stages', () => {
    for (const entry of statuses.entries) {
      if ('stage' in entry && entry.stage) {
        expect(dpdPlScanStage(entry.wording), entry.wording).toBe(entry.stage);
        expect(statusMapAnswer({ carrier: 'dpd-pl', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
      } else {
        expect(isDpdPlNotice(entry.wording) || isDpdPlCollection(entry.wording), entry.wording).toBe(true);
      }
    }
    expect(statusMapAnswer({ carrier: 'dpd-pl', description: ' sms   Notification ' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'dpd-pl', description: 'Parcel collected by courier' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'dpd-pl', providerCode: 'DLV', description: 'Parcel delivered' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', 'Delivered']) expect(dpdPlScanStage(wording)).toBeUndefined();
  });

  it('requires the anonymous search form', () => {
    expect(() => validateDpdPlBootstrap(landing)).not.toThrow();
    for (const body of ['', landing.replace('./parcelDetails', 'https://other.test/parcelDetails'), landing.replace('name="p1"', 'name="other"'),
      landing.replace('value="1"', 'value="5"'), landing + landing]) {
      expect(() => validateDpdPlBootstrap(body)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => validateDpdPlBootstrap('<html><head><title>Just a moment...</title></head></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it('opens an English session, then posts only the number with that session', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
      const index = fetcher.mock.calls.length - 1;
      expect(init).toMatchObject({ cache: 'no-store', redirect: 'manual' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBeTruthy();
      expect(headers.has('authorization')).toBe(false);
      if (index === 0) {
        expect(String(url)).toBe('https://tracktrace.dpd.com.pl/EN/findParcel');
        expect(init?.method).toBeUndefined();
        expect(headers.has('cookie')).toBe(false);
        return page();
      }
      expect(String(url)).toBe('https://tracktrace.dpd.com.pl/EN/findPackage');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toBe(`q=${NUMBER}&typ=1`);
      expect(headers.get('cookie')).toBe('JSESSIONID=synthetic~session; __cf_bm=synthetic.bot-score_1');
      expect(headers.get('x-requested-with')).toBe('XMLHttpRequest');
      return reply();
    });
    const instance = adapter(environment(fetcher));
    expect(await instance.track({ number: '9999 0000 0000 1u', postcode: 'PRIVATE_SYNTHETIC_POSTCODE' })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('needs a fresh session for every lookup and refuses a missing one', async () => {
    for (const cookies of [[], ['JSESSIONID=; Path=/'], ['JSESSIONID=bad value; Path=/'], [COOKIES[1]!]]) {
      const fetcher = vi.fn(async () => page(cookies)) as unknown as typeof fetch;
      await expect(new DpdPlTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(reply(absent()))
      .mockResolvedValueOnce(page([COOKIES[0]!])).mockResolvedValueOnce(reply(absent()));
    const tracker = new DpdPlTracker({ fetcher: fetcher as unknown as typeof fetch });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(new Headers(fetcher.mock.calls[2]![1].headers).has('cookie')).toBe(false);
    expect(new Headers(fetcher.mock.calls[3]![1].headers).get('cookie')).toBe('JSESSIONID=synthetic~session');
  });

  it('recognizes a known package and treats only the no-trace answer as unknown', async () => {
    const positive = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(reply());
    const instance = adapter(environment(positive));
    expect(await instance.recognize!('invalid')).toEqual({ known: false });
    expect(positive).not.toHaveBeenCalled();
    expect(await instance.recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: '2026-03-05T13:10:00.000Z' });
    const absentLookup = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(reply(absent()));
    expect(await adapter(environment(absentLookup as unknown as typeof fetch)).recognize!(NUMBER)).toEqual({ known: false });
    const outage = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(reply('<html>Unavailable</html>'));
    await expect(adapter(environment(outage as unknown as typeof fetch)).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps the HTTP failure taxonomy at both steps and bounds bodies', async () => {
    for (const [status, kind] of [[404, 'indeterminate'], [410, 'indeterminate'], [302, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      for (const step of [0, 1]) {
        const fetcher = vi.fn();
        if (step) fetcher.mockResolvedValueOnce(page());
        fetcher.mockResolvedValueOnce(new Response(absent(), { status, headers: status === 302 ? { Location: '/elsewhere' } : {} }));
        await expect(new DpdPlTracker({ fetcher: fetcher as unknown as typeof fetch }).fetch(NUMBER)).rejects.toMatchObject({ kind });
        expect(fetcher).toHaveBeenCalledTimes(step + 1);
      }
    }
    const fetcher = vi.fn(async () => new Response(new Uint8Array(1_000_001))) as unknown as typeof fetch;
    await expect(new DpdPlTracker({ fetcher }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = vi.fn(async () => page()) as unknown as typeof fetch;
    await expect(new DpdPlTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new DpdPlTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    for (const step of [0, 1]) {
      const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => {
        const index = fetcher.mock.calls.length - 1;
        // A transport that finishes after ignoring its cancellation.
        if (index === step) await new Promise(resolve => setTimeout(resolve, 35));
        return index === 0 ? page() : reply();
      });
      await expect(new DpdPlTracker({ fetcher }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: 'budget' });
      expect(fetcher).toHaveBeenCalledTimes(step + 1);
    }
  });
});

describe('DPD Poland in Polish', () => {
  // A parcel's scans worded on each page, newest first, where both are seen.
  const ROWS: [string, string, string, string, string][] = [
    ['2026-07-06', '10:00:00', 'Mail notification', 'Powiadomienie mail', 'XX1'],
    ['2026-07-06', '09:55:00', 'Parcel delivered<br>Recipient: PRIVATE_SYNTHETIC_NAME', 'Przesyłka doręczona <br>Odbiorca:&nbsp;PRIVATE_SYNTHETIC_NAME', 'ZZ1'],
    ['2026-07-06', '08:00:00', 'Parcel dispatched to be delivered', 'Wydanie do doręczenia za granicą', ''],
    ['2026-07-06', '07:00:00', 'Parcel received by DPD depot', 'Przyjęcie przesyłki w oddziale doręczenia za granicą', ''],
    ['2026-07-05', '16:00:00', 'Parcel received by DPD depot', 'Przeładunek w sortowni za granicą', ''],
    ['2026-07-04', '02:00:00', 'Sent outside Poland', 'Przekazano za granicę', 'ZZ2'],
    ['2026-07-03', '18:00:00', 'Parcel received by DPD depot', 'Przyjęcie przesyłki w oddziale DPD', 'ZZ2'],
    ['2026-07-03', '17:00:00', 'Parcel collected by courier', 'Przesyłka odebrana przez Kuriera', ''],
    ['2026-07-03', '12:00:00', 'SMS notification', 'Powiadomienie SMS', 'XX1'],
    ['2026-07-03', '11:00:00', 'Parcel dropped-off in pickup point', 'Nadanie przesyłki w punkcie Pickup', 'ZZ2/PL99001'],
    ['2026-07-02', '10:00:00', 'Registered parcel data, parcel not dispatched yet', 'Zarejestrowano dane przesyłki, przesyłka jeszcze nienadana', ''],
  ];
  const english = history(...ROWS.map(([day, time, en, , depot]) => [day, time, en, depot] as [string, string, string, string]));
  const polish = inPolish(history(...ROWS.map(([day, time, , pl, depot]) => [day, time, pl, depot] as [string, string, string, string])));
  const unworded = (result: CarrierResult) => ({ ...result, last_status_text: undefined, events: result.events!.map(event => ({ ...event, description: undefined })) });
  // A session opened in the language its path names, and the reply that language gives.
  const fetcherFor = (replies: { en: () => Response; pl: () => Response }) => vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    const answer = path.startsWith('/EN/') ? replies.en : replies.pl;
    return path.endsWith('/findParcel') ? page() : answer();
  });
  const paths = (fetcher: ReturnType<typeof fetcherFor>) => fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);

  it('reads the Polish page as it reads the English one', () => {
    const fromEnglish = parseDpdPl(english, NUMBER);
    const fromPolish = parseDpdPl(polish, NUMBER);
    expect(unworded(fromPolish)).toEqual(unworded(fromEnglish));
    expect(fromEnglish).toMatchObject({ status: 'delivered', last_status_text: 'Parcel delivered' });
    expect(fromPolish).toMatchObject({ status: 'delivered', last_status_text: 'Przesyłka doręczona', delivered_at: '2026-07-06T09:55:00+02:00' });
    expect(JSON.stringify(fromPolish)).not.toContain('PRIVATE_SYNTHETIC');
    // Every Polish wording reads as its English twin, whatever scans surround it.
    for (const [wording, twin] of Object.entries(DPD_PL_POLISH)) {
      expect(dpdPlScanStage(wording), wording).toBe(dpdPlScanStage(twin));
      expect(isDpdPlCollection(wording), wording).toBe(isDpdPlCollection(twin));
      expect(isDpdPlNotice(wording), wording).toBe(isDpdPlNotice(twin));
    }
  });

  it('asks for the Polish page for a Polish reader and for the English one otherwise', async () => {
    for (const [language, asked] of [['pl', 'pl'], ['pl-PL', 'pl'], ['de', 'en'], [null, 'en']] as const) {
      const fetcher = fetcherFor({ en: () => reply(english), pl: () => reply(polish) });
      const result = await adapter(environment(fetcher)).track({ number: NUMBER, language });
      expect(paths(fetcher)).toEqual(asked === 'pl' ? ['/findParcel', '/findPackage'] : ['/EN/findParcel', '/EN/findPackage']);
      expect(result.last_status_text).toBe(asked === 'pl' ? 'Przesyłka doręczona' : 'Parcel delivered');
    }
  });

  it('asks again in English when the Polish page has a wording the map has no English for', async () => {
    const unread = inPolish(history(['2026-07-07', '09:00:00', 'Nowe zdarzenie syntetyczne', 'ZZ1'],
      ...ROWS.map(([day, time, , pl, depot]) => [day, time, pl, depot] as [string, string, string, string])));
    const fetcher = fetcherFor({ en: () => reply(english), pl: () => reply(unread) });
    expect(await adapter(environment(fetcher)).track({ number: NUMBER, language: 'pl' })).toEqual(parseDpdPl(english, NUMBER));
    expect(paths(fetcher)).toEqual(['/findParcel', '/findPackage', '/EN/findParcel', '/EN/findPackage']);
    // Without the English page, the Polish one stands.
    const failing = fetcherFor({ en: () => new Response('', { status: 503 }), pl: () => reply(unread) });
    expect(await adapter(environment(failing)).track({ number: NUMBER, language: 'pl' })).toEqual(parseDpdPl(unread, NUMBER));
  });

  it('lets a scan worded in one language take over the row stored in the other', () => {
    const policy = sameInstantIdentityPolicy('dpd-pl', { supportsScanMatching: true })!;
    const scan = (event: CarrierEvent) => ({ stage: event.stage ?? '', description: event.description ?? '', location: event.location ?? '', providerCode: '' });
    const fromEnglish = parseDpdPl(english, NUMBER).events!.map(scan);
    const fromPolish = parseDpdPl(polish, NUMBER).events!.map(scan);
    for (const [index, row] of fromEnglish.entries()) {
      expect(policy.matches!(fromPolish[index]!, row), String(index)).toBe(true);
      expect(policy.matches!(row, fromPolish[index]!), String(index)).toBe(true);
    }
    // At one instant, a notice and a movement stay apart.
    expect(policy.matches!(fromPolish[0]!, fromEnglish[1]!)).toBe(false);
    expect(policy.matches!({ ...fromPolish[1]!, description: 'Zwrot przesyłki' }, fromEnglish[1]!)).toBe(false);
  });
});
