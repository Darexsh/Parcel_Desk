import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, YURTICI_DETAIL_URL, YURTICI_MOVEMENT_URL, YURTICI_SEARCH_URL, YurticiKargoTracker } from './adapter.js';
import { parseYurtici, parseYurticiSearch } from './parser.js';
import { statusMap, yurticiScanStage, yurticiSummaryStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '900000000001';
const RETURNING = '900000000002';
const UNKNOWN = '900000000009';
const AWB = '9000000000000001';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Record<string, unknown> => JSON.parse(text(name));
const movements = (): Record<string, unknown>[] => JSON.parse(text('movements'));
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const found = (id: string | number, abroad = false) => ({ DocId: Number(id), IsAbroad: abroad });
const search = (number: string) => parseYurticiSearch(found(number), number);
const NOT_FOUND = { ErrorMessage: ' No record found. Please try with a different tracking code.' };

/** A transport that answers each tracker service from the given replies. */
function yurtici(replies: { search?: unknown; detail?: unknown; movements?: unknown }) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    const service = `${url.origin}${url.pathname}`;
    if (service === YURTICI_SEARCH_URL) return json(replies.search ?? found(url.searchParams.get('id')!));
    if (service === YURTICI_DETAIL_URL) return json(replies.detail ?? text('delivered'));
    if (service === YURTICI_MOVEMENT_URL) return json(replies.movements ?? text('movements'));
    throw new Error(`unexpected request to ${service}`);
  });
}

describe('Yurtiçi Kargo HTTP adapter', () => {
  it('searches the whole code, reads the details by shipment id and asks for movements only while the parcel moves', async () => {
    const fetcher = yurtici({ detail: text('returning') });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new YurticiKargoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' 9000 0000 0002 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'exception' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${YURTICI_SEARCH_URL}?id=${RETURNING}&language=en`,
      `${YURTICI_DETAIL_URL}?id=${RETURNING}&language=en`,
      `${YURTICI_MOVEMENT_URL}?id=${RETURNING}&language=en`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'yurtici-kargo', step: 'direct', outcome: 'ok' }));
    const delivered = yurtici({});
    await expect(carrier(delivered).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(delivered.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/service/shipmentstrackingsearch', '/service/shipmentstracking']);
  });

  it('reads a delivered parcel as a summary of its shipment and delivery in local time, without people or phones', () => {
    const result = parseYurtici(fixture('delivered'), undefined, DELIVERED, search(DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', summary_only: true, last_update: null, last_update_local: '2026-03-06T14:45:00',
      expected_delivery: null, service_name: 'STANDART' });
    expect(result.events).toEqual([
      { local_time: '2026-03-06T14:45:00', description: 'DELIVERED', location: 'Örnekşehir - Merkez', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-03-04T17:20:00', description: 'The transport document was issued.', location: 'Denemekent - Çarşı',
        stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(result.pickup_point).toBeUndefined();
    expect(result.canonical_tracking_number).toBeUndefined();
    const kept = JSON.stringify(result);
    for (const dropped of ['Synthetic Recipient', 'Example Shop', 'Synthetic Neighbour', '0000 000', 'ZZ000001', 'ÖRNEK ŞUBE', 'DENEME ŞUBE']) {
      expect(kept).not.toContain(dropped);
    }
  });

  it('names the delivery branch of a parcel collected there, and reads a return the summary keeps in Turkish', () => {
    const collected = parseYurtici({ ...fixture('delivered'), IsAddressDelivery: false, ShipmentStatus: 'TESLİM EDİLDİ' }, undefined, DELIVERED, search(DELIVERED));
    expect(collected).toMatchObject({ current_stage: 'delivered', pickup_point: 'ÖRNEK ŞUBE', last_status_text: 'TESLİM EDİLDİ' });
    const returned = parseYurtici({ ...fixture('delivered'), IsAddressDelivery: false, ShipmentStatus: 'İADE EDİLDİ', RejectStatus: '2' },
      undefined, DELIVERED, search(DELIVERED));
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'İADE EDİLDİ', summary_only: true });
    expect(returned.pickup_point).toBeUndefined();
    expect(returned.events![0]).toMatchObject({ description: 'İADE EDİLDİ', stage: 'returned' });
    // An unfamiliar final summary falls back to whether the parcel was turned back.
    const unfamiliar = { ...fixture('delivered'), ShipmentStatus: 'SOMETHING NEW' };
    expect(parseYurtici({ ...unfamiliar, RejectStatus: '2' }, undefined, DELIVERED, search(DELIVERED))).toMatchObject({ current_stage: 'returned' });
    expect(parseYurtici({ ...unfamiliar, RejectStatus: '0' }, undefined, DELIVERED, search(DELIVERED))).toMatchObject({ current_stage: 'delivered' });
    const unsettled = parseYurtici({ ...unfamiliar, RejectStatus: '9' }, undefined, DELIVERED, search(DELIVERED));
    expect(unsettled).toMatchObject({ status: 'unknown', last_status_text: 'SOMETHING NEW', summary_only: true });
    expect(unsettled.current_stage).toBeUndefined();
    expect(unsettled.events![0]).not.toHaveProperty('stage');
  });

  it('lists a moving parcel’s movements newest first by order number, with their reasons and without branch names', () => {
    const shuffled = movements();
    shuffled.push(shuffled.splice(2, 1)[0]!, { ...shuffled[0]! });
    const result = parseYurtici(fixture('returning'), shuffled, RETURNING, search(RETURNING));
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'NOT RETURNED',
      last_update_local: '2026-03-10T12:29:00', expected_delivery: null, service_name: 'STANDART' });
    expect(result.summary_only).toBeUndefined();
    expect(result.events!.map(event => [event.local_time, event.stage ?? null, event.description, event.location ?? null])).toEqual([
      ['2026-03-10T12:29:00', 'failed_attempt', 'NOT DELIVERED / WAITING AT BRANCH (To Return)', 'Denemekent - Çarşı'],
      ['2026-03-10T09:15:00', 'in_transit', 'Reached the delivery unit.', 'Denemekent - Çarşı'],
      ['2026-03-10T02:33:00', 'in_transit', 'In the transfer process.', null],
      ['2026-03-06T08:38:00', 'exception', 'Redirected to Exit Unit for Return Process. (Reject Completed)', 'Örnekşehir - Merkez'],
      ['2026-03-05T08:20:00', 'failed_attempt',
        'NOT DELIVERED / WAITING AT BRANCH (CONSIGNEE COULD NOT BE FOUND AT THE ADDRESS. NOTE HAS BEEN DROPPED)', 'Örnekşehir - Merkez'],
      ['2026-03-03T09:16:00', 'out_for_delivery', 'Distribution exited.', 'Örnekşehir - Merkez'],
      ['2026-03-03T08:16:00', 'in_transit', 'Reached the delivery unit.', 'Örnekşehir - Merkez'],
      ['2026-03-03T08:14:00', 'in_transit', 'In the transfer process.', null],
      ['2026-03-02T10:30:00', 'accepted', 'The transport document was issued.', 'Denemekent - Çarşı'],
    ]);
    const kept = JSON.stringify(result);
    for (const dropped of ['Synthetic Recipient', 'Example Shop', 'ÖRNEK ŞUBE', 'DENEME ŞUBE', '9001', '0000 000']) expect(kept).not.toContain(dropped);
  });

  it('keeps the estimate while the parcel moves and not past its newest movement, and reads Turkish clocks', () => {
    const moving = { ...fixture('returning'), ShipmentStatus: 'ON ITS WAY', RejectStatus: '0', ShipmentStatusDescription: '' };
    const early = movements().slice(0, 4);
    expect(parseYurtici(moving, early, RETURNING, search(RETURNING))).toMatchObject({ status: 'out_for_delivery',
      current_stage: 'out_for_delivery', last_status_text: 'Distribution exited.', expected_delivery: '2026-03-03' });
    expect(parseYurtici(moving, movements().slice(0, 5), RETURNING, search(RETURNING))).toMatchObject({
      current_stage: 'failed_attempt', expected_delivery: null });
    const turkish = [
      { OrderNo: 1, EventDate: '2 Mart 2026 Pazartesi 10:30', Description: 'Taşıma belgesi düzenlendi.', DetailDescription: '', Title: 'Denemekent - Çarşı' },
      { OrderNo: 2, EventDate: '3 Mart 2026 Salı 08:14', Description: 'Transfer Sürecinde', DetailDescription: '', Title: ' - ' },
      { OrderNo: 3, EventDate: '3 Mart 2026 Salı 09:16', Description: 'Dağıtıma çıkarıldı.', DetailDescription: '', Title: 'Örnekşehir - Merkez' },
      { OrderNo: 4, EventDate: 'Salı öğleden sonra', Description: 'Teslim edilemedi.',
        DetailDescription: 'Alıcıya adreste ulaşılamadığından, adrese bilgi notu bırakılmıştır.', Title: 'Örnekşehir - Merkez' },
    ];
    const read = parseYurtici({ ...moving, EstimatedDeliveryDate: '3 Mart 2026 Salı' }, turkish, RETURNING, search(RETURNING));
    expect(read).toMatchObject({ current_stage: 'failed_attempt', last_update_local: '2026-03-03T09:16:00', expected_delivery: null });
    expect(read.events!.map(event => [event.local_time ?? event.provider_time_text, event.stage])).toEqual([
      ['Salı öğleden sonra', 'failed_attempt'], ['2026-03-03T09:16:00', 'out_for_delivery'],
      ['2026-03-03T08:14:00', 'in_transit'], ['2026-03-02T10:30:00', 'accepted'],
    ]);
    expect(read.events![0]!.description).toBe('Teslim edilemedi. (Alıcıya adreste ulaşılamadığından, adrese bilgi notu bırakılmıştır.)');
    // A movement dated by its day alone keeps that day, which becomes the last update when it is the newest.
    const dayOnly = parseYurtici(moving, [...turkish.slice(0, 3), { ...turkish[3]!, EventDate: '3 Mart 2026 Salı' }], RETURNING, search(RETURNING));
    expect(dayOnly.events![0]).toMatchObject({ local_time: '2026-03-03', stage: 'failed_attempt' });
    expect(dayOnly.events![0]!.provider_time_text).toBeUndefined();
    expect(dayOnly.last_update_local).toBe('2026-03-03');
    // A parcel whose movements are not listed yet keeps its shipment date as a summary.
    expect(parseYurtici(moving, [], RETURNING, search(RETURNING))).toMatchObject({ current_stage: 'accepted', summary_only: true,
      last_update_local: '2026-03-02T10:30:00', expected_delivery: '2026-03-03' });
  });

  it('reads the tracker’s notices for unknown, expired and international shipments apart', async () => {
    expect(() => parseYurticiSearch(NOT_FOUND, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const turkish = { ErrorMessage: 'Sorguladığınız gönderi koduyla bir kargo bulunamadı.Lütfen gönderi kodunu kontrol ederek tekrar deneyiniz.' };
    expect(() => parseYurticiSearch(turkish, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseYurticiSearch({ ErrorMessage: 'Service unavailable.' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(yurtici({ search: text('not-found') })).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const expired = yurtici({ detail: { ErrorMessage: 'No record found. Please try with a different tracking code.' } });
    await expect(carrier(expired).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
    expect(expired).toHaveBeenCalledTimes(2);
    const abroad = yurtici({ search: found('9000000000000001', true) });
    await expect(carrier(abroad).track({ number: AWB })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'international_shipment' });
    expect(abroad).toHaveBeenCalledTimes(1);
    const domestic = yurtici({ search: found(DELIVERED) });
    await expect(carrier(domestic).track({ number: AWB })).resolves.toMatchObject({ canonical_tracking_number: DELIVERED });
  });

  it('binds the answer to the whole requested code and rejects malformed replies', () => {
    expect(parseYurticiSearch(found('000000000123'), '000000000123')).toEqual({ id: '123' });
    expect(parseYurticiSearch({ DocId: DELIVERED, IsAbroad: false }, DELIVERED)).toEqual({ id: DELIVERED });
    for (const payload of [found('900000000003'), { DocId: 0, IsAbroad: false }, { DocId: 1e17, IsAbroad: false }, { DocId: DELIVERED },
      { IsAbroad: false }, [], null]) {
      expect(() => parseYurticiSearch(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const detail of [{ ...fixture('delivered'), Id: 900000000003 }, { ...fixture('delivered'), ShipmentStatus: '' },
      { ...fixture('delivered'), IsDelivered: 'true' }, []]) {
      expect(() => parseYurtici(detail, undefined, DELIVERED, search(DELIVERED))).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const open = fixture('returning');
    for (const list of [{}, [null], [{ OrderNo: 1, EventDate: 'Monday, March 2, 2026 10:30 AM' }], [{ OrderNo: 1, Description: 'Distribution exited.' }]]) {
      expect(() => parseYurtici(open, list, RETURNING, search(RETURNING)), JSON.stringify(list)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseYurtici(open, Array.from({ length: 301 }, () => movements()[0]), RETURNING, search(RETURNING)))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYurtici(open, { ErrorMessage: 'Error' }, RETURNING, search(RETURNING))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const bare = { ...open, Title: '', ShipmentStatus: 'SOMETHING NEW' };
    expect(() => parseYurtici(bare, [], RETURNING, search(RETURNING))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes a known shipment and the not-found notice without a browser or recipient inputs', async () => {
    const direct = carrier(yurtici({}));
    await expect(direct.recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-06T14:45:00' });
    await expect(carrier(yurtici({ search: NOT_FOUND })).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('90000000001')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s from the tracker as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json('{"Message":"An error has occurred."}', status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('keeps firewall pages and malformed replies apart from missing shipments', async () => {
    const page = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.</body></html>';
    for (const [body, kind] of [[page, 'challenge'], ['<html>Maintenance</html>', 'schema'], ['{}', 'schema']] as const) {
      await expect(carrier(yurtici({ search: body })).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      await expect(carrier(yurtici({ detail: body })).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    }
    await expect(carrier(yurtici({ detail: text('returning'), movements: page })).track({ number: RETURNING })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('rejects codes Yurtiçi Kargo does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['90000000001', '9000000000011', '900000000000000', 'YK9000000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a shipment filed under Yurtiçi Kargo to the adapter', async () => {
    const fetcher = yurtici({ detail: text('returning') });
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: RETURNING, carrier: 'yurtici-kargo' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'yurtici-kargo', source: 'yurtici-kargo', result: { current_stage: 'exception' } });
    expect(fetcher.mock.calls.every(([url]) => new URL(String(url)).origin === 'https://www.yurticikargo.com')).toBe(true);
  });
});

describe('Yurtiçi Kargo status vocabulary', () => {
  it('records every movement and summary wording with the stage the adapter gives it', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; note?: string }[]) {
      const summary = entry.note?.startsWith('Summary') ?? false;
      expect(summary ? yurticiSummaryStage(entry.wording) : yurticiScanStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording))).toBe(entry.stage);
    }
    expect(yurticiScanStage('NOT DELIVERED / WAITING AT BRANCH (To Return)')).toBe('failed_attempt');
    expect(yurticiScanStage('İade Süreci için  Çıkış Birimine Yönlendirildi')).toBe('exception');
    expect(statusMap.stage('1', 'Distribution exited.')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'yurtici-kargo', description: 'Distribution exited.' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
