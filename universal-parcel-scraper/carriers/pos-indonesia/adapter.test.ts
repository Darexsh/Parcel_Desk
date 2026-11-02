import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, POS_INDONESIA_ENDPOINT, PosIndonesiaTracker } from './adapter.js';
import { parsePosIndonesia, posIndonesiaPayload, posIndonesiaWording } from './parser.js';
import { posIndonesiaCodeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DOMESTIC = 'P2607019990001';
const ABROAD = 'RR900000019ID';
const INBOUND = 'LP900000036JP';
const UNKNOWN = 'P2607019990002';
type Row = Record<string, unknown>;
type Reply = Record<string, unknown> & { connote_history: Row[] };
const source = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const answer = (name: string, change: (rows: Row[], value: Reply) => void = () => {}) => {
  const value = JSON.parse(source(`${name}.json`)) as Reply;
  change(value.connote_history, value);
  return value;
};
const json = (name: string, change?: (rows: Row[], value: Reply) => void) => JSON.stringify(answer(name, change));
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parsePosIndonesia>) =>
  result.events!.map(event => [event.local_time, event.provider_code, event.stage ?? null, event.location ?? null]);

describe('Pos Indonesia tracking adapter', () => {
  it('asks the app’s service about the whole number once, with the app’s key, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(json('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PosIndonesiaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' p2607-0199-90001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${POS_INDONESIA_ENDPOINT}${DOMESTIC}`);
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { Accept: 'application/json',
      'Content-Type': 'application/json', 'X-API-KEY': expect.stringMatching(/^\w{32}$/), 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pos-indonesia', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered waybill newest first, on its offices’ wall clocks, without staff, recipient or postcodes', () => {
    const result = parsePosIndonesia(answer('delivered'), DOMESTIC);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Barang anda selesai dikirim dan diterima', last_update: null, last_update_local: '2026-07-03T13:50:54',
      expected_delivery: null, weight_kg: 1.25, destination_country: 'ID', history_truncated: true });
    expect(result.delivered_at).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-07-03T13:50:54', 'DELIVERED', 'delivered', 'DC CONTOHJAYA'],
      ['2026-07-03T08:20:11', 'DELIVERYRUNSHEET', 'out_for_delivery', 'DC CONTOHJAYA'],
      ['2026-07-03T06:57:39', 'UNBAG', 'in_transit', 'DC CONTOHJAYA'],
      ['2026-07-01T23:37:39', 'INVEHICLE', 'in_transit', 'SPP Contoh'],
      ['2026-07-01T21:05:57', 'INLOCATION', 'in_transit', 'SPP Contoh'],
      ['2026-07-01T15:40:02', 'INBAG', 'in_transit', 'Contohsari'],
      ['2026-07-01T09:12:40', 'PENDING', 'accepted', 'Contohsari'],
    ]);
    expect(result.events!.map(event => event.description)).toEqual([
      'Barang anda selesai dikirim dan diterima',
      'Barang anda telah melewati proses DeliveryRunsheet di Kantor Pos DC CONTOHJAYA',
      `Barang anda ${DOMESTIC} telah melewati proses unbagging dengan nomor bag PID9990001 di DC CONTOHJAYA`,
      `Barang anda ${DOMESTIC} telah melewati proses ManifestR7 dengan nomor bag PID9990001 di SPP Contoh dan nomor R7 9990000000001`,
      'Barang anda telah melewati proses receiving di Kantor Pos SPP Contoh',
      'Barang anda telah melewati proses bagging di Kantor Pos Contohsari',
      'Connote telah dibuat di lokasi KOTACONTOH',
    ]);
    expect(result.events!.every(event => !('time' in event))).toBe(true);
    const kept = JSON.stringify(result);
    for (const dropped of ['SITI', 'PETUGAS', 'ANDI', 'RINA', 'JOKO', 'budi', 'BUDI', 'TOKO', '0812', 'JL ', 'BERSANGKUTAN', 'Sialamat',
      '40999', '80999', '40990', '8099J', 'C1', 'SHPE', '21000', 'PKH']) {
      expect(kept, dropped).not.toContain(dropped);
    }
  });

  it('reads an item sent abroad, with a scan that has neither wording nor place', () => {
    const result = parsePosIndonesia(answer('in-transit'), ABROAD);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-06-21T02:44:12',
      weight_kg: 0.4, destination_country: 'US', history_truncated: true });
    expect(rows(result)).toEqual([
      ['2026-06-21T02:44:12', 'INVEHICLE', 'in_transit', 'JAKARTACONTOH'],
      ['2026-06-20T18:01:13', 'INBAG', 'in_transit', null],
      ['2026-06-20T16:50:54', 'PENDING', 'accepted', 'Contoh Group'],
    ]);
    expect(result.events![1]).toEqual({ local_time: '2026-06-20T18:01:13', description: 'Bagging', provider_code: 'INBAG',
      stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events![2]!.description).toBe('Connote telah dibuat di lokasi United States US');
    expect(JSON.stringify(result)).not.toMatch(/JANE|EXAMPLE STREET|DEWI|PETUGAS|16999|19999|S1"|CDS/);
    // A destination the reply gives as neither a postcode nor a country is left out.
    for (const zone of ['', 'XX', '1234', null]) {
      expect(parsePosIndonesia(answer('in-transit', (_, value) => { value.zone_code_to = zone; }), ABROAD).destination_country, String(zone))
        .toBeUndefined();
    }
    for (const weight of [0, -5, 1.5, '400', null, 2_000_000]) {
      expect(parsePosIndonesia(answer('in-transit', (_, value) => { value.actual_weight = weight; }), ABROAD).weight_kg, String(weight))
        .toBeUndefined();
    }
  });

  it('reads the template the service fills with nothing for an item it holds no waybill for', () => {
    const text = source('inbound.txt');
    expect(() => JSON.parse(text)).toThrow();
    const result = parsePosIndonesia(posIndonesiaPayload(text), INBOUND);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-08-04T13:50:54',
      history_truncated: true });
    expect(result.weight_kg).toBeUndefined();
    expect(result.destination_country).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-08-04T13:50:54', 'DELIVERED', 'delivered', 'Pool antar mpc Contoh'],
      ['2026-08-04T10:21:43', 'DELIVERYRUNSHEET', 'out_for_delivery', 'Pool antar mpc Contoh'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/TONO|PETUGAS|ani|80999|L9/);
    // Only the scans name the item; another item's scans are not it.
    expect(() => parsePosIndonesia(posIndonesiaPayload(text), 'LP900000040JP')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => posIndonesiaPayload('{"connote_code":"P2607019990001",')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(posIndonesiaPayload('\uFEFF{"message": "Data not found"}')).toEqual({ message: 'Data not found' });
  });

  it('drops staff, recipients and phone numbers from scan wording, and keeps the rest', () => {
    for (const [wording, kept] of [
      ['Barang anda selesai dikirim oleh (PETUGAS POS) dan diterima oleh Ani Contoh (DITERIMA KELUARGA) (Diterima Sialamat)',
        'Barang anda selesai dikirim dan diterima'],
      ['Barang anda diterima oleh satpam', 'Barang anda diterima'],
      ['Connote telah dibuat oleh Ani Contoh di lokasi KOTACONTOH 80999', 'Connote telah dibuat di lokasi KOTACONTOH'],
      ['Barang anda gagal antar oleh Budi Contoh dengan alasan alamat tidak jelas', 'Barang anda gagal antar dengan alasan alamat tidak jelas'],
      ['Barang anda telah melewati proses bagging oleh (A) di Kantor Pos Contoh 40999C1, hubungi 0812-3456-7890',
        'Barang anda telah melewati proses bagging di Kantor Pos Contoh, hubungi'],
      ['Hubungi +62 812 3456 7890 atau 6281234567890.', 'Hubungi atau.'],
      ['Barang anda P2607019990001 telah melewati proses ManifestR7 dengan nomor bag LE999999999ID di SPP Contoh 13999 dan nomor R7 9990000000001',
        'Barang anda P2607019990001 telah melewati proses ManifestR7 dengan nomor bag LE999999999ID di SPP Contoh dan nomor R7 9990000000001'],
      ['Diproses di DC CONTOH 4099J pada 2026-07-01', 'Diproses di DC CONTOH pada 2026-07-01'],
    ] as const) expect(posIndonesiaWording(wording), wording).toBe(kept);
  });

  it('takes a history of one scan, drops repeated scans, orders scans of one second by the reply and caps long histories', () => {
    const single = parsePosIndonesia(answer('delivered', (events, value) => {
      (value as Record<string, unknown>).connote_history = events[0];
    }), DOMESTIC);
    expect(single).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Connote telah dibuat di lokasi KOTACONTOH' });
    expect(single.events).toHaveLength(1);
    const twice = parsePosIndonesia(answer('delivered', events => { events.push({ ...events.at(-1)!, id: 1 }); }), DOMESTIC);
    expect(twice.events).toHaveLength(7);
    // The service once logged a delivery on the second the waybill was made, before the delivery run.
    const tied = parsePosIndonesia(answer('delivered', events => {
      events.splice(1, 4);
      events[2]!.date = events[0]!.date;
    }), DOMESTIC);
    expect(rows(tied)).toEqual([
      ['2026-07-03T08:20:11', 'DELIVERYRUNSHEET', 'out_for_delivery', 'DC CONTOHJAYA'],
      ['2026-07-01T09:12:40', 'DELIVERED', 'delivered', 'DC CONTOHJAYA'],
      ['2026-07-01T09:12:40', 'PENDING', 'accepted', 'Contohsari'],
    ]);
    expect(tied).toMatchObject({ current_stage: 'out_for_delivery' });
    const long = parsePosIndonesia(answer('delivered', events => {
      events.unshift(...Array.from({ length: 120 }, (_, index) => ({ ...events[2]!,
        date: `2026-06-${String(1 + Math.floor(index / 24)).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00:00` })));
    }), DOMESTIC);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ current_stage: 'delivered', history_truncated: true });
  });

  it('keeps new states visible and stages them by their wording when it can', () => {
    const result = parsePosIndonesia(answer('delivered', events => {
      events.push(
        { ...events.at(-1)!, date: '2026-07-04 09:00:00', connote_state: 'SOMETHINGNEW', action: 'SOMETHINGNEW', content: 'Sesuatu yang baru' },
      );
    }), DOMESTIC);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Sesuatu yang baru' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ local_time: '2026-07-04T09:00:00', location: 'DC CONTOHJAYA', description: 'Sesuatu yang baru',
      provider_code: 'SOMETHINGNEW' });
    const worded = parsePosIndonesia(answer('delivered', events => {
      events.push({ ...events.at(-1)!, date: '2026-07-04 09:00:00', connote_state: '', action: 'Retur', content: 'Item returned to sender' });
    }), DOMESTIC);
    expect(worded.events![0]).toMatchObject({ provider_code: 'RETUR', stage: 'returned', stage_source: expect.stringMatching(/^wording:/) });
  });

  it('reads its not-found notice as a missing item, and an answer without scans apart from it', async () => {
    expect(() => parsePosIndonesia(JSON.parse(source('not-found.json')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(json('delivered'))).mockResolvedValueOnce(reply(source('not-found.json'), 400));
    await expect(carrier(fetcher).recognize!(DOMESTIC)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-07-03T13:50:54' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const missing = vi.fn<typeof fetch>().mockResolvedValue(reply(source('not-found.json'), 400));
    await expect(carrier(missing).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    for (const empty of [[], null, '']) {
      expect(() => parsePosIndonesia(answer('delivered', (_, value) => { (value as Record<string, unknown>).connote_history = empty; }), DOMESTIC),
        JSON.stringify(empty)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('binds the answer to the whole requested number', () => {
    for (const change of [
      (_: Row[], value: Reply) => { value.connote_code = UNKNOWN; },
      (events: Row[]) => { events[3]!.connote_code = UNKNOWN; },
      // The template without a waybill, with another item's scans.
      (events: Row[], value: Reply) => { value.connote_code = ''; for (const event of events) event.connote_code = UNKNOWN; },
    ]) expect(() => parsePosIndonesia(answer('delivered', change), DOMESTIC)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePosIndonesia(answer('delivered'), 'P26070199900010')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(parsePosIndonesia(answer('delivered', (_, value) => { value.connote_code = 'p2607 0199 90001'; }), DOMESTIC).status).toBe('delivered');
  });

  it('rejects malformed answers and scans', () => {
    for (const change of [
      (events: Row[]) => { delete events[0]!.connote_code; },
      (events: Row[]) => { events[0]!.connote_code = 7; },
      (events: Row[]) => { events[0]!.date = '01-07-2026 09:12:40'; },
      (events: Row[]) => { events[0]!.date = '2026-02-30 09:12:40'; },
      (events: Row[]) => { events[0]!.date = '2026-07-01 24:00:00'; },
      (events: Row[]) => { events[0]!.date = null; },
      (events: Row[]) => { events[0]!.connote_state = ''; events[0]!.action = ''; },
      (events: Row[]) => { events[0]!.connote_state = 'not a state'; },
      (events: Row[]) => { events[0]!.content = 5; },
      (events: Row[]) => { (events as unknown[])[0] = 'scan'; },
      (_: Row[], value: Reply) => { (value as Record<string, unknown>).connote_history = 'scans'; },
      (_: Row[], value: Reply) => { value.connote_history = Array.from({ length: 501 }, () => value.connote_history[0]!); },
      (_: Row[], value: Reply) => { value.connote_code = ''; value.connote_history = []; },
    ]) expect(() => parsePosIndonesia(answer('delivered', change), DOMESTIC)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [[], null, 'item', {}, { message: 'Something else' }, { connote_code: DOMESTIC }]) {
      expect(() => parsePosIndonesia(payload, DOMESTIC), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{"message":"Unauthenticated, wrong X-Api-Key"}', status));
      await expect(carrier(fetcher).track({ number: DOMESTIC })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DOMESTIC)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages, refused lookups and malformed replies apart from missing items', async () => {
    for (const [body, status, kind] of [
      ['<!DOCTYPE html><html><title>Akses Diblokir</title></html>', 200, 'challenge'],
      ['<html><body>Access denied</body></html>', 400, 'challenge'],
      ['Service unavailable', 200, 'schema'],
      ['{"items":[]}', 200, 'schema'],
      ['{"message":"The number field is required."}', 400, 'indeterminate'],
      ['Bad request', 400, 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body, status));
      await expect(carrier(fetcher).recognize!(DOMESTIC), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DOMESTIC })).rejects.toThrow('unexpectedly large');
  });

  it('takes waybills, eleven-digit barcodes and S10 codes, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['P2613019990001', 'P2607329990001', 'P260701999000', 'Q2607019990001', 'RR900000018ID', '1590000000',
      '159000000012', 'ABC', 'P2607019990001'.repeat(5)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async () => reply(source('not-found.json'), 400));
    for (const number of ['15900000001', 'rr 900 000 019 id', INBOUND, UNKNOWN]) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(any.mock.calls.map(([url]) => String(url).slice(POS_INDONESIA_ENDPOINT.length))).toEqual(['15900000001', ABROAD, INBOUND, UNKNOWN]);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(json('delivered')));
    await expect(carrier(flaky).track({ number: DOMESTIC })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(json('delivered')));
    await expect(carrier(immediate).track({ number: DOMESTIC }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DOMESTIC }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DOMESTIC }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Pos Indonesia to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(json('in-transit')));
    const tracked = await createTracker({ fetcher, providers: [], env: {} }).track({ number: ABROAD, carrier: 'pos-indonesia' }, { budgetMs: 3000 });
    expect(tracked).toMatchObject({ carrier: 'pos-indonesia', source: 'pos-indonesia', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${POS_INDONESIA_ENDPOINT}${ABROAD}`)).toBe(true);
  });

  it('is asked about waybills, which detection only suggests, and reads its links', () => {
    expect(detectCarrierMatch(DOMESTIC)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['pos-indonesia'] });
    expect(recognitionAskedCarriers(DOMESTIC)).toContain('pos-indonesia');
    // No rule claims eleven-digit barcodes for it; an S10 code ending ID only suggests it.
    expect(recognitionAskedCarriers('15900000001')).not.toContain('pos-indonesia');
    expect(detectCarrierMatch(ABROAD)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(ABROAD)[0]).toBe('pos-indonesia');
    for (const link of [`https://www.posindonesia.co.id/id/tracking/${DOMESTIC}`, `https://www.posindonesia.co.id/en/tracking/${DOMESTIC}`,
      `https://www.posindonesia.co.id/id/tracking?resi=${DOMESTIC}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DOMESTIC, carrier: 'pos-indonesia', source: 'link' });
    }
  });
});

describe('Pos Indonesia status vocabulary', () => {
  it('records every state the map knows with the stage it gives', () => {
    const coded = statuses.entries.filter((entry): entry is typeof entry & { code: string } => 'code' in entry);
    expect(coded.length).toBeGreaterThan(0);
    for (const entry of coded) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(posIndonesiaCodeStage(entry.code), entry.code).toBe(entry.stage);
    }
    // The tracking page's own wordings come without a state; the adapter does not read them.
    for (const entry of statuses.entries.filter(entry => !('code' in entry))) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
    }
    for (const code of ['constructor', 'toString', '__proto__', 'NN']) expect(statusMap.stage(code, ''), code).toBeUndefined();
    expect(statusMap.stage('inBAG', '')).toBe('in_transit');
    expect(statusMapAnswer({ carrier: 'pos-indonesia', providerCode: 'DELIVERYRUNSHEET', description: 'Barang anda telah melewati proses DeliveryRunsheet' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
