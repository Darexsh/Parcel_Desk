import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DAO_ENDPOINT, DaoTracker, daoTrackingUrl } from './adapter.js';
import { normalizeDaoNumber, parseDao } from './parser.js';
import { daoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const HOME = '00057151279999999993';
const SHOP = '00057151279999999986';
const OTHER = '00057151279999999979';
const EARLIER = '00057126969999999997';
const FOREIGN = '00057999999999999992';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

interface Raw { tidspunkt?: unknown; haendelse?: unknown; beskrivelse?: unknown; pakketype?: unknown; sted?: unknown }
interface Row { raw?: Raw; [field: string]: unknown }
interface Parcel { barcode?: unknown; dist_barcode?: unknown; external_tracking?: unknown; events: Row[]; pickup?: unknown; [field: string]: unknown }
interface Reply { found: unknown; parcel: Parcel }
const edited = (name: string, change: (parcel: Parcel, payload: Reply) => void = () => {}): Reply => {
  const payload = JSON.parse(text(name)) as Reply;
  change(payload.parcel, payload);
  return payload;
};
const scan = (tidspunkt: string, haendelse: string, beskrivelse: string, pakketype = 'Home', sted = ''): Row =>
  ({ description: beskrivelse, raw: { tidspunkt, haendelse, beskrivelse, pakketype, sted } });
const rows = (result: ReturnType<typeof parseDao>) =>
  result.events!.map(event => [event.local_time, event.provider_code, event.stage ?? null, event.location ?? null, event.description]);

describe('DAO tracking adapter', () => {
  it('asks the tracking page’s service for the whole number once, in English, without a session, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('home')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DaoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 0005 7151 2799 9999 9993 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DAO_ENDPOINT}?barcode=${HOME}&lang=EN`);
    expect(daoTrackingUrl(`(00) ${HOME.slice(2)}`)).toBe(String(url));
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('user-agent')).toBe('SyntheticHost/1.0');
    expect(headers.has('cookie') || headers.has('x-wp-nonce') || headers.has('authorization')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dao', step: 'direct', outcome: 'ok' }));
  });

  it('reads a home delivery newest first, with its wall clocks, legs, event numbers and depots', () => {
    const result = parseDao(JSON.parse(text('home')), HOME);
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel delivered', last_update: null, last_update_local: '2026-03-12T06:41:20', expected_delivery: null }));
    for (const field of ['pickup_point', 'delivery_carrier', 'delivery_tracking_number', 'canonical_tracking_number', 'history_truncated']) {
      expect(result[field], field).toBeUndefined();
    }
    // A home delivery's scan carries its delivered text in the place field.
    expect(rows(result)).toEqual([
      ['2026-03-12T06:41:20', 'Home/11', 'delivered', null, 'Parcel delivered'],
      ['2026-03-12T01:12:05', 'Home/10', 'in_transit', 'dao Eksempelby', 'Parcel arrived at dao depot'],
      ['2026-03-11T21:30:44', 'Home/35', 'in_transit', null, 'On the way to the delivery terminal'],
      ['2026-03-11T19:02:10', 'Home/10', 'in_transit', 'dao Prøvested', 'Parcel arrived at dao depot'],
      ['2026-03-10T14:15:00', 'Home/1', 'registered', null, 'Shipment created, awaiting registration'],
    ]);
    // No offset is invented for the wall clocks.
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('follows a failed home delivery to the daoSHOP it waits at, named alone', () => {
    const result = parseDao(JSON.parse(text('shop')), SHOP);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'Eksempel Kiosk',
      last_status_text: 'Ready for pickup', last_update_local: '2026-03-13T09:05:12' });
    expect(rows(result)).toEqual([
      ['2026-03-13T09:05:12', 'Shop/32', 'ready_for_pickup', null, 'Ready for pickup'],
      ['2026-03-13T06:48:04', 'Shop/23', 'in_transit', null, 'On the way to daoSHOP'],
      ['2026-03-13T03:31:59', 'Shop/12', 'in_transit', null, 'Sorted at: Prøvested terminal'],
      ['2026-03-13T00:59:08', 'Shop/11', 'in_transit', null, 'Parcel has arrived at terminal'],
      ['2026-03-12T12:06:32', 'Home/64', 'failed_attempt', null, 'Delivery not possible. Redirected to daoSHOP'],
      ['2026-03-12T12:06:32', 'Home/61', 'failed_attempt', null, 'Not delivered - other reason'],
      ['2026-03-12T07:32:22', 'Home/31', 'out_for_delivery', null, 'To be delivered today'],
      ['2026-03-12T01:20:00', 'Home/10', 'in_transit', 'dao Eksempelby', 'Parcel arrived at dao depot'],
      ['2026-03-10T20:29:22', 'Home/1', 'registered', null, 'Shipment created, awaiting registration'],
    ]);
    const collected = parseDao(edited('shop', parcel => { parcel.events.unshift(scan('2026-03-14 15:02:41', '51', 'Parcel delivered', 'Shop')); }), SHOP);
    expect(collected).toMatchObject({ status: 'delivered', current_stage: 'delivered', pickup_point: 'Eksempel Kiosk' });
  });

  it('never reads the masked names, the postcode or the pickup point’s address, hours and coordinates', () => {
    const kept = JSON.stringify(parseDao(JSON.parse(text('shop')), SHOP));
    for (const dropped of ['Prøvevej', '0000', '9999', '08-20', '55.0000', '10.0000', '**', 'opening', 'latitude']) {
      expect(kept, dropped).not.toContain(dropped);
    }
  });

  it('sorts scans by clock, keeps scans of one second in the order of a reply listed oldest first and reads a repeated scan once', () => {
    const shuffled = parseDao(edited('shop', parcel => {
      parcel.events.reverse();
      parcel.events.push({ ...parcel.events[0]! });
    }), SHOP);
    expect(shuffled.events).toHaveLength(9);
    expect(shuffled.events![0]!.provider_code).toBe('Shop/32');
    // Reversed, the reply lists Home 64 after Home 61 at the same second: the later one.
    expect(shuffled.events!.slice(4, 6).map(event => event.provider_code)).toEqual(['Home/64', 'Home/61']);
  });

  it('keeps a new event visible without a stage', () => {
    const result = parseDao(edited('home', parcel => { parcel.events.unshift(scan('2026-03-12 08:00:00', '77', 'Synthetic event', 'Home', 'dao Eksempelby')); }), HOME);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic event', last_update_local: '2026-03-12T08:00:00' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ local_time: '2026-03-12T08:00:00', description: 'Synthetic event', location: 'dao Eksempelby', provider_code: 'Home/77' });
    const legless = parseDao(edited('home', parcel => { parcel.events.unshift(scan('2026-03-12 08:00:00', '11', 'Synthetic event', '')); }), HOME);
    expect(legless.events![0]).toEqual({ local_time: '2026-03-12T08:00:00', description: 'Synthetic event', provider_code: '11' });
  });

  it('hands a parcel sent abroad on to the partner its link names', () => {
    const bring = parseDao(edited('home', parcel => {
      parcel.dist_barcode = '7072 0999 9900 0000 1';
      parcel.external_tracking = 'https://tracking.bring.com/tracking/70720999990000001';
    }), HOME);
    expect(bring).toMatchObject({ delivery_carrier: 'bring-posten', delivery_tracking_number: '70720999990000001' });
    const unnamed = parseDao(edited('home', parcel => {
      parcel.dist_barcode = '70720999990000001';
      parcel.external_tracking = 'https://example.invalid/track';
    }), HOME);
    expect(unnamed).toMatchObject({ delivery_tracking_number: '70720999990000001' });
    expect(unnamed.delivery_carrier).toBeUndefined();
    for (const value of ['', 'n/a', HOME, '12']) {
      const none = parseDao(edited('home', parcel => { parcel.dist_barcode = value; }), HOME);
      expect(none.delivery_tracking_number, value).toBeUndefined();
    }
  });

  it('caps long histories', () => {
    const long = parseDao(edited('home', parcel => {
      parcel.events.push(...Array.from({ length: 210 }, (_, index) =>
        scan(`2026-03-0${1 + Math.floor(index / 60)} 0${Math.floor((index % 60) / 10)}:${String(index % 60).padStart(2, '0')}:00`, '10', 'Parcel arrived at dao depot', 'Home', `dao ${index}`)));
    }), HOME);
    expect(long.events).toHaveLength(200);
    expect(long).toMatchObject({ current_stage: 'delivered', history_truncated: true });
  });

  it('binds the reply to the whole requested number, and an alias to the parcel it names', () => {
    expect(() => parseDao(JSON.parse(text('home')), OTHER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const alias of ['712345678', '7999999999999']) {
      expect(parseDao(JSON.parse(text('home')), alias)).toMatchObject({ canonical_tracking_number: HOME, current_stage: 'delivered' });
    }
    expect(() => parseDao(edited('home', parcel => { parcel.barcode = 'ABC'; }), '712345678')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads found:false as a missing parcel and keeps everything else apart from one', () => {
    expect(() => parseDao(JSON.parse(text('not-found')), HOME)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDao(edited('home', parcel => { parcel.events = []; }), HOME)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    expect(() => parseDao(edited('home', parcel => { delete (parcel as { events?: unknown }).events; }), HOME)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    expect(() => parseDao({ found: true, parcel: null }, HOME)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const payload of [[], null, 'parcel', {}, { found: 'false' }, { found: 1 }]) {
      expect(() => parseDao(payload, HOME), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (parcel: Parcel) => { delete parcel.barcode; },
      (parcel: Parcel) => { (parcel as { events: unknown }).events = {}; },
      (parcel: Parcel) => { (parcel.events as unknown[])[0] = 'scan'; },
      (parcel: Parcel) => { delete parcel.events[0]!.raw; },
      (parcel: Parcel) => { parcel.events[0]!.raw!.tidspunkt = '2026-03-12T06:41:20+01:00'; },
      (parcel: Parcel) => { parcel.events[0]!.raw!.tidspunkt = '2026-02-30 06:41:20'; },
      (parcel: Parcel) => { parcel.events[0]!.raw!.tidspunkt = '2026-03-12 24:00:00'; },
      (parcel: Parcel) => { parcel.events[0]!.raw!.haendelse = 'X1'; },
      (parcel: Parcel) => { parcel.events[0]!.raw!.pakketype = 'Home/1'; },
      (parcel: Parcel) => { parcel.events[0]!.raw!.sted = ''; },
      (parcel: Parcel) => { parcel.events = Array.from({ length: 301 }, () => parcel.events[0]!); },
    ]) expect(() => parseDao(edited('home', change), HOME)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('recognizes a parcel with scans from plain HTTP, without ranking it by wall clocks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('home'))).mockResolvedValueOnce(reply(text('not-found')));
    await expect(carrier(fetcher).recognize!(HOME)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T06:41:20' });
    await expect(carrier(fetcher).recognize!(HOME)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const absent = vi.fn<typeof fetch>().mockResolvedValue(reply(text('not-found')));
    await expect(carrier(absent).track({ number: HOME })).rejects.toMatchObject({ kind: 'not_found' });
    // A record without scans is neither known nor unknown.
    const empty = vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify(edited('home', parcel => { parcel.events = []; }))));
    await expect(carrier(empty).recognize!(HOME)).rejects.toMatchObject({ name: 'NoHistoryError', kind: 'indeterminate' });
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: HOME })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(HOME)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a rejected request, block pages and malformed replies apart from missing parcels', async () => {
    const rejected = vi.fn<typeof fetch>().mockImplementation(async () => reply('{"code":"dao_missing_barcode","message":"Synthetic","data":{"status":400}}', 400));
    await expect(carrier(rejected).track({ number: HOME })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(rejected).recognize!(HOME)).rejects.toMatchObject({ kind: 'indeterminate' });
    for (const [body, kind] of [
      ['<html><head><title>Just a moment...</title></head></html>', 'challenge'],
      ['<html><head><title>403 Forbidden</title></head></html>', 'challenge'],
      ['<html><body>Vedligeholdelse</body></html>', 'schema'], ['{"parcel":{}}', 'schema'], ['', 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body, 200, 'text/html'));
      await expect(carrier(fetcher).recognize!(HOME), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: HOME })).rejects.toThrow('unexpectedly large');
  });

  it('takes SSCCs that pass the GS1 check, thirteen-digit numbers and e-label codes, and nothing else, without a request', async () => {
    expect(normalizeDaoNumber(`(00) ${HOME.slice(2)}`)).toEqual({ number: HOME, alias: false });
    expect(normalizeDaoNumber('7999 9999 99999')).toEqual({ number: '7999999999999', alias: true });
    expect(normalizeDaoNumber('712 345 678')).toEqual({ number: '712345678', alias: true });
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00057151279999999994', '0005715127999999999', '057151279999999993', '1999999999999', '71234567', 'ABC', `${HOME}/x`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    // An SSCC under another GS1 prefix is still DAO's to look up when filed under DAO.
    const any = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found')));
    await expect(carrier(any).track({ number: FOREIGN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(any).toHaveBeenCalledOnce();
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('home')));
    await expect(carrier(flaky).track({ number: HOME })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('home')));
    await expect(carrier(immediate).track({ number: HOME }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: HOME }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: HOME }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a parcel filed under DAO to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('home')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: HOME, carrier: 'dao' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'dao', source: 'dao', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${DAO_ENDPOINT}?`))).toBe(true);
  });

  it('suggests DAO for SSCCs under its GS1 prefixes and asks it first', () => {
    for (const number of [HOME, EARLIER]) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: expect.arrayContaining(['dao']) });
      expect(recognitionAskedCarriers(number)[0]).toBe('dao');
    }
    for (const number of [FOREIGN, '00057151279999999994', HOME.slice(2)]) expect(recognitionAskedCarriers(number), number).not.toContain('dao');
    expect(parseTrackingInput(`https://dao.as/find-din-pakke/#q=${HOME}`)).toMatchObject({ trackingNumber: HOME, carrier: 'dao', source: 'link' });
    expect(parseTrackingInput(`https://dao.as/?stregkode=${HOME}`)).toMatchObject({ trackingNumber: HOME, carrier: 'dao', source: 'link' });
  });
});

describe('DAO status vocabulary', () => {
  it('records every leg and event with the stage the map gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(daoStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'dao', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // The same event number means different things on each leg.
    expect(daoStage('Home/11')).toBe('delivered');
    expect(daoStage('Shop/11')).toBe('in_transit');
    for (const code of ['constructor', 'toString', '__proto__', '11', 'Home', 'home/11', '']) expect(statusMap.stage(code, ''), code).toBeUndefined();
    expect(statusMap.stage(null, 'parcel delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'dao', providerCode: 'Home/77', description: 'Synthetic event' })).toEqual({ kind: 'unknown' });
  });
});
