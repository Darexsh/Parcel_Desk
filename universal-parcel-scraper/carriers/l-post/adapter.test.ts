import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, L_POST_HISTORY_URL, L_POST_ORDER_URL, LPostTracker } from './adapter.js';
import { lPostResult, normalizeLPostNumber, parseLPostOrder } from './parser.js';
import { lPostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const NUMBER = 'ABC12345679';
const UNKNOWN = 'ABC00000000';

type Row = Record<string, unknown>;
type Order = Row & { data: Row & { trackingData?: Row } };
type History = Row & { history: Row[] };

const fixture = <T = Row>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const order = (name: string, change: (details: Row, reply: Order) => void = () => {}) => {
  const reply = fixture<Order>(name);
  change(reply.data.trackingData ?? reply.data, reply);
  return reply;
};
const history = (name: string, change: (rows: Row[], reply: History) => void = () => {}) => {
  const reply = fixture<History>(name);
  change(reply.history, reply);
  return reply;
};
const parse = (orderReply: unknown, historyReply: unknown, number = NUMBER) => lPostResult(parseLPostOrder(orderReply, number), historyReply);
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
/** A transport answering the order lookup and the history with their replies. */
const routes = (orderReply: () => Response, historyReply: () => Response = () => reply(history('history-delivered'))) =>
  vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === L_POST_HISTORY_URL ? historyReply() : orderReply()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The page DDoS-Guard serves in place of a site's reply while it checks the browser.
const DDOS_GUARD = '<!DOCTYPE html><html><head><title>DDoS-Guard</title></head><body><script src="/.well-known/ddos-guard/check?context=free_splash"></script></body></html>';

describe('L-POST HTTP adapter', () => {
  it('asks the page’s backend for the whole number in capitals, then for that order’s history, through the supplied transport', async () => {
    const fetcher = routes(() => reply(order('order-pickup-delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' abc 1234-5679 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([L_POST_ORDER_URL, L_POST_HISTORY_URL]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ OrderTracking: { trackNumber: NUMBER, phoneNumber: '' } });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({ orderData: NUMBER });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'l-post', step: 'direct', outcome: 'ok' }));
  });

  it('keeps a collected order’s wall clocks and point, without the return rows moving it', () => {
    const result = parse(order('order-pickup-delivered'), history('history-delivered'));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Выполнено', last_update: null, last_update_local: '2026-05-12T15:58:00', expected_delivery: null,
      sender_name: 'Sample Shop', pickup_point: 'ул. Вымышленная, д. 0\nSample Mall, floor 0' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-05-12T15:58:00', 'R2', null],
      ['2026-05-12T15:40:00', 'R1', null],
      ['2026-05-12T15:40:00', '25', 'delivered'],
      ['2026-05-10T11:05:00', '24', 'ready_for_pickup'],
      ['2026-05-09T08:00:00', '23', 'in_transit'],
      // The repeated row is kept once.
      ['2026-05-08T22:03:00', '22', 'in_transit'],
      ['2026-05-08T19:17:00', '21', 'in_transit'],
      ['2026-05-07T15:24:00', '4', 'registered'],
      ['2026-05-07T10:01:00', '1', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
    // The shop's order number, the point's phone, coordinates and metro, the storage deadline and the payment options stay out.
    expect(JSON.stringify(result)).not.toMatch(/000000|8\(800\)|0\.0000|Образцовая|2026-05-15|IsCash/);
    // Normalization keeps the point the parcel was collected from.
    expect(normalizeCarrierResult(result).pickup_point).toBe(result.pickup_point);
  });

  it('reads a courier order waiting for its courier as in transit, without the recipient’s address', () => {
    const result = parse(order('order-courier-in-transit'), history('history-in-transit'));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Размещено в пункте доставки', last_update_local: '2026-06-01T07:12:00', expected_delivery: '2026-06-02' });
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['24', 'in_transit'], ['23', 'in_transit'], ['22', 'in_transit'], ['21', 'in_transit'], ['4', 'registered'], ['1', 'registered'],
    ]);
    expect(result).not.toHaveProperty('pickup_point');
    expect(result).not.toHaveProperty('sender_name');
    expect(JSON.stringify(result)).not.toMatch(/Образцов|Вымышленная|кв\.|"10"|"18"/);
    // The same status at a pickup point is ready for collection there.
    const waiting = parse(order('order-courier-in-transit', (details) => {
      details.isCourier = '0';
      details.AdressDelivery = 'ул. Вымышленная, д. 0';
    }), history('history-in-transit'));
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'ул. Вымышленная, д. 0' });
    expect(waiting.events![0]).toMatchObject({ provider_code: '24', stage: 'ready_for_pickup' });
  });

  it('answers with the summary alone for an order without history, and lets a status that moves nothing give way to the rows', () => {
    const created = parse(order('order-courier-in-transit', (details) => {
      Object.assign(details, { TXT_Status: 'ACT_CREATED', ID_Status: '4', TXT_Status_RU: 'Готово к отгрузке со склада Интернет-магазина' });
    }), { history: [] });
    expect(created).toMatchObject({ status: 'pending', current_stage: 'registered', provider_code: 'ACT_CREATED', summary_only: true,
      last_status_text: 'Готово к отгрузке со склада Интернет-магазина', events: [] });
    expect(created).not.toHaveProperty('last_update_local');
    const archived = parse(order('order-pickup-delivered', (details) => {
      Object.assign(details, { TXT_Status: 'ARCHIVE', ID_Status: '26', TXT_Status_RU: 'Архив' });
    }), history('history-delivered'));
    expect(archived).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Архив' });
    const cancelled = parse(order('order-pickup-delivered', (details) => {
      Object.assign(details, { TXT_Status: 'CANCELLED', ID_Status: '10', TXT_Status_RU: 'Аннулировано' });
    }), history('history-in-transit'));
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null });
    expect(cancelled).not.toHaveProperty('pickup_point');
  });

  it('keeps an unknown number, a phone request, a failed lookup and another order apart', () => {
    expect(() => parseLPostOrder(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLPostOrder({ data: [], message: '', error: 2 }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'input_required', field: 'recipient verification' }));
    for (const error of [1, 4, '3', 'Ошибка']) {
      expect(() => parseLPostOrder({ data: [], message: '', error }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseLPostOrder(order('order-pickup-delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'L-POST answered for another order' }));
    // An order filed under the shop's own number names that number, not the one asked.
    expect(() => parseLPostOrder(order('order-pickup-delivered', (details) => { details.OrderNumber = '000000'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLPostOrder(order('order-pickup-delivered', (details) => { details.OrderNumber = `${NUMBER} ${UNKNOWN}`; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseLPostOrder(order('order-pickup-delivered', (details) => { details.OrderNumber = 'abc12345679 '; }), NUMBER).number).toBe(NUMBER);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_details: Row, body: Order) => { delete (body as Row).error; },
      (_details: Row, body: Order) => { body.data = [] as never; },
      (details: Row) => { delete details.OrderNumber; },
      (details: Row) => { details.OrderNumber = 12345678; },
      (details: Row) => { details.TXT_Status_RU = ''; },
      (details: Row) => { details.TXT_Status_RU = ['Выполнено']; },
      (details: Row) => { details.TXT_Status = 'done!'; },
      (details: Row) => { details.ID_Status = 'x'; },
      (details: Row) => { details.SellerName = { name: 'Sample Shop' }; },
    ]) {
      expect(() => parseLPostOrder(order('order-pickup-delivered', change), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (_rows: Row[], body: History) => { delete (body as Row).history; },
      (_rows: Row[], body: History) => { body.history = 'history' as never; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 500 }, () => rows[0]!)); },
      (rows: Row[]) => { rows[0] = 'row' as never; },
      (rows: Row[]) => { rows[0]!.DateChange = '2026-05-12 15:58'; },
      (rows: Row[]) => { rows[0]!.DateChange = '12.05.2026 24:00'; },
      (rows: Row[]) => { rows[0]!.DateChange = '30.02.2026 10:00'; },
      (rows: Row[]) => { delete rows[0]!.DateChange; },
      (rows: Row[]) => { rows[0]!.txt = ''; },
      (rows: Row[]) => { rows[0]!.ID_StatusNew = null; },
      (rows: Row[]) => { rows[0]!.isVozvratStatus = 'yes'; },
    ]) {
      expect(() => parse(order('order-pickup-delivered'), history('history-delivered', change))).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a moved route, a browser check, a refusal, a throttle and an outage apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(routes(() => reply(body, init))).track({ number: NUMBER });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing order from a 200 reply: a 404, a 405 or a redirect is a moved route.
    await expect(lookup('{"name":"Not Found","status":404}', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('{"name":"Method Not Allowed","status":405}', { status: 405 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://l-post.ru/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(DDOS_GUARD, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Л-Пост</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    // A history that fails after the order was found is no answer either.
    await expect(carrier(routes(() => reply(order('order-pickup-delivered')), () => reply(DDOS_GUARD))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('sends the lookup once more after a request that did not reach L-POST', async () => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return String(url) === L_POST_HISTORY_URL ? reply(history('history-delivered')) : reply(order('order-pickup-delivered'));
    });
    await expect(carrier(fetcher).track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([L_POST_ORDER_URL, L_POST_ORDER_URL, L_POST_HISTORY_URL]);
  });

  it('recognizes a known number from the order lookup alone, and asks nothing for a number L-POST does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(order('order-courier-in-transit')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // Wall clocks without a zone cannot date the order's last activity.
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('000000')).resolves.toEqual({ known: false });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([L_POST_ORDER_URL, L_POST_ORDER_URL]);
    // Another order under the number is no answer.
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(order('order-courier-in-transit')))).recognize!(UNKNOWN))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('rejects numbers L-POST does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ABC1234567', 'ABC123456789', 'ABD12345678', '12345678', '000000-1', `ABC${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLPostNumber('abc 1234.5679')).toBe(NUMBER);
  });

  it('ends a hanging lookup inside its budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 80 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('routes a number filed under L-POST, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = routes(() => reply(order('order-pickup-delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: NUMBER, carrier: 'l-post' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'l-post', source: 'l-post', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: NUMBER }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'l-post', source: 'l-post' });
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'l-post', confidence: 'high' });
  });
});

describe('L-POST status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(lPostStage(entry.code, entry.wording, false), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'l-post', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(lPostStage(entry.code, entry.wording, false)?.stage, entry.wording).toBe(entry.stage);
      // A pickup point delivery's own stage; the map leaves it to the delivery method.
      if (entry.code === 'PLACED_IN_PICKUP_POINT') expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBeUndefined();
      else expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
    }
    expect(lPostStage('PLACED_IN_PICKUP_POINT', 'Размещено в пункте доставки', true)).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // A return row stays without a stage whatever its wording.
    expect(lPostStage('R10', 'Аннулировано', false)).toBeNull();
    expect(statusMapAnswer({ carrier: 'l-post', providerCode: 'R3', description: 'Отправлено на склад' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'l-post', providerCode: '4', description: 'Готово к отгрузке со склада Интернет-магазина' }))
      .toEqual({ kind: 'mapped', stage: 'registered' });
    // An id the map does not know is read by its wording, and unknown wording stays without a stage.
    expect(lPostStage('99', 'Выдано курьеру', false)).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(lPostStage('99', 'Синтетический статус', false)).toBeNull();
    expect(statusMapAnswer({ carrier: 'l-post', providerCode: '99', description: 'Синтетический статус' })).toEqual({ kind: 'unknown' });
  });
});
