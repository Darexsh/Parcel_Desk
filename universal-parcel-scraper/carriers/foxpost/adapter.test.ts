import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { FoxpostTracker, adapter, foxpostTrackingUrl } from './adapter.js';
import { normalizeFoxpostNumber, parseFoxpost } from './parser.js';
import { foxpostScanStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'CLFOX100000000000001';
const OTHER = 'CLFOX100000000000002';
const html = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const absent = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');
const edit = (change: (document: ReturnType<typeof load>) => void, body = html) => { const $ = load(body); change($); return $.html(); };
const scan = ([time, title, description]: readonly [string, string, string]) => '<li class="parcel-status-items__list-item bg-white">'
  + `<span class="parcel-status-items__list-item-date">${time}</span><span class="parcel-status-items__list-item-text">`
  + `<span class="parcel-status-items__list-item-title">${title}</span><span class="parcel-status-items__list-item-description">${description}</span>`
  + `<!--span class="parcel-status-items__list-item-description">${description}</--span--></span></li>`;
const history = (...rows: (readonly [string, string, string])[]) => edit($ => $('ul.parcel-status-items__list').html(rows.map(scan).join('')));
const LINK = ' <a href="https://foxpost.hu/a-box-es-z-box-utmutato" target="_blank">Átvételi információért kattints ide!</a>';
const CREATE = 'Csomagod létrejött a rendszerünkben, a feladó még nem adta át azt a FOXPOST részére.';
const C2CIN = 'Csomagod fel lett adva, a csomagautomatában el lett helyezve. A neked címzett (feladott/visszaküldött) csomagot hamarosan kézbesítjük.';
const OPEROUT = 'Csomagodat futárunk kivette a csomagautomatából.';
const SORTIN = 'Csomagod beérkezett a FOXPOST raktárába. A feladott/visszaküldött csomag hamarosan kézbesítésre kerül.';
const SORTOUT = 'Csomag úton (kiszállítás/visszaszállítás alatt) van az általad választott csomagautomatához.';
const OPERIN = 'Csomagod megérkezett az általad választott (vissza)kézbesítési automatába, most már átveheted!';
const RECEIVE = 'Csomagod (vissza)kézbesítve lett, a címzett/feladó átvette.';
const reply = (body = html, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
// The page renders its clocks when viewed: in summer, and in winter.
const SUMMER = new Date('2026-06-05T08:00:00Z');
const WINTER = new Date('2026-12-05T08:00:00Z');
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('Foxpost direct tracking', () => {
  it("reads the scans on Budapest's clock, with the sender and the locker the parcel was collected from", () => {
    const result = normalizeCarrierResult(parseFoxpost(html, NUMBER, SUMMER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: RECEIVE,
      last_update: '2026-06-04T18:27:00+02:00', last_update_local: null, delivered_at: '2026-06-04T18:27:00+02:00', expected_delivery: null,
      sender_name: 'Minta Webáruház Kft.', pickup_point: 'FOXPOST A-BOX Minta Bevásárlóközpont' });
    expect(result.events?.map(event => [event.time, event.description, event.stage])).toEqual([
      ['2026-06-04T18:27:00+02:00', RECEIVE, 'delivered'],
      ['2026-06-03T10:05:00+02:00', OPERIN, 'ready_for_pickup'],
      ['2026-06-02T21:40:00+02:00', SORTIN, 'in_transit'],
      ['2026-06-01T08:03:00+02:00', CREATE, 'registered'],
    ]);
    expect(result.events?.every(event => event.local_time === undefined && event.location === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The order number, the payment details, the locker's page and the help link stay out.
    expect(JSON.stringify(result)).not.toMatch(/MINTA-REF|12 345|Bankkártyás|hu999|kattints|a-box-es-z-box/);
  });

  it('binds the reply to the number it shows', () => {
    expect(parseFoxpost(html, ` ${NUMBER.toLowerCase().replace('clfox', 'clfox ')} `).status).toBe('delivered');
    const packeta = edit($ => $('#parcel-number').text('Z1234567890'));
    expect(parseFoxpost(packeta, 'Z1234567890').status).toBe('delivered');
    for (const body of [edit($ => $('#parcel-number').text(OTHER)), edit($ => $('#parcel-number').remove()),
      edit($ => $('#parcel-number').clone().appendTo('.timeline-packet-info')), packeta]) {
      expect(() => parseFoxpost(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes CLFOX parcel IDs, Z numbers, ten-digit numbers starting 66 and home deliveries\' 66639 numbers, and nothing else', () => {
    expect(normalizeFoxpostNumber(' clfox 10000 00000 00001 ')).toBe(NUMBER);
    expect(normalizeFoxpostNumber('z1234567890')).toBe('Z1234567890');
    expect(normalizeFoxpostNumber('66 1234 5678')).toBe('6612345678');
    for (const number of ['6663900001', '6663900000001', '66639000000000000001']) expect(normalizeFoxpostNumber(number)).toBe(number);
    expect(foxpostTrackingUrl(' clfox100000000000001')).toBe(`https://foxpost.hu/csomagkovetes/?code=${NUMBER}`);
    for (const number of ['', 'CLFOX10000000000000', 'CLFOX1000000000000011', 'CLFAX100000000000001', 'Z123456789', 'Z12345678901',
      '661234567', '66123456789', '6712345678', 'ABCDEFGHIJ', '666390001', '666390000000000000001', '6663800000001']) {
      expect(() => normalizeFoxpostNumber(number), number).toThrow(InvalidInputError);
    }
  });

  it('reports a parcel absent only on its notice over an empty form', () => {
    expect(() => parseFoxpost(absent, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const body of [absent.replace('nem található', 'átmenetileg nem érhető el'), edit($ => $('.warning-box').clone().insertAfter('.warning-box'), absent),
      edit($ => $('main').append($('.warning-box', absent).clone())), edit($ => $('.warning-box').remove(), absent),
      edit($ => $('form').remove()), '<html lang="hu-HU"><body>Karbantartás</body></html>', '']) {
      expect(() => parseFoxpost(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseFoxpost(history(), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects another language and malformed scans, and bounds the history', () => {
    for (const body of [edit($ => $('html').attr('lang', 'en-US')), edit($ => $('html').removeAttr('lang')),
      history(['2026.02.30 10:00', 'Átvéve', RECEIVE]), history(['2026-06-04 18:27', 'Átvéve', RECEIVE]),
      history(['2026.06.04 18:27:00', 'Átvéve', RECEIVE]), history(['2026.06.04 18:27', '', '']),
      edit($ => $('ul.parcel-status-items__list').clone().appendTo('main')),
      edit($ => $('.timeline-packet-info dt').filter((_, node) => $(node).text() === 'Feladó').clone().appendTo('.timeline-packet-info')),
      history(...Array.from({ length: 201 }, (_, index) => [`2026.06.01 ${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
        'Úton', OPEROUT] as const))]) {
      expect(() => parseFoxpost(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const long = history(...Array.from({ length: 150 }, (_, index) => [`2026.06.01 ${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
      'Úton', OPEROUT] as const));
    const events = parseFoxpost(long, NUMBER, SUMMER).events!;
    expect(events).toHaveLength(100);
    expect(events[0]!.time).toBe('2026-06-01T02:29:00+02:00');
  });

  it('reads a scan in the season the page is viewed in, and a winter scan viewed in summer, from the page\'s clock', () => {
    // Live shapes: the page moves a scan's clock by Budapest's offset when viewed less its offset at
    // the scan. A CLFOX ID carries the second the parcel was created, which its first scan shows so.
    const clocks = (readAt: Date, ...times: string[]) => parseFoxpost(history(...times.map((time) => [time, 'Úton', SORTOUT] as const)), NUMBER, readAt)
      .events?.map(({ time, local_time }) => time ?? local_time);
    expect(clocks(WINTER, '2026.12.01 07:45')).toEqual(['2026-12-01T07:45:00+01:00']);
    expect(clocks(SUMMER, '2026.03.21 06:45', '2026.06.01 08:03')).toEqual(['2026-06-01T08:03:00+02:00', '2026-03-21T07:45:00+01:00']);
    // No page has shown a summer scan in winter, and one near a clock change may sit on either side of it.
    expect(clocks(WINTER, '2026.06.01 08:03')).toEqual(['2026-06-01T08:03:00']);
    expect(clocks(SUMMER, '2026.03.29 03:30', '2026.03.28 23:30')).toEqual(['2026-03-29T03:30:00', '2026-03-28T23:30:00']);
  });

  it('stages each scan by its sentence, not by the title it shares with others', () => {
    const c2c = parseFoxpost(history(['2026.07.03 09:00', 'Automatában', OPERIN + LINK], ['2026.07.02 22:00', 'Úton', SORTOUT],
      ['2026.07.02 21:00', 'Raktárban', SORTIN + LINK], ['2026.07.02 15:00', 'Úton', OPEROUT], ['2026.07.01 18:00', 'Automatában', C2CIN],
      ['2026.07.01 12:00', 'Csomagod elkészült', CREATE]), NUMBER);
    expect(c2c).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: OPERIN,
      pickup_point: 'FOXPOST A-BOX Minta Bevásárlóközpont' });
    expect(c2c.events?.map(event => event.stage)).toEqual(['ready_for_pickup', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted', 'registered']);
    const back = parseFoxpost(history(['2026.07.12 10:00', 'Átvéve', 'Visszaküldött csomagodat üzleti partnerünk átvette.'],
      ['2026.07.11 10:00', 'Raktárban', 'Visszaküldött csomagod előkészítettük átadásra.'],
      ['2026.07.10 10:00', 'Raktárban', 'Címzett által át nem vett / visszaküldött csomagod visszaszállításra került a FOXPOST raktárába.'],
      ['2026.07.09 10:00', 'Úton', 'Csomagod nem került átvételre a tárolási idő alatt, ezért a küldeményt visszaküldjük a feladónak.'],
      ['2026.07.03 09:00', 'Automatában', OPERIN]), NUMBER);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(back.events?.map(event => event.stage)).toEqual(['returned', 'returned', 'returned', 'returned', 'ready_for_pickup']);
    expect(back.pickup_point).toBeUndefined();
    const reasons = parseFoxpost(history(
      ['2026.07.06 10:00', 'Automatában', 'Csomagodat az automata telítettsége / műszaki hibája miatt személyesen veheted át munkatársunktól. 2026.07.07 16:00-18:00'],
      ['2026.07.05 10:00', 'Úton', 'Csomagodat az automata telítettsége / műszaki hibája miatt átírányítottuk egy másik csomagautomatába: FOXPOST Z-BOX Minta tér'],
      ['2026.07.04 10:00', 'Úton', 'Csomagod a házhozszállítás során nem lett átvéve, kézbesítése egyelőre sikertelen. Oka: címzett nem volt otthon']), NUMBER);
    expect(reasons.events?.map(event => event.stage)).toEqual(['ready_for_pickup', 'in_transit', 'failed_attempt']);
  });

  it('keeps new wording unstaged, and orders and dedupes the scans', () => {
    const unknown = parseFoxpost(history(['2026.07.03 09:00', 'Új', 'Csomagod teleportálva lett.'], ['2026.07.02 09:00', 'Automatában', OPERIN]), NUMBER, WINTER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Csomagod teleportálva lett.' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events?.[0]).toEqual({ local_time: '2026-07-03T09:00:00', description: 'Csomagod teleportálva lett.' });
    const titled = parseFoxpost(history(['2026.07.03 09:00', 'Raktárban', '']), NUMBER, WINTER);
    expect(titled.events).toEqual([{ local_time: '2026-07-03T09:00:00', description: 'Raktárban' }]);
    const shuffled = parseFoxpost(history(['2026.07.01 12:00', 'Csomagod elkészült', CREATE], ['2026.07.03 09:00', 'Automatában', OPERIN + LINK],
      ['2026.07.03 09:00', 'Automatában', OPERIN], ['2026.07.02 21:00', 'Raktárban', SORTIN], ['2026.07.02 21:00', 'Úton', SORTOUT]), NUMBER, WINTER);
    expect(shuffled.events?.map(event => event.description)).toEqual([OPERIN, SORTIN, SORTOUT, CREATE]);
    expect(shuffled.last_update_local).toBe('2026-07-03T09:00:00');
  });

  it('keeps scans of one minute in the order of a page listed oldest first', () => {
    const result = parseFoxpost(history(['2026.07.01 12:00', 'Csomagod elkészült', CREATE], ['2026.07.02 21:00', 'Raktárban', SORTIN],
      ['2026.07.02 21:00', 'Úton', SORTOUT], ['2026.07.03 09:00', 'Automatában', OPERIN]), NUMBER, WINTER);
    expect(result.events?.map(event => event.description)).toEqual([OPERIN, SORTOUT, SORTIN, CREATE]);
  });

  it('names the pickup point only while the parcel goes to it or was collected there', () => {
    const rows = [['2026.07.03 09:00', 'Úton', SORTOUT], ['2026.07.02 21:00', 'Raktárban', SORTIN]] as const;
    expect(parseFoxpost(history(...rows), NUMBER).pickup_point).toBe('FOXPOST A-BOX Minta Bevásárlóközpont');
    const unlinked = (change: (document: ReturnType<typeof load>) => void) => {
      const $ = load(history(...rows));
      change($);
      return parseFoxpost($.html(), NUMBER).pickup_point;
    };
    expect(unlinked($ => $('.tracking-packet-info__action a').remove())).toBeUndefined();
    expect(unlinked($ => $('.tracking-packet-info__action a').attr('href', 'https://other.test/~/hu999'))).toBeUndefined();
    // A home delivery names no point page.
    expect(unlinked($ => $('.tracking-packet-info__action a').attr('href', '/hazhozszallitas'))).toBeUndefined();
    const door = normalizeCarrierResult(parseFoxpost(history(['2026.07.04 09:00', 'Átvéve', 'Csomagod házhozszállítással kézbesítve lett, a címzett átvette.'],
      ['2026.07.03 09:00', 'Úton', 'Csomagod kiszállítás alatt van, a házhozszállítást végző partnerünk futára hamarosan kézbesíti.']), NUMBER));
    expect(door).toMatchObject({ status: 'delivered' });
    expect(door.pickup_point).toBeUndefined();
    const sender = parseFoxpost(edit($ => $('.timeline-packet-info dt').filter((_, node) => $(node).text() === 'Feladó').next('dd').text('')), NUMBER);
    expect(sender.sender_name).toBeUndefined();
  });

  it('maps every recorded wording, and the status map answers as the parser stages', () => {
    for (const entry of statuses.entries) {
      expect(foxpostScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'foxpost', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'foxpost', description: ` ${RECEIVE.toUpperCase()}  ` })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'foxpost', description: SORTIN.replace('FOXPOST', 'FoxPost') })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'foxpost', providerCode: 'RECEIVE', description: RECEIVE })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'foxpost', description: 'Átvéve' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', 'Automatában', `${RECEIVE} Mégsem.`]) expect(foxpostScanStage(wording), wording).toBeUndefined();
  });

  it('keeps detection and the tracking link on Foxpost', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'foxpost', confidence: 'high' });
    // Home deliveries' numbers start 66639; other carriers print ten digits too, so Foxpost leads at low confidence.
    for (const number of ['6663900001', '6663900000001', '66639000000000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['foxpost'] });
      expect(recognitionAskedCarriers(number)[0], number).toBe('foxpost');
    }
    for (const number of ['666390001', '666390000000000000001', '6663800001', '6612345678']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('foxpost');
    }
    expect(parseTrackingInput(`https://foxpost.hu/csomagkovetes/?code=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'foxpost', source: 'link' });
  });

  it('asks the tracking page once, with no session, and follows no redirect', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
      expect(String(url)).toBe(`https://foxpost.hu/csomagkovetes/?code=${NUMBER}`);
      expect(init).toMatchObject({ redirect: 'manual' });
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBeTruthy();
      expect(headers.get('accept-language')).toMatch(/^hu-HU/);
      expect(headers.has('cookie')).toBe(false);
      return reply();
    });
    const instance = adapter(environment(fetcher));
    expect(await instance.track({ number: ' clfox 100000000000001 ', postcode: 'PRIVATE_SYNTHETIC_POSTCODE' })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(instance.track({ number: 'CLFOX1' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('tells a Packeta number Foxpost does not know from a moved page', async () => {
    const moved = (location: string, status = 302) => vi.fn(async () => reply('', status, { Location: location })) as unknown as typeof fetch;
    await expect(new FoxpostTracker({ fetcher: moved('https://tracking.packeta.com/hu/Z1234567890') }).fetch('Z1234567890'))
      .rejects.toMatchObject({ kind: 'not_found', reason: 'packeta_number' });
    for (const [location, number] of [['https://tracking.packeta.com/hu/Z1234567891', 'Z1234567890'], ['https://tracking.packeta.com/hu/Z1234567890', NUMBER],
      ['https://foxpost.hu/', NUMBER], ['/csomagkovetes/', 'Z1234567890'], ['https://tracking.packeta.com.example/hu/Z1234567890', 'Z1234567890']] as const) {
      await expect(new FoxpostTracker({ fetcher: moved(location) }).fetch(number), location).rejects.toMatchObject({ kind: 'indeterminate' });
    }
  });

  it('keeps the HTTP failure taxonomy, retries a failed connection once and bounds bodies', async () => {
    for (const [status, kind] of [[404, 'indeterminate'], [410, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      const fetcher = vi.fn(async () => reply(absent, status)) as unknown as typeof fetch;
      await expect(new FoxpostTracker({ fetcher }).fetch(NUMBER), String(status)).rejects.toMatchObject({ kind });
    }
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply());
    expect(await new FoxpostTracker({ fetcher: flaky as unknown as typeof fetch }).fetch(NUMBER)).toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const absentOnce = vi.fn(async () => reply(absent));
    await expect(new FoxpostTracker({ fetcher: absentOnce as unknown as typeof fetch }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(absentOnce).toHaveBeenCalledTimes(1);
    const large = vi.fn(async () => new Response(new Uint8Array(600_000))) as unknown as typeof fetch;
    await expect(new FoxpostTracker({ fetcher: large }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });

  it('recognizes a known parcel and treats only the absent answer as unknown', async () => {
    const known = vi.fn<typeof fetch>(async () => reply());
    const instance = adapter(environment(known));
    expect(await instance.recognize!('CLFOX1')).toEqual({ known: false });
    expect(known).not.toHaveBeenCalled();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(SUMMER);
      expect(await instance.recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: '2026-06-04T16:27:00.000Z' });
      // A summer scan viewed in winter keeps its wall clock, which dates the last activity without an instant.
      vi.setSystemTime(WINTER);
      expect(await instance.recognize!(NUMBER)).toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-06-04T18:27:00' });
    } finally {
      vi.useRealTimers();
    }
    const unknown = vi.fn(async () => reply(absent));
    expect(await adapter(environment(unknown as unknown as typeof fetch)).recognize!(NUMBER)).toEqual({ known: false });
    const outage = vi.fn(async () => reply('<html>Karbantartás</html>'));
    await expect(adapter(environment(outage as unknown as typeof fetch)).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = vi.fn(async () => reply()) as unknown as typeof fetch;
    await expect(new FoxpostTracker({ fetcher: immediate }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    await expect(new FoxpostTracker({ fetcher: immediate }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    // A request that hangs ends with the budget, retried at most once.
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new FoxpostTracker({ fetcher: slow }).fetch(NUMBER, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
