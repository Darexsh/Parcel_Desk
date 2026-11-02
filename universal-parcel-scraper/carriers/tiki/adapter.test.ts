import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TIKI_API, TIKI_APP_KEY, TikiTracker, tikiToken } from './adapter.js';
import { parseTiki, tikiWording } from './parser.js';
import { statusMap, tikiCodeStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '990000000011';
const TRAVELLING = '990000000022';
const PIECES = '990000000033';
const UNKNOWN = '990000000044';
type Row = Record<string, unknown>;
type Piece = Row & { history: Row[] };
type Reply = Record<string, unknown> & { response: Piece[] };
const source = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const answer = (name: string, change: (rows: Row[], value: Reply) => void = () => {}) => {
  const value = JSON.parse(source(`${name}.json`)) as Reply;
  change(value.response[0]!.history, value);
  return value;
};
const json = (name: string, change?: (rows: Row[], value: Reply) => void) => JSON.stringify(answer(name, change));
const reply = (body: string | null, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseTiki>) =>
  result.events!.map(event => [event.local_time, event.provider_code, event.stage ?? null, event.location ?? null]);
const decoded = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;

describe('TIKI tracking adapter', () => {
  it('asks the app’s service about the whole resi once, with a token signed by the app’s key, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(json('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const now = 1_780_000_000_500;
    await expect(new TikiTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => now })
      .fetch(' 9900-0000-0011 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TIKI_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json',
      'Content-Type': 'application/json', Authorization: tikiToken(now), 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init?.body))).toEqual({ cnno: DELIVERED });
    // An HS256 JWT without a scheme, issued fifty seconds back and valid for a hundred.
    const [header, claims, signature] = tikiToken(now).split('.');
    expect(decoded(header!)).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(decoded(claims!)).toEqual({ iat: 1_779_999_950, exp: 1_780_000_050, sub: 'tiki' });
    expect(signature).toBe(createHmac('sha256', TIKI_APP_KEY).update(`${header}.${claims}`).digest('base64url'));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tiki', step: 'direct', outcome: 'ok' }));
  });

  it('makes a new token from the host’s clock for every request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(json('delivered')));
    const before = Math.floor(Date.now() / 1000);
    await carrier(fetcher).track({ number: DELIVERED });
    const after = Math.floor(Date.now() / 1000);
    const token = String((fetcher.mock.calls[0]![1]!.headers as Record<string, string>).Authorization);
    const { iat, exp } = decoded(token.split('.')[1]!) as { iat: number; exp: number };
    expect(iat).toBeGreaterThanOrEqual(before - 50);
    expect(iat).toBeLessThanOrEqual(after - 50);
    expect(exp - iat).toBe(100);
  });

  it('reads a delivered resi newest first, on its offices’ wall clocks, without the receiver, phone numbers or fees', () => {
    const result = parseTiki(answer('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Success / [M] RECEIVED BY', last_update: null, last_update_local: '2026-07-04T14:20:05',
      expected_delivery: null, service_name: 'REG', weight_kg: 2 });
    expect(result.history_truncated).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-07-04T14:20:05', 'POD 01', 'delivered', 'BANDUNG'],
      ['2026-07-04T08:31:44', 'DEL 01', 'out_for_delivery', 'BANDUNG'],
      ['2026-07-03T15:02:10', 'DEX 03', 'failed_attempt', 'BANDUNG'],
      ['2026-07-03T08:15:29', 'DEL 01', 'out_for_delivery', 'BANDUNG'],
      ['2026-07-03T05:47:51', 'INC 01', 'in_transit', 'BANDUNG'],
      ['2026-07-02T00:37:39', 'ROS', 'in_transit', 'JAKARTA'],
      ['2026-07-01T22:59:18', 'CON 01', 'in_transit', 'JAKARTA'],
      ['2026-07-01T10:12:40', 'MDE 01', 'accepted', 'JAKARTA TIMUR'],
    ]);
    expect(result.events!.map(event => event.description)).toEqual([
      'Success / [M] RECEIVED BY',
      'With Delivery Courier',
      'Failed : DEX 03 - [M] ALAMAT TIDAK LENGKAP',
      'With Delivery Courier',
      'Arrived at TIKI BANDUNG',
      'Departed [M] BY ODCGK01BBDO01A26070001 TO BANDUNG',
      'Departed to BANDUNG',
      'Shipment Data Entry at JAKARTA TIMUR',
    ]);
    expect(result.events!.every(event => !('time' in event))).toBe(true);
    const kept = JSON.stringify(result);
    for (const dropped of ['ANI', 'CONTOH', 'YBS', '0812', '3456', 'TOKO', 'DKI', 'Jawa', '18000', '1500', 'CGK01.00', 'BDO01.00']) {
      expect(kept, dropped).not.toContain(dropped);
    }
  });

  it('reads a resi on its way, with its estimate, and scans that name no town of their own', () => {
    const result = parseTiki(answer('in-transit'), TRAVELLING);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Transit at MAKASSAR',
      last_update_local: '2026-06-22T09:14:32', expected_delivery: '2026-06-25', service_name: 'ECO', weight_kg: 1 });
    expect(rows(result)).toEqual([
      ['2026-06-22T09:14:32', 'TRS', 'in_transit', 'MAKASSAR'],
      ['2026-06-21T23:38:01', 'CON 01', 'in_transit', 'SURABAYA'],
      ['2026-06-21T18:10:35', 'MDE 12', 'in_transit', 'SURABAYA'],
      ['2026-06-20T16:50:54', 'MDE 02', 'accepted', 'AGEN CONTOH'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/REF-CONTOH|BUDI|SITI|41000|Sulawesi|Jawa|SUB01|UPG01/);
    const nowhere = parseTiki(answer('in-transit', events => { events[0]!.entry_place = null; events[0]!.entry_name = ''; }), TRAVELLING);
    expect(nowhere.events![0]).toEqual({ local_time: '2026-06-22T09:14:32', description: 'Transit at MAKASSAR', provider_code: 'TRS',
      stage: 'in_transit', stage_source: 'carrier_map' });
    for (const weight of [0, -5, '1', null, 200_000]) {
      expect(parseTiki(answer('in-transit', (_, value) => { value.response[0]!.weight = weight; }), TRAVELLING).weight_kg, String(weight))
        .toBeUndefined();
    }
    for (const date of ['', '2026-02-30', '25-06-2026', '2026-06-25 00:00:00', null]) {
      expect(parseTiki(answer('in-transit', (_, value) => { value.response[0]!.est_date = date; }), TRAVELLING).expected_delivery, String(date))
        .toBeNull();
    }
    for (const [product, kept] of [['reg', 'REG'], ['', undefined], ['REGULAR SERVICE', undefined], [null, undefined]] as const) {
      expect(parseTiki(answer('in-transit', (_, value) => { value.response[0]!.product = product; }), TRAVELLING).service_name, String(product))
        .toBe(kept);
    }
  });

  it('merges the pieces of a consignment, and settles it only when every piece is', () => {
    const result = parseTiki(answer('pieces'), PIECES);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrived at TIKI MANADO',
      last_update_local: '2026-05-16T18:23:10', expected_delivery: '2026-05-15', service_name: 'REG', weight_kg: 24 });
    // The data entry both pieces share is kept once.
    expect(rows(result)).toEqual([
      ['2026-05-16T18:23:10', 'POD 01', 'delivered', 'MANADO'],
      ['2026-05-16T09:15:02', 'DEL 01', 'out_for_delivery', 'MANADO'],
      ['2026-05-15T13:46:30', 'INC 01', 'in_transit', 'MANADO'],
      ['2026-05-14T06:07:44', 'INC 01', 'in_transit', 'MANADO'],
      ['2026-05-12T00:08:51', 'CON 01', 'in_transit', 'JAKARTA'],
      ['2026-05-11T23:37:12', 'CON 01', 'in_transit', 'JAKARTA'],
      ['2026-05-11T15:52:29', 'MDE 04', 'accepted', 'JAKARTA PUSAT'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/JOKO|CV CONTOH|912000/);
    const done = parseTiki(answer('pieces', (_, value) => {
      value.response[1]!.history.unshift({ ...value.response[0]!.history[0]!, seq_no: 2, entry_date: '2026-05-17 10:00:00' });
    }), PIECES);
    expect(done).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Success / RECEIVED BY',
      last_update_local: '2026-05-17T10:00:00', expected_delivery: null });
    expect(parseTiki(answer('pieces', (_, value) => { value.response[1]!.weight = 12; }), PIECES).weight_kg).toBeUndefined();
    expect(parseTiki(answer('pieces', (_, value) => { value.response[1]!.cnno = '9900 0000 0033'; }), PIECES).events).toHaveLength(7);
  });

  it('drops who took the parcel after a delivery or return, and phone numbers, and keeps the rest', () => {
    for (const [wording, code, kept] of [
      ['Success / [M] RECEIVED BY : ANI CONTOH (YBS) 0812-3456-7890', 'POD 01', 'Success / [M] RECEIVED BY'],
      ['Success / (M) RECEIVED BY:BUDI', 'POD 01', 'Success / (M) RECEIVED BY'],
      ['Success / [M] KIRIMAN DIKEMBALIKAN KEPADA PENGIRIM : TOKO CONTOH', 'POD 04', 'Success / [M] KIRIMAN DIKEMBALIKAN KEPADA PENGIRIM'],
      ['Success / SUCCEED RETURN TO KITING : BY RTCGK0199', 'POD 04', 'Success / SUCCEED RETURN TO KITING'],
      ['Failed : DEX 03 - [M] ALAMAT TIDAK LENGKAP', 'DEX 03', 'Failed : DEX 03 - [M] ALAMAT TIDAK LENGKAP'],
      ['Paket diterima oleh satpam kantor', 'XYZ 01', 'Paket diterima oleh'],
      ['Hubungi kurir 0812 3456 7890 atau +62 812-3456-7890', 'DEL 01', 'Hubungi kurir atau'],
      ['Departed [M] BY ODCGK01BBDO01A26070001 TO BDO01', 'ROS', 'Departed [M] BY ODCGK01BBDO01A26070001 TO BDO01'],
    ] as const) expect(tikiWording(wording, code), wording).toBe(kept);
    expect(tikiWording('Departed to MANADO')).toBe('Departed to MANADO');
  });

  it('orders scans by clock, keeps the reply’s order within a second, drops repeated scans and caps long histories', () => {
    const reversed = parseTiki(answer('delivered', events => { events.reverse(); }), DELIVERED);
    expect(rows(reversed)).toEqual(rows(parseTiki(answer('delivered'), DELIVERED)));
    const twice = parseTiki(answer('delivered', events => { events.push({ ...events.at(-1)! }); }), DELIVERED);
    expect(twice.events).toHaveLength(8);
    const tied = parseTiki(answer('delivered', events => { events[1]!.entry_date = events[0]!.entry_date; }), DELIVERED);
    expect(tied).toMatchObject({ current_stage: 'delivered' });
    const swapped = parseTiki(answer('delivered', events => {
      events[1]!.entry_date = events[0]!.entry_date;
      events.unshift(events.splice(1, 1)[0]!);
    }), DELIVERED);
    expect(swapped).toMatchObject({ current_stage: 'out_for_delivery' });
    const long = parseTiki(answer('delivered', events => {
      events.push(...Array.from({ length: 120 }, (_, index) => ({ ...events[4]!,
        entry_date: `2026-06-${String(1 + Math.floor(index / 24)).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00:00` })));
    }), DELIVERED);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ current_stage: 'delivered', history_truncated: true });
  });

  it('keeps scans of one second in the reply’s order, reversed when it lists them oldest first', () => {
    for (const reverse of [false, true]) {
      const result = parseTiki(answer('delivered', events => {
        events[1]!.entry_date = events[0]!.entry_date;
        if (reverse) events.reverse();
      }), DELIVERED);
      expect(result.events!.slice(0, 3).map(event => event.provider_code), String(reverse)).toEqual(['POD 01', 'DEL 01', 'DEX 03']);
    }
  });

  it('keeps new codes visible and stages them by their wording when it can', () => {
    const result = parseTiki(answer('delivered', events => {
      events.unshift({ ...events[0]!, entry_date: '2026-07-05 09:00:00', status: 'XYZ 01', noted: 'Sesuatu yang baru' });
    }), DELIVERED);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Sesuatu yang baru' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ local_time: '2026-07-05T09:00:00', location: 'BANDUNG', description: 'Sesuatu yang baru',
      provider_code: 'XYZ 01' });
    const worded = parseTiki(answer('delivered', events => {
      events.unshift({ ...events[0]!, entry_date: '2026-07-05 09:00:00', status: 'dex 99', noted: 'Failed : DEX 99 - ALASAN BARU' });
    }), DELIVERED);
    expect(worded.events![0]).toMatchObject({ provider_code: 'DEX 99', stage: 'failed_attempt', stage_source: expect.stringMatching(/^wording:/) });
    const unworded = parseTiki(answer('delivered', events => { events[0]!.noted = ''; }), DELIVERED);
    expect(unworded).toMatchObject({ current_stage: 'delivered', last_status_text: 'POD 01' });
  });

  it('reads an empty list as a missing resi, and a consignment without scans apart from it', async () => {
    expect(() => parseTiki(JSON.parse(source('not-found.json')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(json('delivered'))).mockResolvedValueOnce(reply(source('not-found.json')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-07-04T14:20:05' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const missing = vi.fn<typeof fetch>().mockResolvedValue(reply(source('not-found.json')));
    await expect(carrier(missing).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    for (const empty of [[], null]) {
      expect(() => parseTiki(answer('pieces', (_, value) => { for (const piece of value.response) (piece as Row).history = empty; }), PIECES),
        JSON.stringify(empty)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('binds every piece to the whole requested number', () => {
    for (const change of [
      (_: Row[], value: Reply) => { value.response[0]!.cnno = UNKNOWN; },
      (_: Row[], value: Reply) => { value.response[1]!.cnno = '990000000034'; },
      (_: Row[], value: Reply) => { value.response[1]!.cnno = `${PIECES}1`; },
    ]) expect(() => parseTiki(answer('pieces', change), PIECES)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTiki(answer('delivered'), `${DELIVERED}1`)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('rejects malformed replies, pieces and scans', () => {
    for (const change of [
      (events: Row[]) => { events[0]!.status = ''; },
      (events: Row[]) => { events[0]!.status = 'not a code'; },
      (events: Row[]) => { events[0]!.status = 7; },
      (events: Row[]) => { events[0]!.entry_date = '04-07-2026 14:20:05'; },
      (events: Row[]) => { events[0]!.entry_date = '2026-02-30 14:20:05'; },
      (events: Row[]) => { events[0]!.entry_date = '2026-07-04 24:00:00'; },
      (events: Row[]) => { events[0]!.entry_date = null; },
      (events: Row[]) => { events[0]!.noted = 5; },
      (events: Row[]) => { events[0]!.entry_place = ['BANDUNG']; },
      (events: Row[]) => { (events as unknown[])[0] = 'scan'; },
      (_: Row[], value: Reply) => { (value.response[0] as Row).history = 'scans'; },
      (_: Row[], value: Reply) => { value.response[0]!.history = Array.from({ length: 501 }, () => value.response[0]!.history[0]!); },
      (_: Row[], value: Reply) => { delete value.response[0]!.cnno; },
      (_: Row[], value: Reply) => { value.response[0]!.cnno = 990000000011; },
      (_: Row[], value: Reply) => { value.response[0]!.seq_no = -1; },
      (_: Row[], value: Reply) => { value.response[0]!.seq_no = '0'; },
      (_: Row[], value: Reply) => { value.response[0]!.product = 5; },
      (_: Row[], value: Reply) => { (value.response as unknown[])[0] = 'piece'; },
      (_: Row[], value: Reply) => { value.response = Array.from({ length: 201 }, () => value.response[0]!); },
      (_: Row[], value: Reply) => { (value as Row).response = {}; },
      (_: Row[], value: Reply) => { (value as Row).response = null; },
      (_: Row[], value: Reply) => { value.status = '200'; },
    ]) expect(() => parseTiki(answer('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [[], null, 'resi', {}, { response: [] }]) {
      expect(() => parseTiki(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it.each([[401, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(`{"status":${status},"msg":"","response":null}`, status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps refused tokens, block pages, notices and malformed replies apart from missing resi numbers', async () => {
    for (const [body, status, kind] of [
      [source('token-refused.json'), 403, 'challenge'],
      ['{"status":403,"msg":"Invalid token","response":null}', 200, 'challenge'],
      ['<!DOCTYPE html><html><title>Just a moment...</title></html>', 200, 'challenge'],
      ['<html><body>Forbidden</body></html>', 403, 'challenge'],
      ['{"status":429,"msg":"Too many requests","response":null}', 200, 'rate_limited'],
      ['{"status":400,"msg":"Invalid cnno","response":null}', 400, 'indeterminate'],
      ['{"status":500,"msg":"","response":null}', 200, 'indeterminate'],
      ['Bad request', 400, 'schema'],
      ['Service unavailable', 200, 'schema'],
      ['{"data":[]}', 200, 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body, status));
      await expect(carrier(fetcher).recognize!(DELIVERED), body).rejects.toMatchObject({ kind });
    }
    const moved = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://tiki.id/' } }));
    await expect(carrier(moved).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('takes twelve digits and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['99000000001', '9900000000111', `${PIECES}-1`, '99000000001A', 'ABC', '', '9'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async () => reply(source('not-found.json')));
    await expect(carrier(any).track({ number: ' 9900 0000 0044 ' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(any.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ cnno: UNKNOWN }]);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(json('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(json('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a resi filed under TIKI to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(json('in-transit')));
    const tracked = await createTracker({ fetcher, providers: [], env: {} }).track({ number: TRAVELLING, carrier: 'tiki' }, { budgetMs: 3000 });
    expect(tracked).toMatchObject({ carrier: 'tiki', source: 'tiki', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === TIKI_API)).toBe(true);
  });

  it('is not asked about twelve digits, which no rule gives it, and reads its links', () => {
    expect(detectCarrierMatch(TRAVELLING).candidates).not.toContain('tiki');
    expect(recognitionAskedCarriers(TRAVELLING)).not.toContain('tiki');
    for (const link of [`https://tiki.id/id/track/${TRAVELLING}`, `https://www.tiki.id/id/track/${TRAVELLING}/`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: TRAVELLING, carrier: 'tiki', source: 'link' });
    }
  });
});

describe('TIKI status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    expect(statuses.entries.length).toBeGreaterThan(0);
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(tikiCodeStage(entry.code), entry.code).toBe(entry.stage);
    }
    // The map reads codes alone.
    expect(statusMap.stage(null, 'with delivery courier')).toBeUndefined();
    for (const code of ['constructor', 'toString', '__proto__', 'POD', 'DEX 99']) expect(statusMap.stage(code, ''), code).toBeUndefined();
    expect(statusMap.stage('pod 01', '')).toBe('delivered');
    expect(statusMapAnswer({ carrier: 'tiki', providerCode: 'DEL 01', description: 'With Delivery Courier' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
