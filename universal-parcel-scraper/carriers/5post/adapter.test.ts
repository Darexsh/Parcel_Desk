import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FIVE_POST_API, FivePostTracker } from './adapter.js';
import { fivePostOrderId, normalizeFivePostNumber, parseFivePost } from './parser.js';
import { fivePostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '99990000000017';
const IN_TRANSIT = 'P00000000025';
const UNKNOWN = '99990000000033';
const DELIVERED_ID = '00000000-0000-4000-8000-000000000017';

type Row = Record<string, unknown>;
interface Lookup { orders: Row[]; details: Row; history: Row[] }

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Lookup;
const changed = (name: string, change: (lookup: Lookup) => void) => {
  const lookup = fixture(name);
  change(lookup);
  return lookup;
};
const parse = (lookup: Lookup, number: string) => parseFivePost(lookup.details, lookup.history, fivePostOrderId(lookup.orders, number), number);
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
/** A transport answering each of the three routes with its part of a lookup, or with a reply of its own. */
const routes = (lookup: Lookup, override: Partial<Record<keyof Lookup, () => Response>> = {}) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => {
    const path = String(url);
    const part: keyof Lookup = path.endsWith('/status-history') ? 'history' : path.endsWith('/orders') ? 'orders' : 'details';
    return override[part]?.() ?? reply(lookup[part]);
  });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The page ServicePipe puts in front of X5's hosts for a client that has not run its script.
const SERVICEPIPE = '<!DOCTYPE html><html><head><title>Проверка</title>'
  + '<script src="https://servicepipe.tech/js-challenge-loader.js"></script></head><body><div id="id_captcha_frame_div"></div></body></html>';

describe('5Post HTTP adapter', () => {
  it('lists the orders under the number, then reads the one order and its history through the supplied transport', async () => {
    const fetcher = routes(fixture('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new FivePostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' 9999 0000 0000 17 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${FIVE_POST_API}/order-tracking/${DELIVERED}/orders`,
      `${FIVE_POST_API}/order-tracking/${DELIVERED}/orders/${DELIVERED_ID}`,
      `${FIVE_POST_API}/orders/${DELIVERED_ID}/status-history`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
      expect(init?.method ?? 'GET').toBe('GET');
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: '5post', step: 'direct', outcome: 'ok' }));
  });

  it('keeps the history newest first with its offsets, and the locker the parcel was collected from', () => {
    const result = parse(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Получен', last_update: '2026-03-12T17:22:09.903+03:00', expected_delivery: null,
      delivered_at: '2026-03-12T17:22:09.903+03:00',
      pickup_point: 'Постамат в магазине Пятёрочка\nПримерово г, Тестовая ул, 1' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-03-12T17:22:09.903+03:00', 'DONE', 'Получен', null, 'delivered'],
      ['2026-03-10T12:05:38.462+03:00', 'DELIVERED', 'Доставлен в пункт выдачи', null, 'ready_for_pickup'],
      ['2026-03-10T02:47:13.581+03:00', 'READY_FOR_SHIPMENT', 'Покинул склад. Ожидайте поступления в пункт выдачи', null, 'in_transit'],
      ['2026-03-09T09:14:52.736+03:00', 'WAREHOUSE_PROCESSING', 'Обрабатывается на складе РЦ Примерово', 'РЦ Примерово', 'in_transit'],
      ['2026-03-07T04:31:27.144+03:00', 'READY_FOR_SHIPMENT', 'Покинул склад РЦ Тестово', 'РЦ Тестово', 'in_transit'],
      ['2026-03-06T22:10:05.318+03:00', 'WAREHOUSE_PROCESSING', 'Обрабатывается на складе РЦ Тестово', 'РЦ Тестово', 'in_transit'],
      ['2026-03-04T11:02:45+03:00', 'CUSTOMS_CLEARANCE_COMPLETED', 'Таможенное оформление завершено', null, 'in_transit'],
      ['2026-03-04T06:20:11+03:00', 'CUSTOMS_CLEARANCE_STARTED', 'Начато таможенное оформление', null, 'customs'],
      ['2026-03-02T10:15:00.500+03:00', 'INFORMATION_RECEIVED', 'Ожидается передача заказа в 5post', null, 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
    // The sender, the broker's contacts, sums, hours and the storage deadline are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Пример Маркет|Брокер|broker|1234|22:00|2026-03-17/);
    expect(result).not.toHaveProperty('summary_only');
  });

  it('reads a parcel on its way, without a pickup point yet or the sender’s', () => {
    const result = parse(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Покинул склад ХАБ Тестово',
      last_update: '2026-04-10T23:41:12.630+03:00' });
    expect(result.events!.map((event) => [event.provider_code, event.location ?? null, event.stage])).toEqual([
      ['READY_FOR_SHIPMENT', 'ХАБ Тестово', 'in_transit'],
      ['WAREHOUSE_PROCESSING', 'ХАБ Тестово', 'in_transit'],
      ['READY_FOR_SHIPMENT', null, 'in_transit'],
      ['PROCESS_WITHDRAWN', null, 'accepted'],
      ['INFORMATION_RECEIVED', null, 'registered'],
    ]);
    expect(result).not.toHaveProperty('pickup_point');
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/Тестовая|Примерная|Пример"/);
  });

  it('heads the order with its status, which can be newer than the history', () => {
    const arrived = changed('in-transit', ({ details }) => {
      Object.assign(details, { orderStatus: 'DELIVERED', orderStatusAssignmentDate: '2026-04-11T09:30:00+03:00' });
    });
    expect(parse(arrived, IN_TRANSIT)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Доставлен в пункт выдачи', last_update: '2026-04-11T09:30:00+03:00',
      pickup_point: 'Касса в магазине Пятёрочка\nТестово г, Примерная ул, 2' });
    const collected = changed('delivered', ({ details, history }) => {
      details.orderStatusAssignmentDate = '2026-03-12T18:00:00+03:00';
      history.pop();
    });
    expect(parse(collected, DELIVERED)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Получен',
      delivered_at: '2026-03-12T18:00:00+03:00' });
    // A delivered order whose history has no stop at a pickup point names none.
    expect(parse(changed('delivered', ({ history }) => { history.splice(7, 1); }), DELIVERED)).not.toHaveProperty('pickup_point');
    const unclaimed = changed('delivered', ({ details, history }) => {
      details.orderStatus = 'UNCLAIMED_TRANSFERRED_TO_DELIVERY_SERVICE';
      history.pop();
      history.push({ ...history.at(-1), changeDate: '2026-03-18T00:00:24.477+03:00', status: 'UNCLAIMED_TRANSFERRED_TO_DELIVERY_SERVICE',
        statusLocalized: 'Не востребован. Передан службе доставки' });
    });
    expect(parse(unclaimed, DELIVERED)).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(parse(unclaimed, DELIVERED)).not.toHaveProperty('pickup_point');
  });

  it('reads an order without history as its status alone, and leaves an unstaged status without a stage', () => {
    const fresh = changed('in-transit', ({ details, history }) => {
      Object.assign(details, { orderStatus: 'INFORMATION_RECEIVED', orderStatusAssignmentDate: '2026-04-06T19:12:05.410+03:00' });
      history.length = 0;
    });
    expect(parse(fresh, IN_TRANSIT)).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Ожидается передача заказа в 5post', provider_code: 'INFORMATION_RECEIVED', summary_only: true,
      last_update: '2026-04-06T19:12:05.410+03:00', expected_delivery: null, events: [] });
    const working = changed('in-transit', ({ details }) => { details.orderStatus = 'UNDEFINED'; });
    expect(parse(working, IN_TRANSIT)).toMatchObject({ status: 'unknown', last_status_text: 'В работе' });
    expect(parse(working, IN_TRANSIT)).not.toHaveProperty('current_stage');
  });

  it('reads 5Post’s empty list as not found, and other answers by what they are', async () => {
    expect(() => fivePostOrderId(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses an order that does not carry the whole number asked', () => {
    const lookup = fixture('delivered');
    for (const number of ['9999000000001', '999900000000170', IN_TRANSIT]) {
      expect(() => fivePostOrderId(lookup.orders, number), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: '5Post answered for another shipment' }));
    }
    const shared = [...lookup.orders, { ...lookup.orders[0], orderId: '00000000-0000-4000-8000-000000000041', senderName: 'Другой магазин' }];
    expect(() => fivePostOrderId(shared, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: '5Post holds several orders under this number' }));
    // Another number's order beside it does not count.
    expect(fivePostOrderId([...lookup.orders, { ...lookup.orders[0], orderId: '00000000-0000-4000-8000-000000000041', clientOrderId: 'X1' }],
      DELIVERED)).toBe(DELIVERED_ID);
    const otherDetails = changed('delivered', ({ details }) => { details.orderId = '00000000-0000-4000-8000-000000000041'; });
    expect(() => parse(otherDetails, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const otherNumber = changed('delivered', ({ details }) => { details.clientOrderId = '99990000000025'; });
    expect(() => parse(otherNumber, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const otherHistory = changed('delivered', ({ history }) => { history[3]!.id = '00000000-0000-4000-8000-000000000041'; });
    expect(() => parse(otherHistory, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each([
    ['a list that is not a list', (lookup: Lookup) => { (lookup as unknown as Row).orders = { content: lookup.orders }; }],
    ['an order without its id', ({ orders }: Lookup) => { delete orders[0]!.orderId; }],
    ['details without the order’s status', ({ details }: Lookup) => { details.orderStatus = null; }],
    ['a history that is not a list', (lookup: Lookup) => { (lookup as unknown as Row).history = {}; }],
    ['a status without its order', ({ history }: Lookup) => { delete history[0]!.id; }],
    ['a status without a clock', ({ history }: Lookup) => { history[0]!.changeDate = '2026-03-02T10:15:00'; }],
    ['a status without its code', ({ history }: Lookup) => { history[0]!.status = 'Получен'; }],
  ])('treats %s as a changed reply', (_name, change) => {
    expect(() => parse(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps each failure kind during retrieval', async () => {
    const lookup = (override: Parameters<typeof routes>[1]) => carrier(routes(fixture('delivered'), override)).track({ number: DELIVERED });
    const page = (status: number) => () => new Response(SERVICEPIPE, { status, headers: { 'Content-Type': 'text/html' } });
    await expect(lookup({ orders: page(200) })).rejects.toMatchObject({ kind: 'challenge', message: '5Post answered with its bot check' });
    await expect(lookup({ history: page(200) })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ orders: page(403) })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ orders: page(404) })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ details: () => reply('<html><title>Synthetic</title></html>') })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ orders: () => reply({ status: 404, error: 'Not Found' }, { status: 404 }) })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ history: () => reply({ status: 404, message: 'Данные по заказу не найдены.' }, { status: 404 }) }))
      .rejects.toMatchObject({ kind: 'indeterminate', message: '5Post did not return the order it listed' });
    await expect(lookup({ details: () => new Response('Not Found', { status: 404 }) })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ orders: () => new Response('', { status: 302, headers: { Location: 'https://fivepost.ru/' } }) }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ details: () => reply({ status: 429, message: 'Слишком много запросов. Повторите попытку позже' },
      { status: 429, headers: { 'Retry-After': '30' } }) })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
  });

  it.each([[429, 'rate_limited'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    });

  it('rejects numbers 5Post does not take and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12', 'ABCDEF', 'P0000/25', 'Р00000000025', '0'.repeat(41), '0'.repeat(80)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFivePostNumber(' p 0000-0000 025 ')).toBe(IN_TRANSIT);
    expect(normalizeFivePostNumber('BX00000000000000FRW')).toBe('BX00000000000000FRW');
  });

  it('routes a number filed under 5Post to the adapter', async () => {
    const fetcher = routes(fixture('in-transit'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: '5post' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: '5post', source: '5post', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(FIVE_POST_API))).toBe(true);
  });
});

describe('5Post status vocabulary', () => {
  it('records every status seen live with the stage the map gives it', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; confirmedBy: string; unmapped?: boolean }[]) {
      if (entry.confirmedBy !== 'live') continue;
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.code).toBe(entry.unmapped ? undefined : entry.stage);
      expect(fivePostStage(entry.code!, entry.wording)?.stage, entry.code).toBe(entry.unmapped ? undefined : entry.stage);
    }
    expect(statusMapAnswer({ carrier: '5post', providerCode: 'DELIVERED', description: 'Доставлен в пункт выдачи' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: '5post', providerCode: 'UNDEFINED', description: 'В работе' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(fivePostStage('SYNTHETIC_STATUS', 'Получен')).toBeNull();
  });
});
