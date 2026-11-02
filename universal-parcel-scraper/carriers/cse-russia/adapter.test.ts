import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CSE_API, CseTracker } from './adapter.js';
import { cseQueries, cseWording, normalizeCseNumber, parseCse } from './parser.js';
import { cseStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000000017';
const ORDER = '100000000041';
const WAYBILL = '100AAA00000025';
const PICKUP = '100000000000049';
const UNKNOWN = '100000000033';
const POINT = '000000, Тестовская обл, г Тестовск, ул Садовая, дом 5';

type Row = Record<string, unknown>;
type Item = Row & { History: { order_info: Row[]; waybill_info: Row[] } };
interface Reply { found: Item[]; notfound: unknown[] }

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (item: Item, body: Reply) => void) => {
  const body = fixture(name);
  change(body.found[0]!, body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: CarrierResult) => result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage ?? null]);
const event = (date: string, name: string, english: string, extra: Row = {}) => ({ EventDate: date, EventName: name, EventInfo: '',
  EventNameEn: english, EventInfoEn: '', EventGeography: '', ...extra });
// The page DDoS-Guard can put in front of cse.ru while it checks a client.
const DDOS_GUARD = '<!doctype html><html><head><title>DDoS-Guard</title></head><body>'
  + '<script src="/.well-known/ddos-guard/check?context=free_splash"></script></body></html>';

describe('CSE HTTP adapter', () => {
  it('asks the tracking page’s lookup for the number in CSE’s layout and as given, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CseTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 100-000000017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CSE_API}100-000000017%2C100000000017`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cse-russia', step: 'direct', outcome: 'ok' }));
  });

  it('rebuilds the hyphens of CSE’s order and waybill numbers, and asks for anything else as it is', () => {
    expect(cseQueries('100000000017')).toEqual(['100-000000017', '100000000017']);
    expect(cseQueries('1000000000017')).toEqual(['100-0000000017', '1000000000017']);
    expect(cseQueries(PICKUP)).toEqual(['100-0000000-00049', PICKUP]);
    expect(cseQueries('1000000000000049')).toEqual(['100-0000000-000049', '1000000000000049']);
    expect(cseQueries(WAYBILL)).toEqual(['100-AA-A00000025', WAYBILL]);
    expect(cseQueries('100AA00000025')).toEqual(['100-AA-00000025', '100AA00000025']);
    for (const number of ['10000017', '10000000000000000017', 'SYNTH0000000017']) expect(cseQueries(number)).toEqual([number]);
    expect(normalizeCseNumber('100-aa-a00000025')).toBe(WAYBILL);
  });

  it('keeps a door delivery’s waybill and order events newest first, at the offices that recorded them', () => {
    const result = parseCse(fixture('delivered'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Доставка завершена', last_update: null, last_update_local: '2026-03-04T16:02:00', expected_delivery: null,
      weight_kg: 3.4, events: expect.any(Array) });
    expect(rows(result)).toEqual([
      ['2026-03-04T16:02:00', 'Доставка завершена', null, 'delivered'],
      ['2026-03-04T09:26:00', 'Ожидайте курьера сегодня', 'Тестовск г', 'out_for_delivery'],
      ['2026-03-04T09:12:00', 'Груз передан на доставку', 'Тестовск г', 'out_for_delivery'],
      ['2026-03-03T18:40:00', 'Информация по отправлению. Получатель/ компания на адресе не найдены', null, 'failed_attempt'],
      ['2026-03-03T09:05:00', 'Груз передан на доставку', 'Тестовск г', 'out_for_delivery'],
      ['2026-02-27T17:12:00', 'Отправление в пути', 'Примерово г', 'in_transit'],
      // The office that registered the waybill is not where the parcel was.
      ['2026-02-27T15:32:00', 'Отправление создано', null, 'registered'],
      ['2026-02-27T15:32:00', 'На основании заказа оформлена накладная', null, 'registered'],
      ['2026-02-27T15:29:00', 'Отправление получено курьером', null, 'accepted'],
      ['2026-02-27T15:29:00', 'Отправление забрано', null, 'accepted'],
      ['2026-02-27T15:14:00', 'Курьер уже в пути', null, 'registered'],
      ['2026-02-27T14:51:00', 'Принят. Идет обработка', null, 'registered'],
    ]);
    expect(result.events!.every((scan) => scan.time === undefined && scan.stage_source === 'carrier_map')).toBe(true);
    // Couriers, phones, documents and what went wrong at the door are never kept.
    expect(JSON.stringify(result)).not.toMatch(/Курьеров|Доставкин|\+7000|Регистрово|100-000000066|Телефон не отвечает/);
    expect(result).not.toHaveProperty('pickup_point');
  });

  it('finds a shipment by its order through the order its waybill names, and keeps the waybill’s number', () => {
    const result = parseCse(fixture('in-transit'), ORDER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Отправление в пути', last_update_local: '2026-06-14T03:40:00', expected_delivery: '2026-06-18', weight_kg: 0.5,
      canonical_tracking_number: WAYBILL });
    expect(rows(result)).toEqual([
      ['2026-06-14T03:40:00', 'Отправление в пути', 'Москва г', 'in_transit'],
      // Scans in China name the Moscow office that records them.
      ['2026-06-12T21:15:00', 'Груз в транзите Китай-Россия', null, 'in_transit'],
      ['2026-06-10T08:30:00', 'Отправление поступило на склад (Китай)', null, 'in_transit'],
      ['2026-06-09T10:05:00', 'Отправление создано', null, 'registered'],
      ['2026-06-09T10:05:00', 'На основании заказа оформлена накладная', null, 'registered'],
      ['2026-06-09T10:05:00', 'Принят. Идет обработка', null, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/аэропорта|в процессе/);
    // Asked by its waybill, the shipment echoes the number and has nothing to add.
    expect(parseCse(fixture('in-transit'), '100-AA-A00000025')).not.toHaveProperty('canonical_tracking_number');
    // Another order, or an order named only in the order's own events, is another shipment.
    expect(() => parseCse(fixture('in-transit'), '100000000058')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const unnamed = changed('in-transit', (item) => { item.History.waybill_info[3]!.EventInfo = 'По документу: , зарегистрирована накладная'; });
    expect(() => parseCse(unnamed, ORDER)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CSE answered for another shipment' }));
  });

  it('keeps the address of the pickup point a parcel waits at, and words notes on the shipment with their reason', () => {
    const result = parseCse(fixture('pickup'), PICKUP);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'Информация по отправлению. Уточнение данных по накладной (доставке) клиентом',
      last_update_local: '2026-09-21T15:54:00', expected_delivery: '2026-09-22', pickup_point: POINT, weight_kg: 0.32 });
    expect(rows(result)).toEqual([
      ['2026-09-21T15:54:00', 'Информация по отправлению. Уточнение данных по накладной (доставке) клиентом', null, null],
      // A pickup point's events name its town, not the office that serves it.
      ['2026-09-20T11:12:00', 'Ожидает в пункте выдачи', 'Тестовск г', 'ready_for_pickup'],
      ['2026-09-18T18:28:00', 'Груз выбыл из ПВЗ', 'Окрестово г', 'in_transit'],
      ['2026-09-17T06:59:00', 'Информация по отправлению. Переадресация через виджет', null, null],
      ['2026-09-15T18:41:00', 'Ожидает в пункте выдачи', 'Окрестово г', 'ready_for_pickup'],
      ['2026-09-13T20:14:00', 'Отправление в пути', 'Примерово г', 'in_transit'],
      ['2026-09-13T18:46:00', 'Отправление получено курьером', null, 'accepted'],
      ['2026-09-12T12:16:00', 'Отправление создано', null, 'registered'],
      ['2026-09-12T12:16:00', 'Принят. Идет обработка', null, 'registered'],
    ]);
    // The point's staff, hours and phones, and the customer's own words, are never kept.
    expect(JSON.stringify(result)).not.toMatch(/Пунктов|Курьеров|\+7 000|10:00-21:00|Середино|Предоставлены|Лесная/);

    const collected = changed('pickup', (item) => {
      Object.assign(item, { State: 'Доставка завершена', StateEn: 'Delivery completed', Info: '' });
      item.History.waybill_info.unshift(event('22.09.2026 13:05', 'Доставка завершена', 'Delivery completed'));
    });
    expect(parseCse(collected, PICKUP)).toMatchObject({ status: 'delivered', current_stage: 'delivered', pickup_point: POINT,
      expected_delivery: null });
    const left = changed('pickup', (item) => {
      item.History.waybill_info.splice(0, 2);
      Object.assign(item, { State: 'Груз выбыл из ПВЗ', StateEn: 'The cargo has left the pickup point', Info: '' });
    });
    expect(parseCse(left, PICKUP)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Груз выбыл из ПВЗ' });
    expect(parseCse(left, PICKUP)).not.toHaveProperty('pickup_point');
  });

  it('reads a return waybill issued after the delivery run as a return, without its own history', () => {
    const info = 'Возврат груза: Накладная (Возвратная накладная): 100-000000082 от 04.03.2026,';
    const returned = changed('delivered', (item) => {
      Object.assign(item, { State: 'Оформлена добавочная накладная', StateEn: 'Supplementary waybill issued', Info: info });
      item.History.waybill_info.unshift(event('04.03.2026 18:47', 'Оформлена добавочная накладная', 'Supplementary waybill issued', {
        EventInfo: info, EventGeography: 'Тестовск г', Document: { Error: false, Type: 'Возвратная накладная', Number: '100-000000082',
          Info: '', CreateDate: '2026-03-04T18:47:00', State: 'Синтетический статус возврата', InfoEn: '', StateEn: '',
          History: [event('05.03.2026 10:00', 'Синтетическое событие возврата', '', { EventGeography: 'Обратново г' })] },
      }));
    });
    const result = parseCse(returned, DELIVERED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Оформлена добавочная накладная. Возврат груза', last_update_local: '2026-03-04T18:47:00', expected_delivery: null });
    expect(result.events![0]).toEqual({ local_time: '2026-03-04T18:47:00', location: 'Тестовск г',
      description: 'Оформлена добавочная накладная. Возврат груза', stage: 'returned', stage_source: 'carrier_map' });
    expect(result.events).toHaveLength(13);
    expect(JSON.stringify(result)).not.toMatch(/100-000000082|Синтетическ|Обратново/);
  });

  it('keeps an event’s info only as the reason of a note or a supplementary waybill, and only without digits', () => {
    expect(cseWording('Информация по отправлению', 'Получатель/ компания на адресе не найдены: Синтетический ответ'))
      .toBe('Информация по отправлению. Получатель/ компания на адресе не найдены');
    expect(cseWording('Оформлена добавочная накладная', 'Накладная 100-000000082: Возврат')).toBe('Оформлена добавочная накладная');
    expect(cseWording('Информация по отправлению', 'Синтетический текст без двоеточия')).toBe('Информация по отправлению');
    expect(cseWording('Информация по отправлению', ': Синтетический текст')).toBe('Информация по отправлению');
    expect(cseWording('Отправление создано', 'По документу: Заказ 100-000000041 от 09.06.2026')).toBe('Отправление создано');
  });

  it('stages wording the map does not know from the English name beside it, and a status it does not know from the events', () => {
    const english = changed('delivered', (item) => {
      Object.assign(item.History.waybill_info[1]!, { EventName: 'Синтетическое событие', EventNameEn: 'Out for delivery' });
      Object.assign(item.History.waybill_info[4]!, { EventName: 'Другое синтетическое событие', EventNameEn: 'Synthetic event' });
    });
    const events = parseCse(english, DELIVERED).events!;
    expect(events[1]).toMatchObject({ description: 'Синтетическое событие', stage: 'out_for_delivery', stage_source: expect.stringMatching(/^wording/) });
    expect(events[4]).toEqual({ local_time: '2026-03-03T09:05:00', location: 'Тестовск г', description: 'Другое синтетическое событие' });
    // A notice keeps no stage, whatever its English twin says.
    expect(cseStage('Информация по отправлению', 'Delivered')).toBeNull();
    const unknown = changed('delivered', (item) => { Object.assign(item, { State: 'Синтетический статус', StateEn: '' }); });
    expect(parseCse(unknown, DELIVERED)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Синтетический статус' });
  });

  it('reads a shipment without events as its status alone, and one without either as no history', () => {
    for (const history of [{ order_info: [], waybill_info: [] }, null]) {
      const waiting = changed('in-transit', (item) => {
        Object.assign(item, { History: history, State: 'Накладная сохранена, но ещё не была обработана', StateEn: '' });
      });
      expect(parseCse(waiting, WAYBILL)).toEqual({ status: 'pending', current_stage: 'registered',
        current_stage_source: 'carrier_map', last_status_text: 'Накладная сохранена, но ещё не была обработана', summary_only: true,
        last_update: null, expected_delivery: '2026-06-18', weight_kg: 0.5, events: [] });
    }
    const empty = changed('delivered', (item) => { Object.assign(item, { History: null, State: '' }); });
    expect(() => parseCse(empty, DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    const unread = changed('delivered', (item) => { item.Error = true; });
    expect(() => parseCse(unread, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads CSE’s list of numbers it did not find as not found only when it names every query', () => {
    expect(() => parseCse(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCse({ found: [], notfound: ['100-000000033'] }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCse({ found: [], notfound: [] }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const body of [null, [], 'synthetic', { found: [] }]) {
      expect(() => parseCse(body, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // Another shipment in the reply is not an answer, even with the number listed as missing.
    const other = changed('delivered', (_item, body) => { body.notfound = ['100-000000033', '100000000033']; });
    expect(() => parseCse(other, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CSE answered for another shipment' }));
  });

  it('refuses a shipment that does not carry the whole number asked', () => {
    for (const number of ['100000000025', '1000000000170', '000000000017', '00000000017', '100000000067']) {
      expect(() => parseCse(fixture('delivered'), number), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CSE answered for another shipment' }));
    }
    // The order its waybill names is the same shipment.
    expect(parseCse(fixture('delivered'), '100-000000066')).toMatchObject({ current_stage: 'delivered', canonical_tracking_number: DELIVERED });
  });

  it.each([
    ['with shipments that are not a list', (_item: Item, body: Reply) => { (body as unknown as Row).found = {}; }],
    ['without its list of missing numbers', (_item: Item, body: Reply) => { delete (body as Partial<Reply>).notfound; }],
    ['with a shipment that is not an object', (_item: Item, body: Reply) => { (body.found as unknown[])[0] = 'synthetic'; }],
    ['with a shipment number that is not text', (item: Item) => { item.Number = 100000000017; }],
    ['with a history that is a list', (item: Item) => { (item as Row).History = []; }],
    ['with waybill events that are not a list', (item: Item) => { (item.History as Row).waybill_info = {}; }],
    ['with an event that is not an object', (item: Item) => { item.History.waybill_info.push('synthetic' as unknown as Row); }],
    ['with an event without wording', (item: Item) => { item.History.waybill_info[2]!.EventName = ' '; }],
    ['with an impossible event time', (item: Item) => { item.History.waybill_info[2]!.EventDate = '31.02.2026 09:12'; }],
    ['with an event time in another format', (item: Item) => { item.History.order_info[0]!.EventDate = '2026-02-27T15:32:00'; }],
    ['with event info that is not text', (item: Item) => { item.History.waybill_info[1]!.EventInfo = { courier: 'synthetic' }; }],
    ['with a status that is not text', (item: Item) => { item.State = 7; }],
  ])('treats a reply %s as a changed reply', (_name, change) => {
    expect(() => parseCse(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps each failure kind during retrieval', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => reply(body, init)))
      .track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(DDOS_GUARD, { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge', message: 'CSE answered with a browser check' });
    await expect(lookup(DDOS_GUARD, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Synthetic</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    // A redirect to the login page or a missing route is a moved lookup, not a missing parcel.
    await expect(lookup('', { status: 302, headers: { Location: 'https://lk.cse.ru/login' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('{"message":"Not Found"}', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    });

  it('rejects numbers CSE does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '1000017', 'SYNTHETIC', '100/000000017', '0'.repeat(41), '0'.repeat(80)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number, {}), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a number CSE answers, and not one it lists as missing', async () => {
    const known = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(carrier(known).recognize!(DELIVERED, {})).resolves.toMatchObject({ known: true });
    const missing = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('not-found')));
    await expect(carrier(missing).recognize!(UNKNOWN, {})).resolves.toEqual({ known: false });
  });

  it('routes a number filed under CSE to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: '100-000000017', carrier: 'cse-russia' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'cse-russia', source: 'cse-russia', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(CSE_API))).toBe(true);
  });
});

describe('CSE status vocabulary', () => {
  it('records every status seen live with the stage the map gives it, and its notices as gaps', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean; confirmedBy: string }[]) {
      if (entry.unmapped) {
        expect(statusMapAnswer({ carrier: 'cse-russia', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        expect(cseStage(entry.wording, 'Delivered'), entry.wording).toBeNull();
        continue;
      }
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(cseStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'cse-russia', providerCode: null, description: 'Ожидает в пункте выдачи' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'cse-russia', providerCode: null, description: 'Информация по отправлению' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});
