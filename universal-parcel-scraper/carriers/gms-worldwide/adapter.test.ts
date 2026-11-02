import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GMS_API, GmsTracker } from './adapter.js';
import { gmsWording, normalizeGmsNumber, parseGms } from './parser.js';
import { gmsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '000000001';
const IN_TRANSIT = '000000002';
const UNKNOWN = '000000009';

type Row = Record<string, unknown>;
type Order = Row & { '@attributes': Row; Scans: { ScanDetail: Row[] | Row } };
type Reply = { Order: Order };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
const changed = (name: string, change: (order: Order, rows: Row[]) => void) => {
  const body = fixture(name);
  change(body.Order, body.Order.Scans.ScanDetail as Row[]);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The invented consignee, receiver, references and links of the fixtures.
const PRIVATE = /Sample (?:Road|Person)|SAMPLE PERSON|SAMPLE-REF|example\.invalid|\.jpg|0{10}|Demobad/;

describe('GMS Worldwide Express HTTP adapter', () => {
  it('asks the tracking page’s lookup for the consignment number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('in-transit'))).mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GmsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000 000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${GMS_API}?cnno=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gms-worldwide', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);

    await carrier(fetcher).track({ number: DELIVERED });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${GMS_API}?cnno=${DELIVERED}`);
  });

  it('keeps the number, the scans on India’s clock and their offices, and nothing about the consignee', () => {
    const result = parseGms(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered (POD)', last_update: '2026-03-12T05:45:42Z', delivered_at: '2026-03-12T05:45:42Z',
      expected_delivery: null, timezone: 'Asia/Kolkata' });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.events!.map((event) => [event.time, event.stage, event.location, event.description])).toEqual([
      // Listed after the out-for-delivery scan on the same clock, the delivery is the newest.
      ['2026-03-12T05:45:42Z', 'delivered', 'DEMOBAD RO APEX, DEMOBAD', 'Delivered (POD)'],
      ['2026-03-12T05:45:42Z', 'out_for_delivery', 'DEMOBAD RO APEX, DEMOBAD', 'Consignment Out for delivery'],
      ['2026-03-10T13:00:00Z', 'failed_attempt', 'DEMOBAD RO APEX, DEMOBAD', 'NOT delivered - ADDRESS NOT FOUND'],
      ['2026-03-10T04:22:07Z', 'out_for_delivery', 'DEMOBAD RO APEX, DEMOBAD', 'Consignment Out for delivery'],
      ['2026-03-09T03:11:19Z', 'in_transit', 'DEMOBAD RO APEX, DEMOBAD', 'RECEIVED BY DEMOBAD RO APEX, DEMOBAD'],
      ['2026-03-08T16:35:33Z', 'in_transit', 'HUBNAGAR RO APEX, HUBNAGAR', 'Forwarded TO DEMOBAD RO APEX, DEMOBAD'],
      ['2026-03-08T01:42:50Z', 'in_transit', 'HUBNAGAR RO APEX, HUBNAGAR', 'RECEIVED BY HUBNAGAR RO APEX, HUBNAGAR'],
      // Twelve past midnight in India is the evening before in UTC.
      ['2026-03-06T18:50:11Z', 'in_transit', 'SAMPLEPUR BO, SAMPLEPUR', 'Forwarded TO HUBNAGAR RO APEX, HUBNAGAR'],
      ['2026-03-06T07:18:05Z', 'accepted', 'SAMPLEPUR BO, SAMPLEPUR', 'BOOKED AT SAMPLEPUR'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    expect(Object.keys(result.events![0]!).sort()).toEqual(['description', 'location', 'stage', 'stage_source', 'time']);
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
    expect(JSON.stringify(result)).not.toMatch(/STD|https?:/);
    expect(Object.keys(result).sort()).toEqual(['current_stage', 'current_stage_source', 'delivered_at', 'events', 'expected_delivery',
      'last_status_text', 'last_update', 'status', 'timezone']);
  });

  it('reads a delivery the last office records with its forwarding on one clock', () => {
    const result = parseGms(changed('delivered', (_order, rows) => {
      rows.splice(0, 2,
        { Scan: 'DEMOBAD BO, DEMOBAD', ScanDate: '12 Mar 2026', ScanTime: '03:20:37 pm', Cnstatus: 'Delivered (POD)' },
        { Scan: 'DEMOBAD BO, DEMOBAD', ScanDate: '12 Mar 2026', ScanTime: '03:20:37 pm', Cnstatus: 'Forwarded to OTHERVILLE' });
    }), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered (POD)', delivered_at: '2026-03-12T09:50:37Z' });
    expect(result.events![1]).toMatchObject({ description: 'Forwarded to OTHERVILLE', stage: 'in_transit', location: 'DEMOBAD BO, DEMOBAD' });
  });

  it('follows the scans over a summary that lags them', () => {
    const transit = parseGms(fixture('in-transit'), IN_TRANSIT);
    expect(transit).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'RECEIVED BY OTHERPUR APEX, OTHERPUR',
      last_update: '2026-04-05T11:13:47Z' });
    expect(transit).not.toHaveProperty('delivered_at');
    expect(transit.events).toHaveLength(5);
    // The origin's office records the delivery months later; the summary still says In Transit.
    const late = parseGms(changed('in-transit', (_order, rows) => {
      rows.unshift({ Scan: 'SAMPLEPUR RO APEX, SAMPLEPUR', ScanDate: '07 Aug 2026', ScanTime: '03:10:23 pm', Cnstatus: 'Delivered AT OTHERVILLE' });
    }), IN_TRANSIT);
    expect(late).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered AT OTHERVILLE',
      delivered_at: '2026-08-07T09:40:23Z' });
    // And a delivered summary does not end a history that has not reached the delivery.
    const ahead = parseGms(changed('in-transit', (order) => { order.Cnstatus = 'Delivered (POD)'; }), IN_TRANSIT);
    expect(ahead).toMatchObject({ current_stage: 'in_transit', last_status_text: 'RECEIVED BY OTHERPUR APEX, OTHERPUR' });
  });

  it('reads one scan given on its own, a history listed oldest first and a repeated scan', () => {
    const single = parseGms(changed('in-transit', (order, rows) => { order.Scans.ScanDetail = rows.at(-1)!; }), IN_TRANSIT);
    expect(single).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'BOOKED AT SAMPLEPUR',
      last_update: '2026-04-01T15:40:47Z' });
    expect(single.events).toHaveLength(1);
    const reversed = parseGms(changed('delivered', (_order, rows) => { rows.reverse(); }), DELIVERED);
    expect(reversed).toMatchObject({ current_stage: 'delivered', last_update: '2026-03-12T05:45:42Z' });
    expect(reversed.events!.at(-1)).toMatchObject({ description: 'BOOKED AT SAMPLEPUR' });
    const repeated = parseGms(changed('in-transit', (_order, rows) => { rows.splice(1, 0, { ...rows[1]! }); }), IN_TRANSIT);
    expect(repeated.events).toHaveLength(5);
  });

  it('answers with the summary alone when the consignment has no scans', () => {
    for (const scans of [{}, { ScanDetail: {} }, { ScanDetail: [] }, undefined]) {
      const result = parseGms(changed('in-transit', (order) => { order.Scans = scans as never; }), IN_TRANSIT);
      expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
        last_status_text: 'In Transit', last_update: null, expected_delivery: null, timezone: 'Asia/Kolkata', summary_only: true, events: [] });
    }
    expect(() => parseGms(changed('in-transit', (order) => { order.Scans = {} as never; order.Cnstatus = {}; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('takes whom a delivery names and phone numbers out of the wording, and an address out of the location', () => {
    expect(gmsWording('Delivered to SAMPLE PERSON')).toBe('Delivered');
    expect(gmsWording('Delivered (POD) - received by SAMPLE PERSON')).toBe('Delivered (POD)');
    expect(gmsWording('Consignment delivered to SAMPLE PERSON 98765 43210')).toBe('Consignment delivered');
    expect(gmsWording('Consignment Out for delivery, call +91 98765 43210')).toBe('Consignment Out for delivery, call');
    // A delivery's town and every other scan keep their words.
    expect(gmsWording('Delivered AT OTHERVILLE')).toBe('Delivered AT OTHERVILLE');
    expect(gmsWording('RECEIVED BY HUBNAGAR RO APEX, HUBNAGAR')).toBe('RECEIVED BY HUBNAGAR RO APEX, HUBNAGAR');
    expect(gmsWording('NOT delivered - ADDRESS NOT FOUND')).toBe('NOT delivered - ADDRESS NOT FOUND');
    const placed = parseGms(changed('in-transit', (_order, rows) => {
      rows[0]!.Scan = '1 Sample Road, OTHERPUR 000000';
      rows[1]!.Scan = {};
    }), IN_TRANSIT);
    expect(placed.events!.slice(0, 2).map((event) => event.location ?? null)).toEqual([null, null]);
  });

  it('reads the lookup’s answer for an unknown number as not found, and any other answer as inconclusive', () => {
    expect(() => parseGms(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGms({ Status: 'ERROR' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGms({ Status: '' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const body of [{}, { Status: {} }, { Status: ['NO DATA'] }, [], 'NO DATA', null]) {
      expect(() => parseGms(body, UNKNOWN), JSON.stringify(body)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('counts a consignment only when it names the whole number asked', () => {
    expect(() => parseGms(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GMS Worldwide Express answered for another consignment' }));
    for (const other of ['0000000010', '00000001', '000000003', '']) {
      expect(() => parseGms(changed('delivered', (order) => { order['@attributes'].trackingNo = other; }), DELIVERED), other)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseGms(changed('delivered', (order) => { order['@attributes'].trackingNo = ' 000000001 '; }), DELIVERED).events).toHaveLength(9);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (order: Order) => { delete (order as Row)['@attributes']; },
      (order: Order) => { order['@attributes'] = { trackingNo: 1 }; },
      (order: Order) => { order['@attributes'] = { trackingNo: { value: DELIVERED } }; },
      (order: Order) => { order.Scans = 'scans' as never; },
      (order: Order) => { order.Scans = { ScanDetail: 'scan' } as never; },
      (order: Order, rows: Row[]) => { order.Scans.ScanDetail = Array.from({ length: 501 }, () => rows[0]!); },
      (_order: Order, rows: Row[]) => { rows[0] = 'scan' as never; },
      (_order: Order, rows: Row[]) => { rows[0]!.ScanDate = '2026-03-12'; },
      (_order: Order, rows: Row[]) => { rows[0]!.ScanDate = '30 Feb 2026'; },
      (_order: Order, rows: Row[]) => { rows[0]!.ScanDate = '12 Mar 26'; },
      (_order: Order, rows: Row[]) => { rows[0]!.ScanTime = '13:15:42 pm'; },
      (_order: Order, rows: Row[]) => { rows[0]!.ScanTime = '11:15 am'; },
      (_order: Order, rows: Row[]) => { rows[0]!.ScanTime = '23:15:42'; },
      (_order: Order, rows: Row[]) => { delete rows[0]!.ScanTime; },
      (_order: Order, rows: Row[]) => { rows[0]!.Cnstatus = ['Delivered (POD)']; },
      (_order: Order, rows: Row[]) => { rows[0]!.Cnstatus = { text: 'Delivered (POD)' }; },
      (_order: Order, rows: Row[]) => { rows[0]!.Cnstatus = {}; },
      (_order: Order, rows: Row[]) => { rows[0]!.Scan = ['DEMOBAD RO APEX']; },
      (order: Order) => { order.Cnstatus = ['Delivered']; order.Scans = {} as never; },
    ]) {
      expect(() => parseGms(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseGms({ Order: [fixture('delivered').Order] }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a block page, a moved route, a refusal and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // A page in place of the reply, even with HTTP 200, is never a missing consignment.
    await expect(lookup('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>GMS Worldwide Express</title><p>Invalid Tracking No.</p></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('Not Found', { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.gmsglobe.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failure to reach GMS, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GmsTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gms-worldwide', step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('recognizes a known consignment and the not-found answer, and asks nothing for a number GMS does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T05:45:42.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('00000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers GMS does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00000001', '0000000010', '00000000A', 'GMS000000001', '', `${'0'.repeat(65)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGmsNumber(' 000-000-002 ')).toBe(IN_TRANSIT);
  });

  it('routes a number filed under GMS Worldwide Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'gms-worldwide' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'gms-worldwide', source: 'gms-worldwide', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(GMS_API))).toBe(true);
  });
});

describe('GMS Worldwide Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(gmsStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(gmsStage(gmsWording(entry.wording))?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'gms-worldwide', providerCode: null, description: 'RECEIVED BY HUBNAGAR RO APEX, HUBNAGAR' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'gms-worldwide', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Wording the map does not know falls to the shared rules.
    expect(gmsStage('Returned to shipper')?.stage).toBe('returned');
    expect(gmsStage('Synthetic note')).toBeNull();
  });
});
