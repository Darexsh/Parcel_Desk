import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, MngKargoTracker } from './adapter.js';
import { normalizeMngKargoNumber, parseMngKargo, parseMngKargoForm } from './parser.js';
import { mngKargoStage, statusMap } from './status.js';

const NUMBER = '900000000017';
const TOKEN = 'CfDJ8SYNTHETICTOKENaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbb-cccc';
const ANTIFORGERY = '.AspNetCore.Antiforgery.SyntheticKey';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const environment = (fetcher: typeof fetch) => ({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
const PRIVATE = /ÖR\*\*|AL\*\*|GÖ\*\*|ÖRNEK MAH|0000 000|tel:|maps\.example|ORNEKSIPARIS|ÖRNEK TİCARET|ÖRNEKİL|900000000099|Teslim Alan|Desi|Peşin/;

/** The page with its rows changed: `edit` gets each scan row and the page. */
function edited(name: string, edit: ($: ReturnType<typeof load>) => void): string {
  const $ = load(fixture(name));
  edit($);
  return $.html();
}

const formPage = (cookies: string[] = [`${ANTIFORGERY}=syntheticCookie_1; path=/; samesite=strict; httponly`,
  'TS01abcdef=syntheticEdge; Path=/']) => new Response(fixture('form'), { headers: cookies.map(cookie => ['set-cookie', cookie] as [string, string]) });

describe('DHL eCommerce Türkiye shipment page', () => {
  it('reads dated scans newest first, with branches and failure reasons but no private detail', () => {
    const result = normalizeCarrierResult(parseMngKargo(fixture('delivered'), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Teslim Edildi', last_update: null, last_update_local: '2026-01-08', expected_delivery: null });
    expect(result.events?.map(event => [event.local_time, event.stage, event.location ?? null, event.description?.slice(0, 40)])).toEqual([
      ['2026-01-08', 'delivered', 'ÖRNEKKÖY', 'Teslim Edildi'],
      ['2026-01-08', 'out_for_delivery', null, 'Gönderi Dağıtımda'],
      ['2026-01-07', 'failed_attempt', 'ÖRNEKKÖY', 'Teslim Edilemedi: Devir'],
      ['2026-01-07', 'failed_attempt', 'ÖRNEKKÖY', 'Teslimat Denemesi Başarısız: 07.01.2026 '],
      ['2026-01-07', 'out_for_delivery', null, 'Gönderi Dağıtımda'],
      ['2026-01-06', 'in_transit', 'ÖRNEKKÖY', 'Gönderi Teslimat Şubesinde'],
      ['2026-01-06', 'in_transit', null, 'Transfer Aşamasında'],
      ['2026-01-05', 'in_transit', null, 'Transfer Aşamasında'],
      ['2026-01-05', 'accepted', 'KAYNAKKÖY', 'Gönderi Hazırlanıyor'],
    ]);
    // The reason names where the parcel waits; the courier line and the branch's contact details are not read.
    expect(result.events?.[3]?.description).toBe('Teslimat Denemesi Başarısız: 07.01.2026 tarihinde adresinizde sizi bulamadığımız için '
      + 'gönderinizi teslim edemedik. Gönderinizi 09.01.2026 00:00:00 tarihine kadar ÖRNEKKÖY birimimizden teslim alabilirsiniz. '
      + 'Belirtilen tarihe kadar teslim alınmayan gönderiler, göndericisine iade edilmektedir.');
    expect(result.events?.every(event => event.stage_source === 'carrier_map' && !('time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.capabilities).toEqual(['history', 'location', 'eta']);
    expect(metadata.tracking).toMatchObject({ adapter: 'mng-kargo', steps: ['direct', 'retry'], localClocks: true });
  });

  it('reads a return, a reroute and planned attempts, and leaves the tracker\'s return number alone', () => {
    const result = parseMngKargo(fixture('returned'), NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Gönderi İade Edildi',
      last_update_local: '2026-01-12', expected_delivery: null });
    expect(result.events?.map(event => [event.stage ?? null, event.location ?? null, event.description])).toEqual([
      ['returned', null, 'Gönderi İade Edildi'],
      ['failed_attempt', 'ÖRNEKKÖY', 'Teslimat Denemesi Planlandı: Devir'],
      // A planned attempt with any other reason announces a delivery still to come.
      [null, 'ÖRNEKKÖY', 'Teslimat Denemesi Planlandı: Gönderiniz yarın ÖRNEKKÖY şubesinden dağıtıma çıkarılacaktır.'],
      ['in_transit', 'ÖRNEKKÖY', 'Gönderiniz Yeni Teslimat Şubesinde'],
      // The branch it is sent to, and the one it will leave from, are no scan places.
      ['in_transit', null, 'Yeni Teslimat Şubesine Doğru Yolda'],
      ['in_transit', 'ARAKÖY', 'Gönderi Teslimat Şubesinde'],
      ['in_transit', null, 'Transfer Aşamasında'],
      ['registered', null, 'Gönderi Müşteride Hazırlanıyor'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('keeps the estimate only while the parcel is on its way and the day is still ahead', () => {
    const active = edited('delivered', $ => { $('.rightBox > ul > li').slice(0, 4).remove(); });
    expect(parseMngKargo(active, NUMBER)).toMatchObject({ status: 'out_for_delivery', last_update_local: '2026-01-07',
      expected_delivery: '2026-01-07' });
    const late = edited('delivered', $ => { $('.rightBox > ul > li').slice(0, 1).remove(); });
    expect(parseMngKargo(late, NUMBER)).toMatchObject({ status: 'out_for_delivery', last_update_local: '2026-01-08', expected_delivery: null });
    const failed = edited('delivered', $ => { $('.rightBox > ul > li').slice(0, 2).remove(); });
    expect(parseMngKargo(failed, NUMBER)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', expected_delivery: null });
    const unreadable = edited('delivered', $ => {
      $('.rightBox > ul > li').slice(0, 4).remove();
      $('.textBox').filter((_, node) => $(node).children('.title').text() === 'Tahmini Teslimat Tarihi').children('.desc').text('Yakında');
    });
    expect(parseMngKargo(unreadable, NUMBER)).toMatchObject({ expected_delivery: null });
  });

  it('drops reasons that hold anything but text and branch names', () => {
    const page = (sentence: string) => edited('delivered', $ => {
      $('.rightBox > ul > li').slice(0, 2).remove();
      $('.rightBox > ul > li').first().children('.right').children('.title').first().html(sentence);
    });
    const description = (sentence: string) => parseMngKargo(page(sentence), NUMBER).events?.[0]?.description;
    expect(description('Adres <br> hatalı')).toBe('Teslim Edilemedi: Adres hatalı');
    expect(description('Alıcı <b>ÖR** AL**</b> adreste yok')).toBe('Teslim Edilemedi');
    expect(description('<a href="tel:+900000000000">0000 000 00 00</a> arayınız')).toBe('Teslim Edilemedi');
    expect(description('Kurye 0000 000 00 00 numaralı telefondan aradı')).toBe('Teslim Edilemedi');
    expect(description('Teslim Alan, <b>ÖR** AL**</b>')).toBe('Teslim Edilemedi');
    expect(description('')).toBe('Teslim Edilemedi');
    // Any reason after a failed delivery's label is still a failed delivery.
    expect(parseMngKargo(page('Adres hatalı'), NUMBER)).toMatchObject({ current_stage: 'failed_attempt' });
  });

  it('binds the page to the number and its single history', () => {
    expect(() => parseMngKargo(fixture('delivered'), '900000000025')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const mobileOther = edited('delivered', $ => {
      $('.listBox.d-md-none .textBox').filter((_, node) => $(node).children('.title').text() === 'Gönderi Numarası')
        .children('.desc').text('900000000025');
    });
    expect(() => parseMngKargo(mobileOther, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const unnumbered = edited('delivered', $ => {
      $('.textBox').filter((_, node) => $(node).children('.title').text() === 'Gönderi Numarası').remove();
    });
    expect(() => parseMngKargo(unnumbered, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const several = edited('delivered', $ => { $('.trackBox').append($('.rightBox').first().clone()); });
    expect(() => parseMngKargo(several, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    const repeated = edited('delivered', $ => { $('section.contentDetail').append($('.cargoTrackingPost').first().clone()); });
    expect(() => parseMngKargo(repeated, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const english = fixture('delivered').replace('<html lang="tr">', '<html lang="en">');
    expect(() => parseMngKargo(english, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('tells an empty history, the form, a firewall page and a changed row apart', () => {
    const empty = edited('delivered', $ => { $('.rightBox > ul > li').remove(); });
    expect(() => parseMngKargo(empty, NUMBER)).toThrow(NoHistoryError);
    const none = edited('delivered', $ => { $('.trackBox').remove(); });
    expect(() => parseMngKargo(none, NUMBER)).toThrow(NoHistoryError);
    expect(() => parseMngKargo(fixture('form'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMngKargo('<html lang="tr"><body></body></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const firewall = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>';
    expect(() => parseMngKargo(firewall, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseMngKargoForm(firewall)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseMngKargoForm('<html><script src="/TSPD/08abc?type=7"></script></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    const unlabelled = edited('delivered', $ => { $('.rightBox > ul > li').first().children('.left').children('.title').text(' '); });
    expect(() => parseMngKargo(unlabelled, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const undated = edited('delivered', $ => { $('.rightBox .dateBox').first().text('Bugün'); });
    expect(() => parseMngKargo(undated, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const duplicated = edited('delivered', $ => { $('.rightBox > ul > li').first().after($('.rightBox > ul > li').first().clone()); });
    expect(parseMngKargo(duplicated, NUMBER).events).toHaveLength(9);
  });

  it('reads the form token and refuses a changed form', () => {
    expect(parseMngKargoForm(fixture('form'))).toBe(TOKEN);
    expect(() => parseMngKargoForm(fixture('form').replace(TOKEN, 'short'))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMngKargoForm(fixture('form').replace('action="/gonderi-takip"', 'action="/elsewhere"')))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('maps whole labels, a failed delivery whatever its reason, and only the carried-over planned attempt', () => {
    expect(mngKargoStage('toString')).toBeUndefined();
    expect(mngKargoStage('Teslim Edildi')).toBe('delivered');
    expect(mngKargoStage('Teslim Edilemedi: Adres hatalı')).toBe('failed_attempt');
    expect(mngKargoStage('Teslim Edilemediler')).toBeUndefined();
    expect(mngKargoStage('Teslimat Denemesi Planlandı')).toBeUndefined();
    expect(mngKargoStage('Teslimat Denemesi Planlandı: Yarın')).toBeUndefined();
    expect(statusMap.stage(null, normalizeStatusWording('  Gönderi\tDağıtımda '))).toBe('out_for_delivery');
    expect(statusMap.stage('X', normalizeStatusWording('Teslim Edildi'))).toBeUndefined();
    const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')).entries as { wording: string; stage?: string }[];
    for (const entry of statuses) {
      expect(mngKargoStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMap.gaps.map(gap => gap.wording)).toEqual(statuses.filter(entry => !entry.stage).map(entry => normalizeStatusWording(entry.wording)));
  });
});

describe('DHL eCommerce Türkiye retrieval', () => {
  it('opens a session on the tracking page and posts the number with its token', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('User-Agent')).toBe('ExampleHost/1.0');
      if (fetcher.mock.calls.length === 1) {
        expect(String(url)).toBe('https://www.dhlecommerce.com.tr/gonderitakip');
        expect(init?.method ?? 'GET').toBe('GET');
        expect(headers.has('Cookie')).toBe(false);
        return formPage();
      }
      expect(String(url)).toBe('https://www.dhlecommerce.com.tr/gonderi-takip');
      expect(init?.method).toBe('POST');
      expect(headers.get('Cookie')).toBe(`${ANTIFORGERY}=syntheticCookie_1; TS01abcdef=syntheticEdge`);
      expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
      expect(headers.get('Referer')).toBe('https://www.dhlecommerce.com.tr/gonderitakip');
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ __RequestVerificationToken: TOKEN, form_shipment: NUMBER });
      return new Response(fixture('delivered'));
    });
    const instance = adapter({ ...environment(fetcher), userAgent: 'ExampleHost/1.0' });
    await expect(instance.track({ number: ` ${NUMBER.slice(0, 6)} ${NUMBER.slice(6)} ` })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reads the tracker's not-found redirect, and only that one, as not found", async () => {
    const run = (location: string) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => formPage())
        .mockImplementationOnce(async () => new Response('', { status: 302, headers: { Location: location } }));
      return new MngKargoTracker({ fetcher }).fetch(NUMBER);
    };
    await expect(run('/?ResultStatus=True&CargoCompany=NotFound')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(run('https://www.dhlecommerce.com.tr/?ResultStatus=True&CargoCompany=NotFound')).rejects.toMatchObject({ kind: 'not_found' });
    for (const location of ['/500', '/', '/?ResultStatus=False&CargoCompany=NotFound', '/?ResultStatus=True&CargoCompany=NotFound&x=1',
      'https://example.invalid/?ResultStatus=True&CargoCompany=NotFound', '']) {
      await expect(run(location), location).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    await expect(run('http://[')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('recognizes known and unknown numbers, and asks nothing about other shapes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => (fetcher.mock.calls.length % 2 ? formPage() : new Response(fixture('delivered'))));
    const instance = adapter(environment(fetcher));
    await expect(instance.recognize!('12345')).resolves.toEqual({ known: false });
    await expect(instance.recognize!('MNG900000000017')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance.recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    const missing = vi.fn<typeof fetch>().mockImplementationOnce(async () => formPage())
      .mockImplementationOnce(async () => new Response('', { status: 302, headers: { Location: '/?ResultStatus=True&CargoCompany=NotFound' } }));
    await expect(adapter(environment(missing)).recognize!(NUMBER)).resolves.toEqual({ known: false });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance'], [500, 'indeterminate'], [404, 'indeterminate']])(
    'keeps HTTP %s on either request distinct from a missing parcel', async (status, kind) => {
      const landing = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(new MngKargoTracker({ fetcher: landing }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(landing).toHaveBeenCalledOnce();
      const lookup = vi.fn<typeof fetch>().mockImplementationOnce(async () => formPage())
        .mockImplementationOnce(async () => new Response('', { status }));
      await expect(new MngKargoTracker({ fetcher: lookup }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(lookup).toHaveBeenCalledTimes(2);
    });

  it('needs the anti-forgery cookie and reads a firewall page as a challenge', async () => {
    const cookieless = vi.fn<typeof fetch>().mockImplementation(async () => formPage(['TS01abcdef=syntheticEdge; Path=/', 'other=1; Path=/']));
    await expect(new MngKargoTracker({ fetcher: cookieless }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(cookieless).toHaveBeenCalledOnce();
    const firewall = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>';
    const blocked = vi.fn<typeof fetch>().mockImplementationOnce(async () => formPage())
      .mockImplementationOnce(async () => new Response(firewall));
    await expect(new MngKargoTracker({ fetcher: blocked }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const landingBlocked = vi.fn<typeof fetch>().mockImplementation(async () => new Response(firewall));
    await expect(new MngKargoTracker({ fetcher: landingBlocked }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const moved = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 301, headers: { Location: '/' } }));
    await expect(new MngKargoTracker({ fetcher: moved }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('tries once more in a new session after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () => formPage()).mockImplementationOnce(async () => new Response(fixture('delivered')));
    await expect(new MngKargoTracker({ fetcher }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects other numbers before I/O and bounds cancellation, elapsed time and response size', async () => {
    const unused = vi.fn<typeof fetch>();
    for (const number of ['12345', '90000000001', '9000000000171', '90000000001A', `${NUMBER},900000000025`, '']) {
      await expect(new MngKargoTracker({ fetcher: unused }).fetch(number)).rejects.toThrow(InvalidInputError);
      expect(() => normalizeMngKargoNumber(number)).toThrow(InvalidInputError);
    }
    await expect(new MngKargoTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise<void>(resolve => init?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      init?.signal?.throwIfAborted(); return new Response('');
    });
    await expect(new MngKargoTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 })).rejects.toThrow();
    const huge = vi.fn<typeof fetch>().mockImplementation(async () => new Response('x'.repeat(600_000)));
    await expect(new MngKargoTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});
