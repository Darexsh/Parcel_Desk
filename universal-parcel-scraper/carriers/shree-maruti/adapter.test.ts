import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SHREE_MARUTI_API, ShreeMarutiTracker } from './adapter.js';
import { normalizeShreeMarutiNumber, parseShreeMaruti } from './parser.js';
import { shreeMarutiReading, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '99000000000011';
const IN_TRANSIT = '99000000000022';
const UNKNOWN = '99000000000033';

type Row = Record<string, unknown>;
type Reply = { orderInformation: Row | null; statuses: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
/** The lookup, answering each number from `bodies` and anything else as unknown. */
const service = (bodies: Record<string, unknown>) => vi.fn<typeof fetch>(async (input) => {
  const number = String(input).slice(SHREE_MARUTI_API.length);
  return json(bodies[number] ?? fixture('not-found'));
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseShreeMaruti>) => result.events!.map((event) =>
  [event.time ?? event.local_time, event.provider_code, event.stage ?? null, event.location ?? null, event.description]);
/** A row of the in-transit history at another clock, stored when `storedAt` says. */
const atClock = (row: Row, clock: string, storedAt: string, extra: Row = {}) => ({ ...row, ...extra, statusTimestamp: Date.parse(clock),
  createdAt: storedAt, updatedAt: storedAt });

describe('Shree Maruti HTTP adapter', () => {
  it('asks the tracker’s lookup for the whole number through the supplied transport', async () => {
    const fetcher = service({ [IN_TRANSIT]: fixture('in-transit') });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new ShreeMarutiTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' 9900 0000-0000 22 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(`https://apis-hubops.innofulfill.com/tracking/v2/${IN_TRANSIT}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shree-maruti', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history as the tracker shows it, without the rows it hides or anyone’s details', () => {
    const result = parseShreeMaruti(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-03T15:15:20+05:30', delivered_at: '2026-03-03T15:15:20+05:30' });
    expect(rows(result)).toEqual([
      ['2026-03-03T15:15:20+05:30', 'delivered', 'delivered', null, 'Delivered'],
      // A copy imported weeks later holds the courier's wall clock stored as UTC, kept without an offset.
      ['2026-03-03T15:12:40', 'delivered', 'delivered', 'SAMPLE TOWN', 'Delivered'],
      ['2026-03-03T10:50:10+05:30', 'out_for_delivery', 'out_for_delivery', 'SAMPLE TOWN', 'Out For Delivery'],
      // The placeholder location `default` is no place.
      ['2026-03-03T09:30:00+05:30', 'inscanned_at_cp', 'in_transit', null, 'In Transit'],
      ['2026-03-03T07:45:30+05:30', 'inscan_at_hub', 'in_transit', 'SAMPLE TOWN HUB', 'In Transit'],
      // Two rows at one moment come in the order the service stored them.
      ['2026-03-02T21:10:00+05:30', 'outscan_at_hub', 'in_transit', 'SAMPLE CITY HUB', 'In Transit'],
      ['2026-03-02T21:10:00+05:30', 'outscan_to_cp', 'in_transit', 'SAMPLE CITY HUB', 'In Transit'],
      ['2026-03-02T17:40:05+05:30', 'inscan_at_hub', 'in_transit', 'SAMPLE CITY HUB', 'In Transit'],
      // The dispatch row's location is the sender's address.
      ['2026-03-02T11:00:00+05:30', 'ready_for_dispatch', 'registered', null, 'Ready For Dispatch'],
      ['2026-03-02T11:00:00+05:30', 'order_confirmed', 'registered', 'SAMPLE CITY', 'Shipment Confirmed'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE (?:AGENT|RECIPIENT|SENDER|ROAD|AREA|LANE|MARKET)|0000000000|example\.com|00000[12]|softdata|updated/i);
  });

  it('reads an in-transit history, with the hub system’s rows filed under its own number field', () => {
    const result = parseShreeMaruti(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In Transit',
      last_update: '2026-04-11T08:35:00+05:30' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(rows(result).map(([, code, , location]) => [code, location])).toEqual([
      ['inscan_at_hub', 'SAMPLE TOWN HUB'], ['outscan_at_hub', 'SAMPLE CITY HUB'], ['inscan_at_hub', 'SAMPLE CITY HUB'],
      ['ready_for_dispatch', null], ['order_confirmed', 'SAMPLE CITY'],
    ]);
  });

  it('dates rows stored within two days of their clock at it, and keeps the digits of later copies as Indian wall clocks', () => {
    const result = parseShreeMaruti(changed('in-transit', (reply) => {
      const [newest] = reply.statuses;
      reply.statuses.unshift(
        // Stored five minutes before its clock, as a fast device clock would: an instant.
        atClock(newest!, '2026-04-12T06:00:00Z', '2026-04-12T05:55:00.000Z', { status: 'delivered', category: 'DELIVERED' }),
        // Stored a day and a half after its clock, as a device syncing late would: an instant.
        atClock(newest!, '2026-04-11T05:00:00Z', '2026-04-12T17:00:00.000Z', { status: 'out_for_delivery', category: 'OUT_FOR_DELIVERY' }),
        // Copied in weeks later: a wall clock without an offset, ordered as India's.
        atClock(newest!, '2026-04-11T10:00:00Z', '2026-05-20T10:00:00.000Z', { status: 'undelivered', category: 'UNDELIVERED' }),
        // Stored hours before its clock, which no instant can be.
        atClock(newest!, '2026-04-11T09:00:00Z', '2026-04-11T04:00:00.000Z', { status: 'on_hold', category: 'ON_HOLD' }),
      );
      // A row without its record time is read as the tracker reads it.
      delete reply.statuses.at(-1)!.createdAt;
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 5).map((event) => [event.time ?? null, event.local_time ?? null, event.provider_code])).toEqual([
      ['2026-04-12T11:30:00+05:30', null, 'delivered'],
      ['2026-04-11T10:30:00+05:30', null, 'out_for_delivery'],
      [null, '2026-04-11T10:00:00', 'undelivered'],
      [null, '2026-04-11T09:00:00', 'on_hold'],
      ['2026-04-11T08:35:00+05:30', null, 'inscan_at_hub'],
    ]);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2026-04-12T11:30:00+05:30',
      delivered_at: '2026-04-12T11:30:00+05:30' });
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-04-10T11:30:00+05:30', provider_code: 'ready_for_dispatch' });
  });

  it('gives a history whose newest row is a copy a local clock and no delivery instant', () => {
    const result = parseShreeMaruti(changed('delivered', (reply) => {
      reply.statuses = reply.statuses.filter((row) => !(row.status === 'delivered' && row.location === undefined));
    }), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-03-03T15:12:40' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events![1]).toMatchObject({ time: '2026-03-03T10:50:10+05:30', provider_code: 'out_for_delivery' });
  });

  it('gives an attempt, a hold or a return the reason the tracker shows, without phone numbers', () => {
    const result = parseShreeMaruti(changed('in-transit', (reply) => {
      const [newest] = reply.statuses;
      reply.statuses.unshift(
        atClock(newest!, '2026-04-12T06:00:00Z', '2026-04-12T06:00:01.000Z', { status: 'rto_delivered', event: 'rto_delivered',
          category: 'RTO_DELIVERED' }),
        atClock(newest!, '2026-04-12T04:00:00Z', '2026-04-12T04:00:01.000Z', { status: 'inscan_at_hub', movement_type: 'rto' }),
        atClock(newest!, '2026-04-11T12:00:00Z', '2026-04-11T12:00:01.000Z', { status: 'on_hold', event: 'Customer refused, call 000 000 0000' }),
        atClock(newest!, '2026-04-11T10:00:00Z', '2026-04-11T10:00:01.000Z', { status: 'undelivered', event: 'CONSIGNEE_NOT_AVAILABLE' }),
      );
    }), IN_TRANSIT);
    expect(rows(result).slice(0, 4).map(([, code, stage, , description]) => [code, stage, description])).toEqual([
      ['rto_delivered', 'returned', 'Returned To Sender'],
      // A movement on the way back is part of the return.
      ['inscan_at_hub', 'returned', 'Return In Transit'],
      ['on_hold', 'exception', 'On Hold: Customer refused, call'],
      ['undelivered', 'failed_attempt', 'Delivery Attempted: Consignee not available'],
    ]);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned' });
  });

  it('reads an unknown code as the tracker does: by its category, its shape or its words', () => {
    expect(shreeMarutiReading('synthetic_code', 'out_for_delivery', '')).toEqual({ label: 'Out For Delivery',
      staged: { stage: 'out_for_delivery', source: 'carrier_map' }, movement: false });
    expect(shreeMarutiReading('bag_manifested', '', '')).toMatchObject({ label: 'In Transit', staged: { stage: 'in_transit' }, movement: true });
    expect(shreeMarutiReading('partner_delivered', '', '')).toMatchObject({ label: 'Delivered', staged: { stage: 'delivered' } });
    expect(shreeMarutiReading('rto_partner_delivered', '', '')).toMatchObject({ label: 'Rto Partner Delivered', staged: { stage: 'returned' } });
    expect(shreeMarutiReading('synthetic_code', 'synthetic', 'Shipment returned to shipper'))
      .toMatchObject({ label: 'Synthetic Code', staged: { stage: 'returned', source: expect.stringMatching(/^wording:/) } });
    expect(shreeMarutiReading('synthetic_code', '', '')).toEqual({ label: 'Synthetic Code', staged: null, movement: false });
    expect(shreeMarutiReading('rto_revoked', '', '')).toEqual({ label: 'Return Cancelled', staged: null, movement: false });
  });

  it('reads an empty answer as not found, and an order without rows as inconclusive', () => {
    expect(() => parseShreeMaruti([], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseShreeMaruti({ orderInformation: null, statuses: [] }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseShreeMaruti(changed('delivered', (reply) => { reply.statuses = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseShreeMaruti(changed('delivered', (reply) => {
      reply.statuses = reply.statuses.filter((row) => row.status === 'softdata_update');
    }), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('keeps only rows that name the number asked', () => {
    expect(() => parseShreeMaruti(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Shree Maruti answered for another shipment' }));
    // Rows filed under a shorter or longer number are another shipment's.
    const other = (reply: Reply, id: string) => {
      reply.orderInformation = null;
      for (const row of reply.statuses) Object.assign(row, { trackingId: id, ...(row.cAwbNumber ? { cAwbNumber: id } : {}),
        ...(row.smileAwbNumber ? { smileAwbNumber: id } : {}) });
    };
    expect(() => parseShreeMaruti(changed('in-transit', (reply) => other(reply, IN_TRANSIT.slice(0, 11))), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseShreeMaruti(changed('in-transit', (reply) => other(reply, `${IN_TRANSIT}0`)), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = parseShreeMaruti(changed('in-transit', (reply) => {
      reply.statuses.unshift({ ...reply.statuses[1]!, trackingId: UNKNOWN, cAwbNumber: UNKNOWN, smileAwbNumber: UNKNOWN,
        statusTimestamp: Date.parse('2026-04-12T00:00:00Z'), status: 'delivered', category: 'DELIVERED' });
    }), IN_TRANSIT);
    expect(mixed).toMatchObject({ current_stage: 'in_transit' });
    expect(mixed.events).toHaveLength(5);
    // The order alone, without rows of its own, is still the number's.
    expect(() => parseShreeMaruti(changed('in-transit', (reply) => {
      for (const row of reply.statuses) Object.assign(row, { trackingId: '', cAwbNumber: '', smileAwbNumber: '' });
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A numeric identifier still names the number.
    expect(parseShreeMaruti(changed('in-transit', (reply) => {
      reply.orderInformation!.trackingId = Number(IN_TRANSIT);
    }), IN_TRANSIT).events).toHaveLength(5);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (reply: Reply) => { (reply as Row).statuses = 'scans'; },
      (reply: Reply) => { delete (reply as Row).statuses; },
      (reply: Reply) => { (reply as Row).orderInformation = 'order'; },
      (reply: Reply) => { reply.statuses = Array.from({ length: 501 }, () => reply.statuses[0]!); },
      (reply: Reply) => { reply.statuses[0] = 'scan' as never; },
      (reply: Reply) => { reply.statuses[0]!.statusTimestamp = '2026-03-03 15:12:40'; },
      (reply: Reply) => { reply.statuses[0]!.statusTimestamp = 1772551360.5; },
      (reply: Reply) => { reply.statuses[0]!.statusTimestamp = 1772551360; },
      (reply: Reply) => { delete reply.statuses[0]!.statusTimestamp; },
      (reply: Reply) => { reply.statuses[0]!.status = ['delivered']; },
      (reply: Reply) => { reply.statuses[0]!.status = ''; },
    ]) {
      expect(() => parseShreeMaruti(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseShreeMaruti([{ trackingId: DELIVERED }], DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseShreeMaruti('[]', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The tracker also reads a clock written as digits.
    expect(parseShreeMaruti(changed('delivered', (reply) => {
      reply.statuses[2]!.statusTimestamp = String(reply.statuses[2]!.statusTimestamp);
    }), DELIVERED)).toMatchObject({ delivered_at: '2026-03-03T15:15:20+05:30' });
  });

  it('keeps an unknown number, a moved route, a refusal, a rate limit, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>(async () => response())).track({ number: UNKNOWN });
    await expect(lookup(() => json([]))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => json({ orderInformation: null, statuses: [] }))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => json({ error: 'Not Found', statusCode: 404 }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('', { status: 302, headers: { Location: 'https://shreemaruti.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json('Too many requests, please try again later.', { status: 429, headers: { 'Retry-After': '42' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 42_000 });
    await expect(lookup(() => json('Too many requests', { status: 429, headers: { 'X-RateLimit-Reset': '17' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 17_000 });
    await expect(lookup(() => new Response('<html><title>403 Forbidden</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response('<html><title>Just a moment...</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json('<html><title>SMILe</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(''))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(fixture('delivered')))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number by its newest scan and an unknown one by the empty answer', async () => {
    const fetcher = service({ [DELIVERED]: fixture('delivered') });
    const shreeMaruti = carrier(fetcher);
    await expect(shreeMaruti.recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-03T09:45:20.000Z' });
    await expect(shreeMaruti.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(shreeMaruti.recognize!('9900000000001')).resolves.toEqual({ known: false });
    await expect(shreeMaruti.recognize!('99000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Shree Maruti does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['99000000001', '990000000000111', 'SM9900000000011', '9900000000001A', `9${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeShreeMarutiNumber('9900 0000 0000 11')).toBe(DELIVERED);
    expect(normalizeShreeMarutiNumber('990000000001')).toBe('990000000001');
  });

  it('tries once more after a failed connection, and ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    let calls = 0;
    const flaky = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return json(fixture('delivered'));
    });
    await clock.settle(expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' }));
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under Shree Maruti to the adapter', async () => {
    const fetcher = service({ [DELIVERED]: fixture('delivered') });
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'shree-maruti' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'shree-maruti', source: 'shree-maruti', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${SHREE_MARUTI_API}${DELIVERED}`)).toBe(true);
  });
});

describe('Shree Maruti numbers', () => {
  it('leaves bare digit runs to other carriers’ rules, so only a number filed under Shree Maruti reaches it', () => {
    for (const number of [DELIVERED, '990000000001', '9900000000001', '25000000000001']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('shree-maruti');
      expect(recognitionAskedCarriers(number), number).not.toContain('shree-maruti');
    }
  });
});

describe('Shree Maruti status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(shreeMarutiReading(entry.code, '', '').staged?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'shree-maruti', providerCode: 'out_for_delivery', description: 'Out For Delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'shree-maruti', providerCode: 'rto_revoked', description: 'Return Cancelled' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'shree-maruti', providerCode: 'synthetic_code', description: 'Synthetic Code' })).toEqual({ kind: 'unknown' });
  });
});
