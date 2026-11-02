import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PECOM_API, PecomTracker } from './adapter.js';
import { normalizePecomNumber, parsePecom } from './parser.js';
import { pecomStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000000017';
const IN_TRANSIT = '100000000025';
const UNKNOWN = '100000000033';

type Row = Record<string, unknown>;
type Cargo = Row & { statuses: (Row & { clientStatus: Row })[]; detailsCargoStatus: Row[] | null; currentStatus: Row | null };
type Reply = Row & { result: { data: Row & { cargo: Cargo } } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (cargo: Cargo, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.result.data.cargo, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The page Qrator puts in front of pecom.ru for a client that has not run its script.
const QRATOR = '<!DOCTYPE html>\n<html><head>\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>\n'
  + '<script src="/__qrator/qauth.js" charset="utf-8"></script>\n</head><body></body>\n</html>';

describe('PEC HTTP adapter', () => {
  it('asks the tracking page’s JSON-RPC method for the whole code once, as a guest, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PecomTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 0000 0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(PECOM_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ id: expect.any(Number), jsonrpc: '2.0', method: 'LK.OCR.Get',
      sessid: '0'.repeat(32), params: { cargoIndex: DELIVERED } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pecom', step: 'direct', outcome: 'ok' }));
  });

  it('keeps the dated statuses newest first at their departments, and the pickup point the cargo was collected from', () => {
    const result = parsePecom(fixture('delivered'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Выдан получателю', last_update: null, last_update_local: '2026-05-07T18:45:10', expected_delivery: null,
      pickup_point: 'Тестовск Садовая 5\nгород Тестовск, Садовая улица, 5', weight_kg: 11.5, events: expect.any(Array) });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2026-05-07T18:45:10', 'Выдан получателю', 'Тестовск', 'delivered'],
      ['2026-05-06T11:30:00', 'Прибыл', 'Тестовск', 'in_transit'],
      ['2026-05-02T14:00:41', 'Отправлен на терминал выдачи Тестовск', null, 'in_transit'],
      ['2026-05-02T14:00:41', 'В пути', null, 'in_transit'],
      ['2026-05-01T09:20:05', 'Оформлен', 'Примерово', 'accepted'],
      ['2026-05-01T09:12:30', 'Принят к перевозке', 'Примерово', 'accepted'],
    ]);
    expect(result.events![0]).toMatchObject({ point: { latitude: 53.2345, longitude: 50.1234 }, stage_source: 'carrier_map' });
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // The sender and the recipient are never read.
    expect(JSON.stringify(result)).not.toMatch(/Отправителев|Получателев|\+7000/);
  });

  it('reads the corrected arrival date as the forecast of a cargo on its way, with its transit rows', () => {
    const result = parsePecom(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'В пути',
      last_update_local: '2026-06-13T02:10:00', expected_delivery: '2026-06-17', weight_kg: 240,
      pickup_point: 'Тестовск\nРоссия, Тестовск, Терминальная улица, 7' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null])).toEqual([
      ['2026-06-13T02:10:00', 'Прибыл в пункт выдачи Середино', 'Середино'],
      ['2026-06-11T08:30:00', 'Отправлен на терминал выдачи Тестовск', null],
      ['2026-06-11T08:30:00', 'В пути', null],
      ['2026-06-10T16:15:22', 'Оформлен', 'Примерово'],
      ['2026-06-10T16:05:00', 'Принят к перевозке', 'Примерово'],
    ]);
    // A transit row only names the terminal it reached, never its coordinates.
    expect(result.events![0]).not.toHaveProperty('point');
    const planned = changed('in-transit', (cargo) => { cargo.statuses[3]!.clientStatusSpecifiedDate = null; });
    expect(parsePecom(planned, IN_TRANSIT).expected_delivery).toBe('2026-06-15');
  });

  it('reads a door delivery without a pickup point, keeping only the day of a status recorded at its last second', () => {
    const door = changed('delivered', (cargo) => {
      cargo.cargoDelivery = { deliveryDate: '2026-05-07T00:00:00', contactPerson: 'Получателев Пётр', notifyPhone: '+70000000000' };
      cargo.statuses[5] = { clientStatus: { Id: 9, ClientStatus: 'Доставлен получателю', IsActive: true },
        clientStatusPlannedDate: null, clientStatusActualDateTime: '2026-05-07T23:59:59', clientStatusSpecifiedDate: null };
      cargo.currentStatus = { Id: 13, ClientStatus: 'Доставлен получателю', IsActive: true };
    });
    const result = parsePecom(door, DELIVERED);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Доставлен получателю', last_update_local: '2026-05-07' });
    expect(result.events![0]).toEqual({ local_time: '2026-05-07', description: 'Доставлен получателю', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result).not.toHaveProperty('pickup_point');
    expect(JSON.stringify(result)).not.toMatch(/Получателев|\+7000/);

    const underWay = changed('in-transit', (cargo) => { cargo.currentStatus = { Id: 16, ClientStatus: 'Выполняется адресная доставка' }; });
    expect(parsePecom(underWay, IN_TRANSIT)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', expected_delivery: null });
    expect(parsePecom(underWay, IN_TRANSIT)).not.toHaveProperty('pickup_point');
  });

  it('reads a cargo without dated statuses as its current status alone', () => {
    const waiting = changed('in-transit', (cargo) => {
      cargo.statuses = cargo.statuses.map((row) => ({ ...row, clientStatusActualDateTime: null }));
      cargo.detailsCargoStatus = null;
      cargo.currentStatus = { Id: 1, ClientStatus: 'Ожидается передача груза от отправителя', IsActive: true };
    });
    expect(parsePecom(waiting, IN_TRANSIT)).toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Ожидается передача груза от отправителя', summary_only: true, expected_delivery: '2026-06-17', events: [] });
    const empty = changed('in-transit', (cargo) => {
      cargo.statuses = [];
      cargo.detailsCargoStatus = null;
      cargo.currentStatus = null;
    });
    expect(() => parsePecom(empty, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A status the map does not know takes the newest scan's stage.
    const unknown = changed('in-transit', (cargo) => { cargo.currentStatus = { ClientStatus: 'Синтетический статус' }; });
    expect(parsePecom(unknown, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Синтетический статус' });
  });

  it('reads PEC’s own unknown-cargo error as not found, and other errors by what they are', () => {
    expect(() => parsePecom(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: 1, error: { code, message } });
    expect(() => parsePecom(error(-32602, 'Invalid params'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePecom(error(-32601, 'Method not found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePecom(error(-33000, 'Сервис временно недоступен'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a cargo that does not carry the whole code asked', () => {
    for (const number of [IN_TRANSIT, '100000000010', '000000000017']) {
      expect(() => parsePecom(fixture('delivered'), number), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'PEC answered for another cargo' }));
    }
    // The cargo's barcode carries the code too.
    const byBarcode = changed('delivered', (cargo) => { cargo.index = null; });
    expect(parsePecom(byBarcode, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it.each([
    ['without the cargo', (_cargo: Cargo, body: Reply) => { body.result.data.cargo = null as unknown as Cargo; }],
    ['without its code', (cargo: Cargo) => { cargo.index = null; cargo.barcode = null; }],
    ['with a code that is not text', (cargo: Cargo) => { cargo.index = 100000000017; }],
    ['with statuses that are not a list', (cargo: Cargo) => { (cargo as Row).statuses = {}; }],
    ['with a status that is not an object', (cargo: Cargo) => { cargo.statuses.push('synthetic' as unknown as Cargo['statuses'][number]); }],
    ['with an invalid status clock', (cargo: Cargo) => { cargo.statuses[1]!.clientStatusActualDateTime = '2026-02-30T10:00:00'; }],
    ['with a dated status without wording', (cargo: Cargo) => { cargo.statuses[1]!.clientStatus.ClientStatus = ' '; }],
    ['with an invalid transit clock', (cargo: Cargo) => { cargo.detailsCargoStatus![0]!.initDate = '2026-05-02 14:00'; }],
  ])('treats a reply %s as a changed reply', (_name, change) => {
    expect(() => parsePecom(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps each failure kind during retrieval', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init)))
      .track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 401 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(QRATOR, { status: 200 })).rejects.toMatchObject({ kind: 'challenge', message: 'PEC answered with its bot check' });
    await expect(lookup('<html><title>Synthetic</title></html>', { status: 401 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(QRATOR, { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Synthetic</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://pecom.ru/' } })).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    });

  it('rejects codes PEC does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['10000000001', '1000000000177', '1000000000170001', 'PEC100000017', '0'.repeat(80)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePecomNumber('1000-0000-0017')).toBe(DELIVERED);
  });

  it('routes a code filed under PEC to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pecom' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pecom', source: 'pecom', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === PECOM_API)).toBe(true);
  });
});

describe('PEC status vocabulary', () => {
  it('records every status seen live with the stage the map gives it', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string; confirmedBy: string }[]) {
      if (entry.confirmedBy !== 'live') continue;
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(pecomStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'pecom', providerCode: null, description: 'Отправлен на терминал выдачи Тестовск' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'pecom', providerCode: null, description: 'Доставлен получателю' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(pecomStage('Отправлен на возврат')).toEqual({ stage: 'returned', source: 'carrier_map' });
  });
});
