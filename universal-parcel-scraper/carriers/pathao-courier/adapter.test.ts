import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PATHAO_API, PathaoCourierTracker } from './adapter.js';
import { normalizePathaoNumber, parsePathaoCourier, pathaoWording } from './parser.js';
import { pathaoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'DA100526SMPL01';
const IN_TRANSIT = 'DB110526SMPL02';
const RETURNED = 'DC090526SMPL03';
const UNKNOWN = 'DZ010126SMPL00';

type Row = Record<string, unknown>;
type Data = { order: Row; state: Row; log: Row[] };
type Reply = Row & { data: Data };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Data, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (desc: string, createdAt: string, group: string) => ({ desc, created_at: createdAt, notes: '', grouped_status: [group, group, 4, 1] });

describe('Pathao Courier HTTP adapter', () => {
  it('posts the whole ID in capitals, without a phone number, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PathaoCourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' db11-0526-smpl02 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(PATHAO_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ consignment_id: IN_TRANSIT });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pathao-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history at Bangladesh’s offset, newest first, without the riders, the notes or the order’s details', () => {
    const result = parsePathaoCourier(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered.', last_update: '2026-05-12T14:15:00+06:00', delivered_at: '2026-05-12T14:15:00+06:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.description])).toEqual([
      // The delivery the reply lists twice is kept once.
      ['2026-05-12T14:15:00+06:00', 'Delivered', 'delivered', 'Delivered.'],
      ['2026-05-12T11:51:00+06:00', 'Ready For Delivery', 'out_for_delivery', 'Assigned for delivery.'],
      ['2026-05-12T11:10:00+06:00', 'Ready For Delivery', 'in_transit', 'Order has been reached at delivery hub'],
      ['2026-05-12T05:32:00+06:00', 'In-Transit', 'in_transit', 'Dispatched from Central Processing OSD.'],
      ['2026-05-11T15:49:00+06:00', 'In-Transit', 'in_transit', 'Dispatched from Sample Central Hub.'],
      // Scans in the same minute keep the order the reply lists them in.
      ['2026-05-11T15:05:00+06:00', 'Picked', 'accepted', 'Received at pickup hub: Sample Central Hub.'],
      ['2026-05-11T15:05:00+06:00', 'Accepted', 'registered', 'Order weight has been updated from 0.5kg to 1kg'],
      ['2026-05-11T10:05:00+06:00', 'Accepted', 'registered', 'Order has been assigned for pickup'],
      ['2026-05-10T21:40:00+06:00', 'Accepted', 'registered', 'Order confirmed.'],
      ['2026-05-10T21:15:00+06:00', 'Accepted', 'registered', 'Pickup requested.'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined && event.location === undefined))
      .toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Rider|Pickup Rider|item)|01000000000|Amount Collected|1250|23\.000000|hermes|Cash/);
  });

  it('reads a parcel on its way with the delivery window the reply gives', () => {
    const result = parsePathaoCourier(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Dispatched from Central Processing OSD.', last_update: '2026-05-13T05:32:00+06:00',
      expected_delivery_from: '2026-05-14', expected_delivery: '2026-05-15' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toHaveLength(5);
  });

  it('reads the window as a day or across a month or a year, and drops a stale, unreadable or finished one', () => {
    const window = (value: unknown, change: (data: Data) => void = () => {}) => {
      const result = parsePathaoCourier(changed('in-transit', (data) => { data.order.estimated_date = value; change(data); }), IN_TRANSIT);
      return [result.expected_delivery_from ?? null, result.expected_delivery ?? null];
    };
    expect(window('May 31-Jun 1, 2026')).toEqual(['2026-05-31', '2026-06-01']);
    expect(window('Dec 31-Jan 1, 2027')).toEqual(['2026-12-31', '2027-01-01']);
    expect(window('May 14, 2026')).toEqual([null, '2026-05-14']);
    expect(window('May 13-13, 2026')).toEqual([null, '2026-05-13']);
    // A window that ended before the newest scan's day is stale.
    expect(window('May 11-12, 2026')).toEqual([null, null]);
    for (const value of ['', 'Soon', 'May 32-33, 2026', 'Feb 30-31, 2026', '2026-05-14', null]) {
      expect(window(value), String(value)).toEqual([null, null]);
    }
    expect(window('May 14-15, 2026', (data) => { data.state.name = 'Delivered'; })).toEqual([null, null]);
  });

  it('stages a rider’s assignment at the delivery hub as out for delivery', () => {
    const result = parsePathaoCourier(changed('in-transit', (data) => {
      data.log.push(scan('Order has been reached at delivery hub', 'May 13, 2026 11:10 AM', 'Ready For Delivery'),
        scan('Order has been assigned to (Sample Rider-01000000001) for delivery', 'May 13, 2026 11:51 AM', 'Ready For Delivery'));
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Order has been assigned for delivery', last_update: '2026-05-13T11:51:00+06:00' });
  });

  it('reads a return, with the hold before it, from the older wording', () => {
    const result = parsePathaoCourier(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Your order has been Return.', last_update: '2026-05-12T18:13:00+06:00', expected_delivery: null });
    expect(result.events!.slice(0, 4).map((event) => [event.provider_code, event.stage, event.description])).toEqual([
      ['Return', 'returned', 'Your order has been Return.'],
      ['Ready For Delivery', 'out_for_delivery', 'Our Deliver man has picked-up you order for Delivery'],
      ['On Hold', 'exception', 'Your order is being held at Delivery hub'],
      ['Ready For Delivery', 'out_for_delivery', 'Our Deliver man has picked-up you order for Delivery'],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-05-09T18:49:00+06:00', description: 'New Delivery Requested' });
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Rider|Seller)|S 0000|0100000000|Customer|Merchant/);
  });

  it('takes the rail’s word for a delivery or a return, and leaves the rest to the newest staged scan', () => {
    const stage = (name: unknown) => parsePathaoCourier(changed('in-transit', (data) => { data.state.name = name; }), IN_TRANSIT);
    expect(stage('Delivered')).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    // A delivery the rail gives over scans that do not say it has no moment.
    expect(stage('Delivered')).not.toHaveProperty('delivered_at');
    expect(stage('Paid Return')).toMatchObject({ current_stage: 'returned' });
    for (const name of ['Confirmed', 'Picked', 'Ready For Delivery', 'Exchange', '']) {
      expect(stage(name), name).toMatchObject({ current_stage: 'in_transit' });
    }
    expect(parsePathaoCourier(changed('in-transit', (data) => { delete (data as Row).state; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
  });

  it('takes riders, staff codes and phone numbers out of the wording', () => {
    expect(pathaoWording('Assigned to Sample Rider (01000000000) for delivery.')).toBe('Assigned for delivery.');
    expect(pathaoWording('Order has been assigned to (Sample Rider-01000000000) for delivery')).toBe('Order has been assigned for delivery');
    expect(pathaoWording('Order has been assigned to Sample Pickup Rider for pickup')).toBe('Order has been assigned for pickup');
    expect(pathaoWording('Order has been assigned to Sample Rider')).toBe('Order has been assigned');
    expect(pathaoWording('Our Deliver man (Sample Rider(S 0000)-01000000000) has picked-up you order for Delivery'))
      .toBe('Our Deliver man has picked-up you order for Delivery');
    expect(pathaoWording('Call the hub on +880 1000-000000 or (01000000000).')).toBe('Call the hub on or.');
    // Hubs, weights and brackets that name places stay.
    expect(pathaoWording('OSD On The Way To Sample Town (Last Mile) Hub')).toBe('OSD On The Way To Sample Town (Last Mile) Hub');
    expect(pathaoWording('Order weight has been updated from 0.5kg to 1kg')).toBe('Order weight has been updated from 0.5kg to 1kg');
  });

  it('reads an unknown ID as not found and an order without scans as no history', () => {
    expect(() => parsePathaoCourier(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePathaoCourier(changed('delivered', (data) => { data.log = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parsePathaoCourier(changed('delivered', (data) => { data.log = [scan('', 'May 12, 2026 2:15 PM', 'Delivered')]; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts an order only when it names the ID asked', () => {
    expect(() => parsePathaoCourier(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Pathao answered for another consignment' }));
    expect(parsePathaoCourier(changed('in-transit', (data) => { data.order.consignment = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(5);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_data: Data, body: Reply) => { delete (body as Row).data; },
      (_data: Data, body: Reply) => { body.type = 'ok'; },
      (_data: Data, body: Reply) => { body.data = 'order' as never; },
      (data: Data) => { delete (data as Row).order; },
      (data: Data) => { delete data.order.consignment; },
      (data: Data) => { data.order.consignment = 1; },
      (data: Data) => { data.log = 'log' as never; },
      (data: Data) => { data.log = Array.from({ length: 501 }, () => data.log[0]!); },
      (data: Data) => { data.log[0] = 'scan' as never; },
      (data: Data) => { data.log[0]!.desc = ['Delivered.']; },
      (data: Data) => { data.log[0]!.created_at = '2026-05-11 20:20'; },
      (data: Data) => { data.log[0]!.created_at = 'May 32, 2026 8:20 PM'; },
      (data: Data) => { delete data.log[0]!.created_at; },
      (data: Data) => { data.log[0]!.grouped_status = 'Accepted'; },
      (data: Data) => { data.log[0]!.grouped_status = [1, 1, 1, 1]; },
      (data: Data) => { data.state = 'Delivered' as never; },
      (data: Data) => { data.state.name = 5; },
      (data: Data) => { data.order.estimated_date = 14; },
      (_data: Data, body: Reply) => { Object.assign(body, { type: 'error', code: 500, message: 'Server Error' }); },
    ]) {
      expect(() => parsePathaoCourier(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // An older reply without steps falls to the shared wording rules.
    const plain = parsePathaoCourier(changed('in-transit', (data) => { for (const row of data.log) delete row.grouped_status; }), IN_TRANSIT);
    expect(plain.events![0]).toMatchObject({ stage: 'in_transit', stage_source: 'wording:language' });
    expect(plain.events![0]).not.toHaveProperty('provider_code');
  });

  it('keeps an unknown ID, a moved route, a refused ID, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // Any other 404 or a redirect is a moved route.
    await expect(lookup({ message: 'no Route matched with those values' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://merchant.pathao.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ message: 'Please fix the given errors', type: 'error', code: 422,
      errors: { consignment_id: ['The consignment id must be 14 characters.'] } }, { status: 422 })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Pathao Merchant</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[400, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known ID and the unknown-ID answer, and asks nothing for an ID Pathao does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-12T08:15:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('DA1005')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects IDs Pathao does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['DA100526SMPL0', 'DA100526SMPL012', 'XA100526SMPL01', 'D1100526SMPL01', 'DA320526SMPL01', 'DA101326SMPL01', `DA100526${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePathaoNumber('da10 0526 smpl01')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an ID filed under Pathao Courier, or detected as a consignment ID, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pathao-courier' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pathao-courier', source: 'pathao-courier', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'pathao-courier', source: 'pathao-courier' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === PATHAO_API)).toBe(true);
  });
});

describe('Pathao Courier numbers', () => {
  it('claims the consignment ID layout with high confidence', () => {
    for (const number of [DELIVERED, IN_TRANSIT, RETURNED, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'pathao-courier', confidence: 'high' });
    }
  });
});

describe('Pathao Courier status vocabulary', () => {
  it('stages every step and wording seen with the stage its record gives', () => {
    const seen = (statuses.entries as { code?: string; wording: string; stage?: string; confirmedBy: string }[])
      .filter((entry) => entry.code && entry.confirmedBy === 'live');
    expect(seen.length).toBeGreaterThan(20);
    for (const entry of seen) {
      expect(statusMap.stage(entry.code!, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(pathaoStage(entry.code!, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'pathao-courier', providerCode: entry.code!, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // A step the map does not know falls to the shared wording rules.
    expect(pathaoStage('Exchange', 'Sample note')).toBeNull();
    expect(pathaoStage('', 'Delivered.')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(statusMap.stage(null, 'delivered.')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'pathao-courier', providerCode: 'Exchange', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
