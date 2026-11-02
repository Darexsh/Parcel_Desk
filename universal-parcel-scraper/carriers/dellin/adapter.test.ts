import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DELLIN_API, dellinDeviceId, DellinTracker } from './adapter.js';
import { normalizeDellinNumber, parseDellin } from './parser.js';
import { dellinStage, dellinState, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '26-00000000017';
const SECOND_WAYBILL = '26-00000000025';
const IN_TRANSIT = '26-00000000033';
const REQUEST = '40000001';
const UNKNOWN = '26-00000000041';

type Row = Record<string, unknown>;
type Order = Row & { documents: Row[]; orderDatesExtended: Row[] | null };
type Reply = Row & { orders: Order[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (order: Order, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.orders[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The page Qrator puts in front of Dellin's hosts for a client that has not run its script.
const QRATOR = '<!DOCTYPE html>\n<html><head>\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>\n'
  + '<script src="/__qrator/qauth.js" charset="utf-8"></script>\n</head><body></body>\n</html>';

describe('Delovye Linii HTTP adapter', () => {
  it('posts the printed waybill with the app’s key and a device id once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new DellinTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' 2600000000017 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    await tracker.fetch(SECOND_WAYBILL);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(DELLIN_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    const body = JSON.parse(String(init!.body));
    expect(body).toEqual({ appKey: expect.stringMatching(/^[\dA-F]{8}(?:-[\dA-F]{4}){3}-[\dA-F]{12}$/), deviceId: expect.any(String),
      docIds: [DELIVERED], orderDatesExtended: true });
    // One install keeps one device id.
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).deviceId).toBe(body.deviceId);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dellin', step: 'direct', outcome: 'ok' }));
  });

  it('mints device ids as the app does', () => {
    expect(dellinDeviceId('123e4567-e89b-42d3-a456-426614174000')).toBe('123e4567-a89b-42d3-a456-a26614174000');
    expect(dellinDeviceId()).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/);
    expect(dellinDeviceId()).not.toBe(dellinDeviceId());
  });

  it('keeps the dated milestones newest first as calendar days, and reads the order’s state', () => {
    const result = parseDellin(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Заказ завершен', last_update: null, last_update_local: '2026-03-06', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-03-06', 'доставлен на адрес получения', null, 'delivered'],
      ['2026-03-05', 'прибыл на терминал г. Примерово', 'Примерово', 'in_transit'],
      ['2026-03-02', 'принят на терминале отправки', null, 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
    // Either waybill of the order, with or without its hyphen, is the order.
    expect(parseDellin(fixture('delivered'), '2600000000025')).toMatchObject({ current_stage: 'delivered' });
  });

  it('skips forecasts and milestones without a date, and finds an order by its pickup request', () => {
    const result = parseDellin(fixture('in-transit'), REQUEST);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Груз в пути',
      last_update_local: '2026-04-10' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-04-10', 'принят на терминале отправки', 'accepted'],
      ['2026-04-10', 'отправлен с адреса клиента', 'accepted'],
    ]);
    expect(parseDellin(fixture('in-transit'), IN_TRANSIT).events).toHaveLength(2);
    // A milestone repeated on its day is kept once.
    const repeated = changed('in-transit', (order) => { order.orderDatesExtended!.push({ ...order.orderDatesExtended![0] }); });
    expect(parseDellin(repeated, IN_TRANSIT).events).toHaveLength(2);
  });

  it('reads an order without dated milestones as its state alone', () => {
    const waiting = changed('in-transit', (order) => {
      Object.assign(order, { state: 'waiting', stateName: 'Ожидает сдачи на терминал', stateDate: '2026-04-09', orderDatesExtended: null });
    });
    expect(parseDellin(waiting, IN_TRANSIT)).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Ожидает сдачи на терминал', provider_code: 'waiting', summary_only: true, last_update: null,
      last_update_local: '2026-04-09', expected_delivery: null, events: [] });
    const unknownState = changed('in-transit', (order) => { Object.assign(order, { state: 'synthetic', stateName: null }); });
    expect(parseDellin(unknownState, IN_TRANSIT)).toMatchObject({ status: 'unknown', last_status_text: 'принят на терминале отправки' });
    expect(parseDellin(unknownState, IN_TRANSIT)).not.toHaveProperty('current_stage');
  });

  it('reads Dellin’s own unknown-order error as not found, and other answers by what they are', () => {
    expect(() => parseDellin(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDellin({ errors: [{ code: 130008, title: 'Недопустимое значение параметра' }] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDellin({ errors: 'Unauthorized' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDellin(changed('delivered', (_order, body) => { body.orders = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses an order that does not carry the whole number asked', () => {
    for (const number of [IN_TRANSIT, '26-00000000001', '4000000']) {
      expect(() => parseDellin(fixture('delivered'), number), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Delovye Linii answered for another shipment' }));
    }
  });

  it.each([
    ['without documents', (order: Order) => { delete (order as Row).documents; }],
    ['without its state', (order: Order) => { order.state = null; }],
    ['with a milestone that is not an object', (order: Order) => { order.orderDatesExtended!.push('synthetic' as unknown as Row); }],
    ['with an invalid milestone date', (order: Order) => { order.orderDatesExtended![0]!.date_full = '2026-02-30'; }],
    ['with a milestone without wording', (order: Order) => { order.orderDatesExtended![0]!.description = ' '; }],
    ['with milestones that are not a list', (order: Order) => { (order as Row).orderDatesExtended = {}; }],
  ])('treats an order %s as a changed reply', (_name, change) => {
    expect(() => parseDellin(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps each failure kind during retrieval', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init)))
      .track({ number: DELIVERED });
    await expect(lookup(fixture('not-found'), { status: 400 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(QRATOR, { status: 401, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge', message: 'Delovye Linii answered with its bot check' });
    await expect(lookup(QRATOR, { status: 200, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ errors: 'Unauthorized' }, { status: 401 }))
      .rejects.toMatchObject({ kind: 'challenge', message: 'Delovye Linii refused the app\'s key' });
    await expect(lookup('<html><title>Synthetic</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.dellin.ru/' } })).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    });

  it('rejects numbers Dellin does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['260000000001', '26-000000000177', '123456', 'DL00000000017', '0'.repeat(80)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDellinNumber('26 0000 0000 017')).toBe(DELIVERED);
    expect(normalizeDellinNumber(' 4000-0001 ')).toBe(REQUEST);
  });

  it('routes a number filed under Delovye Linii to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'dellin' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'dellin', source: 'dellin', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === DELLIN_API)).toBe(true);
  });
});

describe('Delovye Linii status vocabulary', () => {
  it('records every state and milestone seen live with the stage the map gives it', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string; confirmedBy: string }[]) {
      if (entry.confirmedBy !== 'live') continue;
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      if (!entry.code) expect(dellinStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'dellin', providerCode: 'warehousing', description: 'Груз прибыл на терминал. Платное хранение' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'dellin', providerCode: null, description: 'прибыл на терминал г. Тестовск' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(dellinState('declined')).toBe('exception');
    expect(dellinState('synthetic')).toBeUndefined();
  });
});
