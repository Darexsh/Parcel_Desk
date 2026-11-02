import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, POSTA_SHQIPTARE_API, PostaShqiptareTracker } from './adapter.js';
import { parsePostaShqiptare } from './parser.js';
import { postaShqiptareScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const KNOWN = 'ZZ000000014AL';
const OTHER = 'ZZ000000028AL';
const INBOUND = 'ZZ000000014DE';
const UNKNOWN = 'ZZ000000005AL';

type Row = Record<string, unknown>;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Row[];
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parsePostaShqiptare>) =>
  result.events!.map(event => [event.time ?? event.local_time, event.description, event.location ?? null, event.stage ?? null]);
const scan = (row: Row) => [{ eventId: 0, date: '2026-07-08T11:02:00', description: 'Pranim objekti nga klienti / Receive item from customer ',
  destination: null, office: 'Zyra Postare Qytet 7, QYTET', ...row }];
/** The tracker: the item's scans under its own address, an empty list under any other. */
const tracker = (history: unknown = fixture('delivered')) => vi.fn<typeof fetch>(async (input) =>
  reply(String(input) === `${POSTA_SHQIPTARE_API}/${KNOWN}` ? history : []));

describe('Posta Shqiptare HTTP adapter', () => {
  it('asks the e-Posta lookup once for the whole number, through the supplied transport', async () => {
    const fetcher = tracker();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostaShqiptareTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 al ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://eposta.postashqiptare.al:8443/api/mailItemEvents/getTrackApi/${KNOWN}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'posta-shqiptare', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates its own scans on Tirana’s clock and keeps a foreign post’s relayed clocks local', () => {
    const result = parsePostaShqiptare(fixture('delivered'), KNOWN);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Objekti u dorezua', last_update: null, last_update_local: '2026-07-14T16:05:00', expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-07-14T16:05:00', 'Objekti u dorezua', 'Austria', 'delivered'],
      ['2026-07-14T09:40:00', 'Objekti u pranua ne zyren e shperndarjes', 'Austria', 'in_transit'],
      ['2026-07-13T02:10:00', 'Objekti u dergua ne zyren destinacion', 'Austria', 'in_transit'],
      ['2026-07-11T15:22:00', 'Regjistrimi i informacionit doganor te objektit', 'Austria', 'customs'],
      ['2026-07-11T15:20:00', 'Objekti u pranua ne zyren e shkembimit', 'Austria', 'in_transit'],
      ['2026-07-08T18:45:00+02:00', 'Objekti u nxor nga thesi per perpunim / Receive item at location (Inb)', 'Qendra Shembull (nisje), QYTET', 'in_transit'],
      ['2026-07-08T11:02:00+02:00', 'Pranim objekti nga klienti / Receive item from customer', 'Zyra Postare Qytet 7, QYTET', 'accepted'],
    ]);
    expect(result.events!.every(event => (event.time === undefined) !== (event.local_time === undefined))).toBe(true);
  });

  it('reads winter clocks, a failed delivery abroad and a repeated relayed scan once', () => {
    const result = parsePostaShqiptare(fixture('in-transit'), KNOWN);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_update_local: '2026-02-03T10:12:00' });
    expect(rows(result)).toEqual([
      ['2026-02-03T10:12:00', 'Tentative e pasuksesshme ne shperndarjen e objektit', 'Serbia', 'failed_attempt'],
      ['2026-02-03T08:30:00', 'Objekti u pranua ne zyren e shperndarjes', 'Serbia', 'in_transit'],
      ['2026-02-02T13:31:00', 'Objekti u dergua ne zyren destinacion', 'Serbia', 'in_transit'],
      ['2026-01-30T19:10:00+01:00', 'Objekti u nxor nga thesi per perpunim / Receive item at location (Inb)', 'ZP Shembull, QYTET', 'in_transit'],
      ['2026-01-30T14:59:00+01:00', 'Pranim objekti nga klienti / Receive item from customer', 'Zyra Postare Qytet 3, QYTET', 'accepted'],
    ]);
  });

  it('keeps a courier’s scans local, without the recipient a delivery names or a postcode', () => {
    const result = parsePostaShqiptare(fixture('courier'), KNOWN);
    expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Dorëzuar', last_update: null });
    expect(rows(result)).toEqual([
      ['2026-05-12T11:17:00', 'Dorëzuar', 'SHEMBULL-GRC', 'delivered'],
      ['2026-05-12T10:09:00', 'Marrë nga korrieri', 'SHEMBULL,AB-GRC', 'in_transit'],
      ['2026-05-12T08:28:00', 'Mbërritur në qendrën e shpërndarjes', null, 'in_transit'],
      ['2026-05-09T09:38:00', 'Mbajtur ne dogane', 'QYTET-GRC', 'customs'],
      ['2026-05-08T16:47:00', 'Nisur nga origjina', 'QYTET-ALB', 'in_transit'],
      ['2026-05-07T19:29:00+02:00', 'Objekti u nxor nga thesi per perpunim / Receive item at location (Inb)', 'ZP EMS, QYTET', 'in_transit'],
      ['2026-05-07T14:47:00+02:00', 'Pranim objekti nga klienti / Receive item from customer', 'Zyra Postare Qytet 3, QYTET', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Emër|Mbiemër|12345/);
  });

  it('keeps a wall clock Tirana skips or repeats local, and reads a clock with a fraction of a second', () => {
    const clock = (date: string) => parsePostaShqiptare(scan({ date }), KNOWN).events![0]!;
    expect(clock('2026-10-25T02:30:00')).toEqual(expect.objectContaining({ local_time: '2026-10-25T02:30:00' }));
    expect(clock('2026-03-29T02:30:00')).toEqual(expect.objectContaining({ local_time: '2026-03-29T02:30:00' }));
    expect(clock('2026-10-25T03:30:00.123')).toEqual(expect.objectContaining({ time: '2026-10-25T03:30:00+01:00' }));
  });

  it('turns an oldest-first reply round', () => {
    expect(rows(parsePostaShqiptare(fixture('delivered').reverse(), KNOWN))[0]).toEqual(
      ['2026-07-14T16:05:00', 'Objekti u dorezua', 'Austria', 'delivered']);
  });

  it('leaves wording the map does not know to the shared rules, and without a stage when they do not know it either', () => {
    const result = parsePostaShqiptare(scan({ description: 'Ngjarje e panjohur / ', office: 'Austri' }), KNOWN);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Ngjarje e panjohur', last_update_local: '2026-07-08T11:02:00' });
    expect(result.events![0]).not.toHaveProperty('stage');
  });

  it('reads the empty list and the page’s missing-item notices as not found', async () => {
    expect(() => parsePostaShqiptare([], KNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePostaShqiptare('Pakoja nuk ekziston', KNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(tracker()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    for (const status of [400, 404]) {
      await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('"package_not_found"', { status }))).track({ number: KNOWN }))
        .rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it('binds the answer to the whole number through the address it asks', async () => {
    const fetcher = tracker();
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${POSTA_SHQIPTARE_API}/${OTHER}`);
    await expect(carrier(fetcher).recognize!(OTHER)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(KNOWN)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-07-08T16:45:00.000Z' });
  });

  it('takes S10 codes from any post and rejects anything else without a request', async () => {
    const fetcher = tracker();
    await expect(carrier(fetcher).track({ number: INBOUND })).rejects.toMatchObject({ kind: 'not_found' });
    for (const number of ['ZZ000000015AL', 'ZZ00000001AL', '123456789012', `${KNOWN}${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads a bot check as a challenge and a changed reply as a schema failure', async () => {
    const lookup = (body: string, init: ResponseInit = {}) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: KNOWN });
    await expect(lookup('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Changed</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    for (const body of [{ events: [] }, 'internal_error', [null], scan({ date: '2026-07-08' }), scan({ date: '2026-02-30T10:00:00' }),
      scan({ date: '2026-07-08T11:02:00+02:00' }), scan({ description: ' / ' }), scan({ description: ['Pranim'] }), scan({ office: { name: 'Qytet' } }),
      Array.from({ length: 501 }, () => scan({})[0])]) {
      await expect(lookup(JSON.stringify(body)), JSON.stringify(body).slice(0, 80)).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it.each([[429, 'rate_limited'], [403, 'challenge'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s without another request', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('"internal_error"', { status }));
      await expect(carrier(fetcher).track({ number: KNOWN })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('reads a moved route or a redirect as a transport failure, never as a missing item', async () => {
    for (const response of [new Response('Not Found', { status: 404 }), new Response('', { status: 302, headers: { Location: '/' } })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(carrier(fetcher).track({ number: KNOWN })).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it('tries once more when the first request fails to reach the tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: KNOWN }, { budgetMs: 2000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('serves the tracker’s answer through createTracker', async () => {
    const fetcher = tracker();
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: KNOWN, carrier: 'posta-shqiptare' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'posta-shqiptare', source: 'posta-shqiptare', result: { current_stage: 'delivered' } });
  });

  it('is named for its own Albanian S10 codes and asked about the others', () => {
    for (const number of ['CP123456785AL', 'EE123456785AL', 'LG123456785AL', 'RR123456785AL']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'posta-shqiptare', confidence: 'high', candidates: ['posta-shqiptare'] });
      expect(recognitionAskedCarriers(number), number).toEqual([]);
    }
    expect(detectCarrierMatch('CP123456784AL').candidates).not.toContain('posta-shqiptare');
    expect(detectCarrierMatch(KNOWN)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(KNOWN)[0]).toBe('posta-shqiptare');
    expect(recognitionAskedCarriers('ZZ000000015AL')).not.toContain('posta-shqiptare');
    expect(recognitionAskedCarriers(INBOUND)).not.toContain('posta-shqiptare');
  });
});

describe('Posta Shqiptare status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(postaShqiptareScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(postaShqiptareScanStage('  Objekti  u dorëzua / Deliver item ')).toBe('delivered');
    expect(postaShqiptareScanStage('Mberritur ne qendren e shperndarjes')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'Objekti', 'Receive item from customer']) {
      expect(postaShqiptareScanStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('X', 'objekti u dorezua')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'posta-shqiptare', description: 'Tentative e pasuksesshme ne shperndarjen e objektit' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
  });
});
