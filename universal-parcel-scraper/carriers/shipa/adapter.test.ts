import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SHIPA_API, ShipaTracker } from './adapter.js';
import { normalizeShipaNumber, parseShipa } from './parser.js';
import { shipaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = 'SD000000001';
const DELIVERED = 'SD000000002';
const UNKNOWN = 'SD000000003';

type Row = Record<string, unknown>;
type Order = Row & { orderStory: (Row & { details: Row | null })[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Order;
const changed = (name: string, change: (order: Order) => void) => {
  const order = fixture(name);
  change(order);
  return order;
};
// A story row of the fixtures' shape, with another status, clock and details.
const status = (code: string, name: string, at: string, details: Row | null = null): Row & { details: Row | null } => ({ date: Date.parse(at), details, status: name, statusCode: code });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Shipa HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ShipaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' sd 000-000-001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SHIPA_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'X-Order-Story-Version': 'v2', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shipa', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivered story on its UTC instants and towns, with the courier’s reason, and none of the order’s people or places', () => {
    const result = parseShipa(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-12T06:41:15Z', delivered_at: '2026-05-12T06:41:15Z', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null, event.description])).toEqual([
      ['2026-05-12T06:41:15Z', '19', 'delivered', 'Dubai', 'Delivered'],
      ['2026-05-12T06:40:00Z', '18', 'out_for_delivery', 'Dubai', 'Arrived At Delivery Location'],
      ['2026-05-12T06:00:00Z', '17', 'out_for_delivery', 'Dubai', 'On The Way To Delivery Location'],
      ['2026-05-12T05:10:00Z', '16', 'out_for_delivery', 'Dubai', 'Out For Delivery'],
      // The rescheduling follows the attempt within a second; the attempt carries the stage.
      ['2026-05-11T10:05:31Z', '22', null, 'Dubai', 'Rescheduled'],
      ['2026-05-11T10:05:30Z', '82', 'failed_attempt', 'Dubai', 'Delivery Attempt Failed: Can\'t reach the Customer - No Answer'],
      ['2026-05-11T10:05:00Z', '18', 'out_for_delivery', 'Dubai', 'Arrived At Delivery Location'],
      ['2026-05-11T09:20:00Z', '17', 'out_for_delivery', 'Dubai', 'On The Way To Delivery Location'],
      ['2026-05-11T05:00:00Z', '16', 'out_for_delivery', 'Dubai', 'Out For Delivery'],
      ['2026-05-11T01:15:30Z', '12', 'in_transit', 'Dubai', 'Received By Destination Hub'],
      ['2026-05-10T19:00:00Z', '42', 'in_transit', 'Abu Dhabi', 'Received By Origin Hub'],
      ['2026-05-10T12:30:11Z', '13', null, null, 'Pending Delivery Confirmation'],
      ['2026-05-10T12:30:10Z', '11', 'accepted', 'Abu Dhabi', 'Pickup Completed'],
      ['2026-05-10T08:00:00Z', '1', 'registered', null, 'Order Created'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample|hub|600|example\.invalid|ARE|CHN|United Arab|00000000-|25\.1|55\.2/);
  });

  it('reads an import on its way, with the estimated day in the office’s country', () => {
    const result = parseShipa(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Received By Destination Hub',
      last_update: '2026-06-05T23:30:00Z', expected_delivery: '2026-06-07' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['12', 'in_transit', 'Sharjah'], ['43', 'in_transit', 'Dubai'], ['11', 'accepted', 'Dubai'], ['33', 'in_transit', null],
      ['30', 'customs', null], ['40', 'in_transit', null], ['36', 'in_transit', null], ['1', 'registered', null],
    ]);
    // The estimate is read where the office is: 20:30 UTC is the next day in Dubai, not yet in Kuwait.
    const late = (country: string) => parseShipa(changed('in-transit', (order) => {
      order.dropOffEstimatedTime = Date.parse('2026-06-07T20:30:00Z');
      order.subsidiaryCountry = country;
    }), IN_TRANSIT).expected_delivery;
    expect(late('United Arab Emirates')).toBe('2026-06-08');
    expect(late('Kuwait')).toBe('2026-06-07');
    // No estimate without the office's country, nor one behind the newest status.
    expect(late('Synthetic Land')).toBeNull();
    expect(parseShipa(changed('in-transit', (order) => { order.dropOffEstimatedTime = Date.parse('2026-06-05T14:00:00Z'); }), IN_TRANSIT)
      .expected_delivery).toBeNull();
    expect(parseShipa(changed('in-transit', (order) => { delete order.dropOffEstimatedTime; }), IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('reads a return, and a failed pickup as a problem', () => {
    const returned = parseShipa(changed('delivered', (order) => {
      order.orderStory.splice(-4, 4,
        status('20', 'Delivery Failed', '2026-05-12T06:41:15Z', { failReason: 'Merchant - Cancelled by Merchant', failReasonId: '44' }),
        status('23', 'Scheduled For Return', '2026-05-12T09:00:00Z', { returnType: 'To Origin', returnTypeId: 'origin' }),
        status('24', 'Out For Return', '2026-05-13T05:00:00Z'),
        status('25', 'Return Arrived', '2026-05-13T10:00:00Z'),
        status('26', 'Returned', '2026-05-13T10:00:20Z'));
      order.orderStatus = 'RETURNED';
    }), DELIVERED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned', expected_delivery: null });
    expect(returned).not.toHaveProperty('delivered_at');
    expect(returned.events!.slice(0, 5).map((event) => [event.stage, event.description])).toEqual([
      ['returned', 'Returned'], ['returned', 'Return Arrived'], ['returned', 'Out For Return'], ['returned', 'Scheduled For Return'],
      ['failed_attempt', 'Delivery Failed: Merchant - Cancelled by Merchant'],
    ]);
    const pickup = parseShipa(changed('in-transit', (order) => {
      order.orderStory.splice(1, 7,
        status('2', 'Pending Pickup Confirmation', '2026-06-01T10:00:01Z'),
        status('5', 'Out For Pickup', '2026-06-02T06:00:00Z', { carrier: { country: 'ARE', city: 'Dubai', name: 'Sample Driver' } }),
        status('8', 'Pickup Failed', '2026-06-02T09:00:00Z', { carrier: { country: 'ARE', city: 'Dubai', name: 'Sample Driver' },
          failReason: 'Rejected By customer - Customer Changed his/her mind.', failReasonId: '50' }));
    }), IN_TRANSIT);
    expect(pickup).toMatchObject({ status: 'exception', current_stage: 'exception',
      last_status_text: 'Pickup Failed: Rejected By customer - Customer Changed his/her mind' });
  });

  it('stages a code it does not know by its name, else leaves it and keeps the last staged status', () => {
    const named = parseShipa(changed('in-transit', (order) => { order.orderStory.push(status('99', 'Delivered to neighbour', '2026-06-06T08:00:00Z')); }), IN_TRANSIT);
    expect(named.events![0]).toMatchObject({ provider_code: '99', stage: 'delivered', stage_source: 'wording:language' });
    const unnamed = parseShipa(changed('in-transit', (order) => { order.orderStory.push(status('98', 'Synthetic status', '2026-06-06T08:00:00Z')); }), IN_TRANSIT);
    expect(unnamed).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic status', last_update: '2026-06-06T08:00:00Z' });
    expect(unnamed.events![0]).not.toHaveProperty('stage');
    // A story of follow-ups alone has no stage.
    expect(parseShipa(changed('in-transit', (order) => { order.orderStory = [status('13', 'Pending Delivery Confirmation', '2026-06-01T10:00:00Z')]; }), IN_TRANSIT))
      .toMatchObject({ status: 'unknown', last_status_text: 'Pending Delivery Confirmation' });
  });

  it('puts the story newest first by instant, keeping the reply’s order on one clock and dropping exact repeats', () => {
    const reversed = parseShipa(changed('delivered', (order) => { order.orderStory.reverse(); }), DELIVERED);
    expect(reversed.events!.map((event) => event.provider_code)).toEqual(parseShipa(fixture('delivered'), DELIVERED).events!.map((event) => event.provider_code));
    const tied = parseShipa(changed('in-transit', (order) => { order.orderStory.push(status('15', 'Scheduled For Delivery', '2026-06-05T23:30:00Z')); }), IN_TRANSIT);
    expect(tied.events!.slice(0, 2).map((event) => event.provider_code)).toEqual(['15', '12']);
    const repeated = parseShipa(changed('in-transit', (order) => { order.orderStory.push({ ...order.orderStory.at(-1)! }); }), IN_TRANSIT);
    expect(repeated.events).toHaveLength(8);
  });

  it('reads an order without a story as no history', () => {
    for (const story of [[], undefined, null]) {
      expect(() => parseShipa(changed('in-transit', (order) => { (order as Row).orderStory = story; }), IN_TRANSIT))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('reads the service’s own error as not found', () => {
    expect(() => parseShipa(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('counts an order only when it names the number asked', () => {
    expect(() => parseShipa(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Shipa answered for another order' }));
    expect(parseShipa(changed('in-transit', (order) => { order.barcode = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(8);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (order: Order) => { delete order.barcode; },
      (order: Order) => { order.barcode = 1; },
      (order: Order) => { (order as Row).orderStory = 'story'; },
      (order: Order) => { order.orderStory = Array.from({ length: 501 }, () => order.orderStory[0]!); },
      (order: Order) => { order.orderStory[0] = 'row' as never; },
      (order: Order) => { order.orderStory[0]!.statusCode = null; },
      (order: Order) => { order.orderStory[0]!.statusCode = 'A1'; },
      (order: Order) => { order.orderStory[0]!.status = ' '; },
      (order: Order) => { order.orderStory[0]!.date = '2026-06-01T10:00:00Z'; },
      (order: Order) => { order.orderStory[0]!.date = 1_000_000; },
      (order: Order) => { order.orderStory[0]!.details = 'details' as never; },
    ]) {
      expect(() => parseShipa(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [null, [], 'order']) {
      expect(() => parseShipa(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refused key, a browser check, a rate limit and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // Only the service's own code is an unknown order: another 404 or a missing method is a moved route.
    await expect(lookup({ code: 0, message: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ code: 14002, message: 'Service method not found', errorData: {} }, { status: 400 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://tracking.shipadelivery.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ code: 2002, message: 'Unable to identify the application. Make sure application ID and API key are correct', errorData: {} },
      { status: 401 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ code: 0, message: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '5' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 5000 });
    await expect(lookup('', { status: 429 })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: undefined });
    await expect(lookup('<html><title>Shipa</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('null')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (code, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: code }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers Shipa Delivery does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SD00000001', 'SD0000000011', 'SA000000001', '000000000001', `SD${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeShipaNumber('sd 000-000-002')).toBe(DELIVERED);
  });

  it('retries a read that fails to reach the service once, within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a Shipa Delivery number to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'shipa', source: 'shipa', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${SHIPA_API}${DELIVERED}`)).toBe(true);
  });
});

describe('Shipa numbers', () => {
  it('selects Shipa for SD and nine digits', () => {
    expect(detectCarrierMatch(DELIVERED).carrier).toBe('shipa');
  });
});

describe('Shipa status vocabulary', () => {
  it('records every Shipa Delivery status code the map knows with the stage it gives', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage?: string }[];
    // The ecommerce API's dotted event codes belong to another Shipa service, which this adapter does not read.
    for (const entry of entries.filter((item) => item.code && /^\d+$/.test(item.code))) {
      expect(statusMap.stage(entry.code!, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(shipaStage(entry.code!, entry.wording), entry.wording).toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
    }
    expect(statusMapAnswer({ carrier: 'shipa', providerCode: '82', description: 'Delivery Attempt Failed: Can\'t reach the Customer - No Answer' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'shipa', providerCode: '22', description: 'Rescheduled' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'shipa', providerCode: '98', description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
    expect(shipaStage('98', 'Synthetic status')).toBeNull();
  });
});
