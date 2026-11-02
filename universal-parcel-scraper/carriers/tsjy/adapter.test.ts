import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { SEVENTEENFEIA_API } from '../17feia/adapter.js';
import { adapter, TSJY_API, TsjyTracker } from './adapter.js';
import { normalizeTsjyNumber, parseTsjy, TSJY_LINES, tsjyHandoff } from './parser.js';
import { statusMap, tsjyStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const AT_LINE = 'TSJY990000001CN';
const JOURNEY = 'TSJY990000002CN';
const UNKNOWN = 'TSJY900000000CN';
const LINE = 'FEISH9900000001YQ';
const LATER = Date.parse('2026-04-01T00:00:00Z');

type Row = Record<string, unknown>;
type Order = Row & { trackList: Row[] };
type Envelope = { errcode: unknown; errmsg: unknown; ret: { list: Order[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Envelope;
const changed = (name: string, change: (order: Order, envelope: Envelope) => void) => {
  const envelope = fixture(name);
  change(envelope.ret.list[0]!, envelope);
  return envelope;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const clocks = (result: ReturnType<typeof parseTsjy>) => result.events!.map((event) =>
  [event.time ?? event.local_time, event.description, event.stage ?? null]);

describe('TSJY HTTP adapter', () => {
  it('asks the order search’s history lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('at-line')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TsjyTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' tsjy-9900-0000-1cn ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(TSJY_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: JSON.stringify({ nos: [AT_LINE] }), signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tsjy', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates TSJY’s own steps and 17FEIA’s rows from its warehouse in China as instants and hands over to 17FEIA', () => {
    const result = parseTsjy(fixture('at-line'), AT_LINE, LATER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Order Confirmed.', last_update: '2026-03-05T13:22:41+08:00', expected_delivery: null,
      delivery_carrier: '17feia', delivery_tracking_number: LINE });
    expect(result.last_update_local).toBeUndefined();
    expect(clocks(result)).toEqual([
      ['2026-03-05T13:22:41+08:00', 'Order Confirmed.', 'in_transit'],
      ['2026-03-04T21:07:15+08:00', 'The order has information pending customer confirmation.', 'in_transit'],
      ['2026-03-04T15:48:09+08:00', 'Warehouse receipt.', 'in_transit'],
      ['2026-03-04T09:16:52+08:00', '订单已出库，开始国际运输', 'in_transit'],
      // 17FEIA's order data, while TSJY still holds the parcel.
      ['2026-03-03T20:31:27+08:00', 'Item information received.', 'accepted'],
      ['2026-03-03T11:05:38+08:00', '订单打包完成，等待出库', 'accepted'],
      ['2026-03-03T11:05:12+08:00', '订单打包完成，等待出库', 'accepted'],
      ['2026-03-03T10:42:57+08:00', '仓库拣货完成', 'accepted'],
      ['2026-03-03T10:40:03+08:00', '仓库开始拣货', 'accepted'],
      ['2026-03-03T09:12:30+08:00', '订单已提交，等待系统确认', 'registered'],
    ]);
    expect(result.events![0]!.location).toBe('Haiport');
    expect(result.events![3]!.location).toBe('示例集运仓');
    expect(result.events![4]!.location).toBeUndefined();
    // The order's and rows' ids open its details.
    expect(JSON.stringify(result)).not.toMatch(/00000000-0000|refId|_id/);
  });

  it('reads 17FEIA’s milestones and a partner’s relayed delivery, and drops the estimate and repeated rows', () => {
    const result = parseTsjy(fixture('relayed-journey'), JOURNEY, LATER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'The parcel has been delivered.', last_update: null, last_update_local: '2026-03-19T17:26:00',
      delivery_carrier: '17feia', delivery_tracking_number: 'FEISZ9900000004YQ' });
    // A relayed clock is no instant to date the delivery with.
    expect(result.delivered_at).toBeUndefined();
    expect(clocks(result)).toEqual([
      ['2026-03-19T17:26:00', 'The parcel has been delivered.', 'delivered'],
      ['2026-03-19T08:03:00', 'Out for delivery.', 'out_for_delivery'],
      ['2026-03-17T14:41:00', 'Customs Clearance Completed.', 'in_transit'],
      // The broker's warehouse is not a delivery.
      ['2026-03-16T23:12:00', 'Broker picked up Shipment and delivered to warehouse.', 'customs'],
      ['2026-03-16T15:30:00', 'Flight Arrived at Clearance Port.', 'in_transit'],
      ['2026-03-14T04:10:00', 'Flight has departed.', 'in_transit'],
      ['2026-03-12T10:55:21+08:00', 'Warehouse receipt.', 'in_transit'],
      ['2026-03-11T08:47:19+08:00', '订单已出库，开始国际运输', 'in_transit'],
      ['2026-03-10T22:18:44+08:00', 'Item information received.', 'accepted'],
      ['2026-03-10T14:02:06+08:00', '订单打包完成，等待出库', 'accepted'],
      ['2026-03-10T09:31:48+08:00', '订单已提交，等待系统确认', 'registered'],
    ]);
  });

  it('keeps the wall clocks of rows relayed from a line other than 17FEIA’s', () => {
    const result = parseTsjy(changed('at-line', (order) => { order.channelNo = ''; }), AT_LINE, LATER);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-03-05T13:22:41' });
    expect(result.delivery_carrier).toBeUndefined();
    expect(clocks(result).slice(0, 4).map(([clock]) => clock))
      .toEqual(['2026-03-05T13:22:41', '2026-03-04T21:07:15', '2026-03-04T15:48:09', '2026-03-04T09:16:52+08:00']);
  });

  it('keeps a relayed scan’s wall clock even where its place names a state', () => {
    // The line's rows give no country, state or offset to check the place against.
    const result = parseTsjy(changed('relayed-journey', (order) => { order.trackList[0]!.loc = 'Sampleton, MA, US'; }), JOURNEY, LATER);
    expect(result.events![0]).toMatchObject({ local_time: '2026-03-19T17:26:00', location: 'Sampleton, MA, US', stage: 'delivered' });
    expect(result.events![0]!.time).toBeUndefined();
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-03-19T17:26:00' });
    expect(result.delivered_at).toBeUndefined();
  });

  it('dates a relayed scan on its country’s clock where its place ends with a single-zone country', () => {
    const result = parseTsjy(changed('relayed-journey', (order) => {
      order.trackList[0]!.loc = 'Sampleburg (DE)';
      order.trackList[1]!.loc = 'Sampleburg (US)';
    }), JOURNEY, LATER);
    expect(result.events![0]).toMatchObject({ time: '2026-03-19T17:26:00+01:00', location: 'Sampleburg (DE)', stage: 'delivered' });
    expect(result.events![0]!.local_time).toBeUndefined();
    expect(result).toMatchObject({ last_update: '2026-03-19T17:26:00+01:00', delivered_at: '2026-03-19T17:26:00+01:00' });
    // A country with several zones settles none.
    expect(result.events![1]).toMatchObject({ local_time: '2026-03-19T08:03:00', location: 'Sampleburg (US)' });
    expect(result.events![1]!.time).toBeUndefined();
  });

  it('holds back rows dated after the read', () => {
    const result = parseTsjy(fixture('relayed-journey'), JOURNEY, Date.parse('2026-03-16T20:00:00+08:00'));
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Flight Arrived at Clearance Port.', last_update_local: '2026-03-16T15:30:00' });
    expect(result.events).toHaveLength(7);
  });

  it('keeps the stage a parcel had through a delayed flight', () => {
    const result = parseTsjy(changed('relayed-journey', (order) => {
      order.trackList.splice(6, 0, { event: 'Flight delayed.', date: Date.parse('2026-03-13T12:00:00Z'), loc: 'Bayside' });
    }), JOURNEY, Date.parse('2026-03-13T15:00:00Z'));
    expect(result.events![0]).toMatchObject({ description: 'Flight delayed.', stage: 'in_transit', stage_source: 'none' });
    expect(result).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Flight delayed.' });
  });

  it('hands over through the line table, else to the one carrier a high-confidence rule names', () => {
    expect(TSJY_LINES.map((line) => line.carrier)).toEqual(['17feia']);
    expect(tsjyHandoff('feish 9900 0000 01yq', AT_LINE)).toEqual({ delivery_carrier: '17feia', delivery_tracking_number: LINE });
    expect(tsjyHandoff('CE000000014DE', AT_LINE)).toEqual({ delivery_carrier: 'dhl', delivery_tracking_number: 'CE000000014DE' });
    expect(tsjyHandoff('1Z999AA10123456784', AT_LINE)).toEqual({ delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784' });
    // 17FEIA's box numbers, shapes several carriers share, the order's own number and nothing at all hand over to no one.
    for (const channel of ['FEISH9900000001YQ-1', '999900000005', AT_LINE, '', 'X'.repeat(80)]) expect(tsjyHandoff(channel, AT_LINE)).toBeNull();
    const result = parseTsjy(changed('at-line', (order) => { order.channelNo = '999900000005'; }), AT_LINE, LATER);
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(parseTsjy(changed('at-line', (order) => { delete order.channelNo; }), AT_LINE, LATER).delivery_carrier).toBeUndefined();
  });

  it('names TSJY from its order search link only for its own numbers', () => {
    expect(parseTrackingInput(`https://www.tsjy56.com/orderResult.html?nos=${AT_LINE}`))
      .toMatchObject({ trackingNumber: AT_LINE, carrier: 'tsjy', source: 'link' });
    // The search takes the numbers of the lines TSJY books on too; they keep their own carrier.
    expect(parseTrackingInput(`https://www.tsjy56.com/orderResult.html?nos=${LINE}`))
      .toMatchObject({ trackingNumber: LINE, carrier: '17feia' });
  });

  it('counts an order only when its own number is the one asked', () => {
    // The search also finds an order by its line's number.
    expect(() => parseTsjy(changed('at-line', (order) => { order.searchNo = LINE; }), JOURNEY, LATER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTsjy(changed('at-line', (order) => { order.no = null; }), AT_LINE, LATER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTsjy(changed('at-line', (order, envelope) => { envelope.ret.list.push(order); }), AT_LINE, LATER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const other = fixture('relayed-journey').ret.list[0]!;
    expect(parseTsjy(changed('at-line', (_order, envelope) => { envelope.ret.list.unshift(other); }), AT_LINE, LATER))
      .toMatchObject({ last_status_text: 'Order Confirmed.' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (order: Order) => { order.trackList[0]!.date = '2026-03-05 13:22:41'; },
      (order: Order) => { order.trackList[0]!.date = 1772688161000.5; },
      (order: Order) => { order.trackList[0]!.date = 0; },
      (order: Order) => { order.trackList[0]!.event = { en: 'Order Confirmed.' }; },
      (order: Order) => { order.trackList[0] = 'Order Confirmed.' as never; },
      (order: Order) => { order.trackList = {} as never; },
      (order: Order) => { order.trackList = Array.from({ length: 501 }, () => order.trackList[0]!); },
      (order: Order) => { order.no = [AT_LINE] as never; },
      (_order: Order, envelope: Envelope) => { envelope.ret.list[0] = AT_LINE as never; },
      (_order: Order, envelope: Envelope) => { envelope.ret = { list: {} } as never; },
      (_order: Order, envelope: Envelope) => { envelope.errcode = '0'; },
    ]) {
      expect(() => parseTsjy(changed('at-line', change), AT_LINE, LATER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown order, a refused lookup, an order without scans and a browser check apart', async () => {
    const lookup = (body: unknown, number = UNKNOWN, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup({ errcode: 100001, errmsg: '请求数据出错了' })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(changed('at-line', (order) => { order.success = 0; order.msg = '查询失败'; }), AT_LINE)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(changed('at-line', (order) => { order.trackList = []; }), AT_LINE)).rejects.toMatchObject({ kind: 'indeterminate' });
    // Only the estimate so far.
    await expect(lookup(changed('relayed-journey', (order) => { order.trackList = order.trackList.filter((row) => /^Estimated/.test(String(row.event))); }), JOURNEY))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><head><title>Just a moment...</title></head></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Error - 400</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', UNKNOWN, { status: 302, headers: { Location: 'https://www.tsjy56.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // The route answers every number: without it, the service moved.
    await expect(lookup('', UNKNOWN, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: AT_LINE })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(AT_LINE)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known order and the unknown-order answer, and asks nothing for a number TSJY does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('at-line'))).mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(AT_LINE)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(LINE)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers TSJY does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TSJY99000001CN', 'TSJY9900000011CN', 'TSJY990000001US', 'TSJX990000001CN', LINE, 'CE000000014DE']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: AT_LINE }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTsjyNumber('tsjy 990.000.002 cn')).toBe(JOURNEY);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('at-line')));
    await expect(carrier(fetcher).track({ number: AT_LINE }, { budgetMs: 5000 })).resolves.toMatchObject({ delivery_carrier: '17feia' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: AT_LINE }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a TSJY order to the adapter, which hands the line’s number to 17FEIA', async () => {
    const line = JSON.parse(readFileSync(new URL('../17feia/fixtures/dpd-at-warehouse.json', import.meta.url), 'utf8')) as unknown;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url) === TSJY_API ? reply(fixture('at-line'))
      : String(url) === `${SEVENTEENFEIA_API}${LINE}` ? reply(line) : new Response('', { status: 404 }));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: AT_LINE, carrier: 'tsjy' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'tsjy', source: 'tsjy', result: { current_stage: 'in_transit', delivery_carrier: '17feia' },
      handoff: { carrier: '17feia', number: LINE, basis: 'partner', confirmed: true, result: { delivery_carrier: 'dpd-de' } } });
  });
});

describe('TSJY status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      if (entry.stage === undefined) {
        expect(tsjyStage(entry.wording)).toBeNull();
        expect(statusMapAnswer({ carrier: 'tsjy', providerCode: null, description: entry.wording })).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
      expect(tsjyStage(entry.wording)?.stage).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'tsjy', providerCode: null, description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // A later carrier's announcement comes after TSJY dispatched the parcel.
    expect(tsjyStage('Shipment information received')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'tsjy', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // An own step nobody recorded keeps no stage.
    expect(tsjyStage('仓库已称重')).toBeNull();
  });
});
