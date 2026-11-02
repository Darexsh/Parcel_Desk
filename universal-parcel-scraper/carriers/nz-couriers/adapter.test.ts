import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NZ_COURIERS_API, NzCouriersTracker } from './adapter.js';
import { nzCouriersQuery, parseNzCouriers } from './parser.js';
import { nzCouriersStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '00000000000000000017';
const IN_TRANSIT = 'ZZ 01234567';
const UNKNOWN = '00000000000000000000';
const CUSTOMER = 'ZZZZ012345';

type Row = Record<string, unknown>;
type Item = Row & { trackingEvents: Row[] };
type Reply = Row & { consignmentItems: Item[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply, scans: Row[]) => void) => {
  const reply = fixture(name);
  change(reply, reply.consignmentItems[0]!.trackingEvents);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const empty = () => new Response(null, { status: 204 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const VALIDATION = { errors: { query: ['The field query must be a string or array type with a minimum length of \'6\'.'] },
  type: 'https://httpstatuses.com/400', title: 'REQUEST_VALIDATION_ERROR', status: 400 };

describe('New Zealand Couriers HTTP adapter', () => {
  it('asks the tracking page’s lookup once for a ticket’s product code and number, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NzCouriersTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch('zz-01234567', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    // The page drops the ticket number's leading zeros.
    expect(String(url)).toBe(`${NZ_COURIERS_API}?searchType=TK&ticketProductCode=ZZ&query=1234567`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'nz-couriers', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('asks for a label alone, without its leading zeros unless it is an SSCC', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => empty());
    for (const number of ['01234567', '123456789', DELIVERED, 'E00 1234567', 'ZZZ 123456']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(fetcher.mock.calls.map(([url]) => String(url).slice(NZ_COURIERS_API.length))).toEqual([
      '?query=1234567',
      '?query=123456789',
      `?query=${DELIVERED}`,
      '?searchType=TK&ticketProductCode=E00&query=1234567',
      '?searchType=TK&ticketProductCode=ZZZ&query=123456',
      // A ticket the lookup does not hold may be a customer printed label's consignment number.
      '?query=ZZZ123456',
    ]);
  });

  it('asks a number a ticket and a consignment number both fit as the ticket, then whole, in one step', async () => {
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(reply(changed('delivered', (body) => { body.shortConsignmentId = '0000000 ZZZ123456'; })));
    await expect(new NzCouriersTracker({ fetcher, recorder }).fetch('ZZZ 123456')).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url).slice(NZ_COURIERS_API.length)))
      .toEqual(['?searchType=TK&ticketProductCode=ZZZ&query=123456', '?query=ZZZ123456']);
    expect(recorder.step).toHaveBeenCalledTimes(1);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'direct', outcome: 'ok' }));
    // A ticket too short for the lookup once its zeros go is asked whole alone.
    const whole = vi.fn<typeof fetch>().mockImplementation(async () => empty());
    await expect(carrier(whole).track({ number: 'ZZ 0012345' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(whole.mock.calls.map(([url]) => String(url).slice(NZ_COURIERS_API.length))).toEqual(['?query=ZZ0012345']);
  });

  it('asks for a customer printed label’s consignment number whole, and reads the consignment the sender’s account heads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(changed('delivered', (body) => { body.shortConsignmentId = `0000000 ${CUSTOMER}`; })));
    await expect(carrier(fetcher).track({ number: 'zzzz-012345' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${NZ_COURIERS_API}?query=${CUSTOMER}`);
  });

  it('keeps the delivery by the rural partner without the signatory, the photo, the tag or the postcode', () => {
    const result = parseNzCouriers(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery (3rd Party)', last_update: '2026-03-13T02:00:57.908Z', delivered_at: '2026-03-13T02:00:57.908Z',
      expected_delivery: null });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-03-13T02:00:57.908Z', '3P/D', 'delivered', 'Sample Valley, Sample District'],
      // New Zealand Couriers' own delivery scan hands the parcel to the partner.
      ['2026-03-10T23:23:49.770Z', 'D', 'in_transit', 'Sample Hills, Sample District'],
      ['2026-03-10T21:43:24.652Z', 'ONBD', 'out_for_delivery', null],
      // The repeated notice is kept once.
      ['2026-03-10T16:41:24.777Z', 'STAT/RZDEL', 'in_transit', 'Sample Hills North, Sample District'],
      ['2026-03-09T05:12:40Z', 'P', 'accepted', 'Sample Park, Sample City'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Signer|example\.invalid|A0000000000|0000"|SAMPLETON|SMH|00-000|barcode|New Zealand"/);
  });

  it('keeps every parcel’s scans together, with the estimate, and shows a label only when its parcel’s history opens', () => {
    const result = parseNzCouriers(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Item Sent for Redelivery', last_update: '2026-02-19T23:49:21.460Z', expected_delivery: '2026-02-20' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['STAT/REDEL', 'in_transit', 'Item Sent for Redelivery'],
      // Held at the freight office: whether for collection or another delivery is not said.
      ['STAT/HLDFR8', null, 'Held Freight Office'],
      ['NOND/CARD', 'failed_attempt', 'Unable to deliver, please visit our card left page'],
      ['ONBD', 'out_for_delivery', 'Out for Delivery'],
      ['NOND/RCLOS', 'failed_attempt', 'Non-Delivery'],
      ['ONBD', 'out_for_delivery', 'Out for Delivery'],
      ['P', 'accepted', 'Picked Up'],
      ['P', 'accepted', 'Picked Up'],
      ['LC', 'registered', 'Label Created'],
    ]);
    expect(result.events!.filter((event) => event.description === 'Label Created')).toHaveLength(1);
  });

  it('dates the estimate from the parcel’s first scan, across a new year, and only when its weekday agrees', () => {
    const atNewYear = (eta: unknown) => parseNzCouriers(changed('in-transit', (body) => {
      body.ETA = eta;
      body.consignmentItems = [{ ...body.consignmentItems[0]!, trackingEvents: body.consignmentItems[0]!.trackingEvents.map((scan, index) =>
        ({ ...scan, createdOn: `2026-12-${String(28 + Math.floor(index / 3)).padStart(2, '0')}T0${index}:00:00Z` })) }];
    }), IN_TRANSIT).expected_delivery;
    expect(atNewYear('Monday, 4 January')).toBe('2027-01-04');
    expect(atNewYear('Tuesday, 29 December')).toBe('2026-12-29');
    expect(atNewYear('Sunday, 4 January')).toBeNull();
    expect(atNewYear('4 January')).toBeNull();
    expect(atNewYear('')).toBeNull();
    expect(atNewYear(null)).toBeNull();
    expect(() => atNewYear(20260104)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('names another Freightways network that scanned the parcel last as its delivery carrier', () => {
    const result = parseNzCouriers(changed('delivered', (_body, scans) => { scans.at(-1)!.carrierName = 'PostHaste'; }), DELIVERED);
    expect(result.delivery_carrier).toBe('post-haste');
    expect(parseNzCouriers(changed('delivered', (_body, scans) => { scans.at(-1)!.carrierName = 'NZCouriers'; }), DELIVERED))
      .not.toHaveProperty('delivery_carrier');
  });

  it('counts a consignment only when it names the whole number asked', () => {
    // The ticket number may come with or without its leading zeros.
    expect(parseNzCouriers(changed('in-transit', (body) => { body.shortConsignmentId = 'zz 1234567'; }), 'ZZ01234567').events).toHaveLength(9);
    expect(parseNzCouriers(changed('in-transit', (body) => { body.shortConsignmentId = 'ZZ  01234567'; }), 'ZZ1234567').events).toHaveLength(9);
    for (const [shortId, number] of [
      ['ZY 01234567', IN_TRANSIT],
      ['ZZ 01234568', IN_TRANSIT],
      ['ZZ', IN_TRANSIT],
      ['01234567', IN_TRANSIT],
      // A customer printed label whose consignment number is the label asked.
      ['0000000 01234567', '01234567'],
      ['ZZ 01234567', '01234567'],
      ['10000000000000000017', DELIVERED],
      ['0000000000000000017', DELIVERED],
    ] as const) {
      expect(() => parseNzCouriers(changed('in-transit', (body) => { body.shortConsignmentId = shortId; }), number), shortId)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'New Zealand Couriers answered for another consignment' }));
    }
    expect(parseNzCouriers(changed('delivered', (body) => { body.shortConsignmentId = '1234567'; }), '01234567').events).toHaveLength(5);
  });

  it('counts a customer printed label only when its consignment number is the whole number asked', () => {
    // The sender's account is digits, or letters and digits.
    for (const shortId of [`0000000 ${CUSTOMER}`, `ZZZZZZ0 ${CUSTOMER}`, CUSTOMER.toLowerCase(), ` 0000000  ${CUSTOMER} `]) {
      expect(parseNzCouriers(changed('delivered', (body) => { body.shortConsignmentId = shortId; }), CUSTOMER).events, shortId).toHaveLength(5);
    }
    for (const shortId of ['0000000 ZZZZ12345', '0000000 ZZZZ0123456', 'ZZZZ 012345', '0000000', `ZZ-00000 ${CUSTOMER}`,
      `0000000 0000000 ${CUSTOMER}`, `0000000 ${CUSTOMER} 1`]) {
      expect(() => parseNzCouriers(changed('delivered', (body) => { body.shortConsignmentId = shortId; }), CUSTOMER), shortId)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'New Zealand Couriers answered for another consignment' }));
    }
  });

  it('reads a consignment without scans as no history', () => {
    expect(() => parseNzCouriers(changed('delivered', (body) => { body.consignmentItems[0]!.trackingEvents = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseNzCouriers(changed('delivered', (body) => { body.consignmentItems = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.shortConsignmentId; },
      (body: Reply) => { body.shortConsignmentId = ['ZZ', '01234567']; },
      (body: Reply) => { delete (body as Row).consignmentItems; },
      (body: Reply) => { body.consignmentItems = 'parcels' as never; },
      (body: Reply) => { body.consignmentItems[0] = 'parcel' as never; },
      (body: Reply) => { delete (body.consignmentItems[0] as Row).trackingEvents; },
      (body: Reply) => { body.consignmentItems[0]!.trackingEvents = Array.from({ length: 501 }, () => body.consignmentItems[0]!.trackingEvents[0]!); },
      (_body: Reply, scans: Row[]) => { scans[0] = 'scan' as never; },
      (_body: Reply, scans: Row[]) => { delete scans[0]!.eventType; },
      (_body: Reply, scans: Row[]) => { scans[0]!.status = ''; },
      (_body: Reply, scans: Row[]) => { scans[0]!.status = ['Picked Up']; },
      (_body: Reply, scans: Row[]) => { scans[0]!.createdOn = '2026-02-16T03:43:41'; },
      (_body: Reply, scans: Row[]) => { scans[0]!.createdOn = '16/02/2026 16:43'; },
      (_body: Reply, scans: Row[]) => { scans[0]!.eventSubType = 7; },
      (_body: Reply, scans: Row[]) => { scans[0]!.location = 'Sample Park'; },
      (_body: Reply, scans: Row[]) => { (scans[0]!.location as Row).suburb = 7; },
    ]) {
      expect(() => parseNzCouriers(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseNzCouriers('consignment', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(empty())).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from the empty 204 reply: a 404 or a redirect is a moved route.
    await expect(lookup({ message: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://nzcouriers.co.nz/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(VALIDATION, { status: 400 })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup('<html><title>Bad Request</title></html>', { status: 400 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script src="https://sample.awswaf.com/challenge.js"></script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>New Zealand Couriers</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('declares no recognition', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('rejects numbers the tracker does not read and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00000000', '000000000', 'ZZ 0000000', 'ZZ12345', 'ZZZZ123', 'ZZZZ000000', 'ZZZZZZZ012345', 'ZZ012345678', 'ZZZ123456789', 'ZZ1234567890123',
      'ZZ123456785ZZ', '1234567', '1234567890', '0000000 01234567', '00000000000000000011', '10000000000000000017', 'SAMPLETRACKING',
      `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(nzCouriersQuery('zz-01234567')).toEqual({ kind: 'ticket', number: 'ZZ01234567', code: 'ZZ', query: '1234567' });
    expect(nzCouriersQuery('e60 1234567')).toEqual({ kind: 'ticket', number: 'E601234567', code: 'E60', query: '1234567' });
    expect(nzCouriersQuery('0123 4567')).toEqual({ kind: 'label', number: '01234567', query: '1234567' });
    expect(nzCouriersQuery('zzzz 012345')).toEqual({ kind: 'consignment', number: CUSTOMER, query: CUSTOMER });
    // Two or three letters and up to eight digits are a ticket's layout.
    expect(nzCouriersQuery('ZZZ123456')).toMatchObject({ kind: 'ticket', code: 'ZZZ', query: '123456' });
    expect(nzCouriersQuery('ZZZZZ01234567')).toEqual({ kind: 'consignment', number: 'ZZZZZ01234567', query: 'ZZZZZ01234567' });
  });

  it('gives its one read the whole budget and ends a hanging read inside it', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under New Zealand Couriers to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'nz-couriers' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'nz-couriers', source: 'nz-couriers', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(NZ_COURIERS_API))).toBe(true);
  });
});

describe('New Zealand Couriers status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (!entry.code) continue;
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(nzCouriersStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'nz-couriers', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(nzCouriersStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'nz-couriers', providerCode: 'NOND/CARD', description: 'Unable to deliver, please visit our card left page' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'nz-couriers', providerCode: 'ZZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Another non-delivery reason is still a failed attempt; a code the map does not know falls to the shared wording rules.
    expect(nzCouriersStage('NOND/ZZZ', 'Non-Delivery')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(nzCouriersStage('ZZZ', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(nzCouriersStage('ZZZ', 'Synthetic note')).toBeNull();
    expect(nzCouriersStage('d', 'Delivered by courier or branch')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
  });
});
