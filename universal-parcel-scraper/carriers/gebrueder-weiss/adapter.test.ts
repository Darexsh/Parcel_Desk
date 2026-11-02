import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { carrierDefinition } from '../../core/catalog/index.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { InputRequiredError, InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter, GEBRUEDER_WEISS_ENDPOINT, GebruederWeissTracker, gebruederWeissSearchUrl } from './adapter.js';
import { normalizeGebruederWeissNumber, normalizeGebruederWeissPostcode, parseGebruederWeiss } from './parser.js';
import { gebruederWeissCodeStage, gebruederWeissStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '7000000001';
const REFERENCE = 'ZZ12345-00000001';
const HOME = 'ZZ00000000002';
const POSTCODE = '9999';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
type Row = Record<string, unknown>;
type Order = Record<string, unknown> & { detail_status_transport: Row[] };
type Reply = { totalRows: number; payload: Order[] };
const fixture = (name: string): Reply => JSON.parse(text(`${name}.json`)) as Reply;
const edited = (name: string, change: (order: Order, reply: Reply) => void): Reply => {
  const reply = fixture(name);
  change(reply.payload[0]!, reply);
  return reply;
};
const row = (eventDateTime: string, eventCode: string, reasonCode: string | null, description: string,
  location: Row | null = { countryCode: 'AT', code: 'SMP', description: 'Sampletown' }): Row => ({
  isInternal: null, creationDateTime: eventDateTime, eventDateTime, location, eventCode, reasonCode, description,
  gwDescription: 'Synthetischer interner Text', progress: 50, rate: 2, event: 'RDGW', remarks: null,
});
const withRows = (...rows: Row[]) => edited('delivered', (order) => { order.detail_status_transport = rows; });
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const environment = (fetcher: typeof fetch) => ({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: { step() {}, lookup() {} } });

describe('Gebrüder Weiss public search', () => {
  it('reads a road shipment newest first, at its branches, with its weight and service', () => {
    const result = normalizeCarrierResult(parseGebruederWeiss(fixture('delivered'), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'delivered', last_update: '2030-03-06T13:15:10+01:00', expected_delivery: null,
      delivered_at: '2030-03-06T13:15:10+01:00', weight_kg: 120.5, service_name: 'Road' });
    expect(result.events?.map((event) => [event.time, event.location, event.provider_code, event.description, event.stage])).toEqual([
      ['2030-03-06T13:15:10+01:00', 'Sampletown, AT', 'RDGW/810/012', 'delivered', 'delivered'],
      ['2030-03-06T06:59:30+01:00', 'Sampletown, AT', 'RDGW/290', 'in Transit', 'in_transit'],
      ['2030-03-06T06:59:00+01:00', 'Sampletown, AT', 'RDGW/300/054', 'in delivery', 'out_for_delivery'],
      ['2030-03-05T14:50:00+01:00', 'Sampletown, AT', 'RDGW/180/004', 'unloaded', 'in_transit'],
      ['2030-03-05T14:30:00+01:00', 'Sampletown, AT', 'RDGW/400/A12', 'picked up', 'accepted'],
      ['2030-03-05T14:29:50+01:00', 'Sampletown, AT', 'RDGW/166/138', 'arrival time at consignee / shipper', undefined],
    ]);
    // Places, references, customer numbers, partner references, CO2 figures and the internal wording stay out.
    expect(JSON.stringify(result)).not.toMatch(/Exampledorf|Senderburg|9999|9998|55555|PARTNERREF|Synthetisch|ZZ12345|SMP7000000001|7000000001|999999|12\.3/);
  });

  it('hides internal events, drops a twin without a place, stages the way back and reads a foreign branch clock', () => {
    const result = normalizeCarrierResult(parseGebruederWeiss(fixture('home-delivery'), HOME));
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'unloaded',
      last_update: '2030-04-10T18:00:03+02:00', expected_delivery: null, weight_kg: 58.2, service_name: 'Home Delivery' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.map((event) => [event.time, event.location, event.provider_code, event.stage])).toEqual([
      ['2030-04-10T18:00:03+02:00', 'Sampleháza, HU', 'RDGW/180/005', 'returned'],
      ['2030-04-10T10:27:00+02:00', 'Sampleháza, HU', 'RDGW/860/067', 'returned'],
      ['2030-04-03T14:14:23+02:00', 'Sampleháza, HU', 'RDGW/850/009', 'failed_attempt'],
      ['2030-04-03T14:13:26+02:00', 'Sampleháza, HU', 'RDGW/166/138', undefined],
      ['2030-04-03T09:33:16+02:00', 'Sampleháza, HU', 'RDGW/300/MOB', 'out_for_delivery'],
      // A scan without a place keeps the service's instant.
      ['2030-04-02T17:01:19Z', undefined, 'RDGW/165/019', 'in_transit'],
      ['2030-04-01T20:58:47+02:00', 'Sampleháza, HU', 'RDGW/180/004', 'in_transit'],
      ['2030-04-01T20:58:42+02:00', 'Sampleháza, HU', 'RDGW/110/170', undefined],
      // A Romanian branch's wall clock, read by the service as Vienna time: an hour earlier, just before its record.
      ['2030-03-28T19:18:11+02:00', 'Sampleni, RO', 'RDGW/180/004', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/internal change|RDGW\/641|Példafalva|9997|8000000002|SMH7000000002/);
  });

  it('keeps a branch clock in a country of several zones as a wall clock, and re-reads one west of Vienna', () => {
    const result = parseGebruederWeiss(withRows(
      row('2030-03-05T15:00:00Z', '180', '004', 'unloaded', { countryCode: 'US', code: 'ZZA', description: 'Sampleville' }),
      row('2030-03-05T10:00:00Z', '190', '004', 'loaded', { countryCode: 'GB', code: 'ZZB', description: 'Samplebury' }),
      row('2030-03-05T09:00:00Z', '400', 'A12', 'picked up', { countryCode: 'DE', code: 'ZZC', description: 'Beispielstadt' }),
    ), NUMBER);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2030-03-05T16:00:00', current_stage: 'in_transit' });
    expect(result.events?.map((event) => [event.time, event.local_time, event.location])).toEqual([
      [undefined, '2030-03-05T16:00:00', 'Sampleville, US'],
      ['2030-03-05T11:00:00+00:00', undefined, 'Samplebury, GB'],
      ['2030-03-05T10:00:00+01:00', undefined, 'Beispielstadt, DE'],
    ]);
  });

  it('gives the estimated arrival at the destination as its day in Vienna, until the shipment is delivered', () => {
    const moving = (type: string | null, eta: string | null = '2030-03-06T23:30:00Z') => parseGebruederWeiss(edited('delivered', (order) => {
      order.detail_status_transport = order.detail_status_transport.slice(3);
      Object.assign(order, { estimated_time_of_arrival_type: type, estimated_time_of_arrival: eta });
    }), NUMBER);
    expect(moving('estimatedTimeOfDeliveryCRplus_LZ09')).toMatchObject({ current_stage: 'in_transit', expected_delivery: '2030-03-07' });
    expect(moving('AXAPTAHDOrderId', '2030-03-07T07:00:00Z').expected_delivery).toBe('2030-03-07');
    for (const type of ['actualTimeOfDelivery', 'estimatedTimeOfDeliveryPort', 'somethingElse', null]) {
      expect(moving(type).expected_delivery, String(type)).toBeNull();
    }
    expect(moving('estimatedTimeOfDelivery', '2030-03-07').expected_delivery).toBeNull();
    const delivered = edited('delivered', (order) => { order.estimated_time_of_arrival_type = 'estimatedTimeOfDelivery'; });
    expect(parseGebruederWeiss(delivered, NUMBER).expected_delivery).toBeNull();
  });

  it('binds the shipment whose order number, request number or reference is the whole number', () => {
    for (const number of [NUMBER, 'SMP7000000001', REFERENCE, 'zz12345 00000001', 'ZZ1234500000001']) {
      expect(parseGebruederWeiss(fixture('delivered'), number).status, number).toBe('delivered');
    }
    // A match on part of a number, a partner reference or a customer number is someone else's answer to give.
    for (const number of ['700000000', 'ZZ12345', 'PARTNERREF77', '55555', '999999']) {
      expect(() => parseGebruederWeiss(fixture('delivered'), number), number).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const beside = edited('delivered', (order, page) => {
      page.payload.push({ ...order, order_id: '7000000009', request_order_id: null, customer_reference: ['OTHER1'] });
      page.totalRows = 2;
    });
    expect(parseGebruederWeiss(beside, NUMBER).status).toBe('delivered');
    const twice = edited('delivered', (order, page) => {
      page.payload.push({ ...order, order_id: '7000000009' });
      page.totalRows = 2;
    });
    expect(() => parseGebruederWeiss(twice, REFERENCE)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reports an empty search as not found, and an empty later page as inconclusive', () => {
    expect(() => parseGebruederWeiss(fixture('empty'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const empty = fixture('empty');
    empty.totalRows = 3;
    expect(() => parseGebruederWeiss(empty, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply and bounds the history', () => {
    for (const payload of [null, [], {}, { totalRows: 1 }, { payload: [], totalRows: '0' }, { payload: [null], totalRows: 1 }]) {
      expect(() => parseGebruederWeiss(payload, NUMBER), JSON.stringify(payload)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (scan: Row) => { scan.eventDateTime = '2030-03-06T12:15:10'; },
      (scan: Row) => { scan.eventDateTime = null; },
      (scan: Row) => { scan.eventCode = null; },
      (scan: Row) => { scan.eventCode = '810 012'; },
      (scan: Row) => { scan.reasonCode = 'X'.repeat(11); },
      (scan: Row) => { scan.event = 'rdgw'; },
    ]) {
      const changed = edited('delivered', (order) => change(order.detail_status_transport[0]!));
      expect(() => parseGebruederWeiss(changed, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseGebruederWeiss(edited('delivered', (order) => { order.detail_status_transport = {} as Row[]; }), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGebruederWeiss(withRows(), NUMBER)).toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseGebruederWeiss(edited('delivered', (order) => { order.detail_status_transport = null as unknown as Row[]; }), NUMBER))
      .toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseGebruederWeiss(withRows({ ...row('2030-03-05T09:00:00Z', '641', '723', 'internal'), isInternal: true }), NUMBER))
      .toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
    const rows = (count: number) => Array.from({ length: count }, (_, index) =>
      row(new Date(Date.UTC(2030, 2, 5) + index * 60_000).toISOString().replace('.000', ''), '180', '004', 'unloaded'));
    expect(parseGebruederWeiss(withRows(...rows(250)), NUMBER)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseGebruederWeiss(withRows(...rows(250)), NUMBER).events).toHaveLength(200);
    expect(() => parseGebruederWeiss(withRows(...rows(501)), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads other families by their wording only', () => {
    const result = parseGebruederWeiss(withRows({ ...row('2030-03-05T09:00:00Z', 'I94', '001', 'Freight in hand of carrier'), event: 'AGW' },
      { ...row('2030-03-05T08:00:00Z', '810', '012', 'delivered'), event: 'AGW' }), NUMBER);
    expect(result.events?.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['AGW/I94/001', undefined, undefined],
      ['AGW/810/012', 'delivered', 'wording:language'],
    ]);
  });

  it('takes letter-and-digit numbers and a postcode, and builds the search address', () => {
    expect(normalizeGebruederWeissNumber(' zz12345-00000001 ')).toBe('ZZ1234500000001');
    for (const number of ['', 'A12', 'ABCDEFGH', 'ZZ12345/1', 'A'.repeat(40) + '1']) {
      expect(() => normalizeGebruederWeissNumber(number), number).toThrow(InvalidInputError);
    }
    expect(normalizeGebruederWeissPostcode(' 760  05 ')).toBe('760 05');
    for (const postcode of ['', '  ', null, undefined]) expect(() => normalizeGebruederWeissPostcode(postcode)).toThrow(InputRequiredError);
    for (const postcode of ['12', 'NOPOSTCODE', '99_99']) expect(() => normalizeGebruederWeissPostcode(postcode), postcode).toThrow(InvalidInputError);
    expect(gebruederWeissSearchUrl(REFERENCE, '760 05')).toBe(
      `${GEBRUEDER_WEISS_ENDPOINT}?orderReferenceQuery=ZZ1234500000001&shipperConsigneeAddressQuery=760+05&offset=0&pageSize=20`);
  });

  it('maps every recorded code, and the status map answers by it', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(gebruederWeissCodeStage(entry.code), entry.code).toBe(stage);
      expect(gebruederWeissStage(entry.code, entry.wording)?.stage, entry.code).toBe(stage);
      expect(statusMapAnswer({ carrier: 'gebrueder-weiss', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(statusMapAnswer({ carrier: 'gebrueder-weiss', providerCode: 'RDGW/641/723', description: 'Subsequent change in zAmL' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    expect(statusMapAnswer({ carrier: 'gebrueder-weiss', providerCode: 'AGW/I94/001', description: 'Freight in hand of carrier' }))
      .toEqual({ kind: 'unknown' });
    for (const code of ['constructor', 'toString', 'RDGW', 'RDGW/', '850/009', 'rdgw/850/009', 'AGW/810/012', '']) {
      expect(gebruederWeissCodeStage(code), code).toBeUndefined();
    }
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    expect(gebruederWeissStage('RDGW/166/138', 'arrival time at consignee / shipper')).toBeNull();
  });

  it('opens a shipment from a tracker link, but detection never offers the carrier', () => {
    for (const link of [`https://my.gw-world.com/en/trackntrace/-/search/${POSTCODE}/${REFERENCE}`,
      'https://my.gw-world.com/trackntrace/-/search/SAMPLE/ZZ12345-00000001/', `https://my.gw-world.com/de/trackntrace/-/search/760%2005/${REFERENCE}/EXTRA`]) {
      // The number keeps its printed form; the tracker normalizes it before the lookup.
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: REFERENCE, carrier: 'gebrueder-weiss', source: 'link' });
    }
    expect(parseTrackingInput('https://my.gw-world.com/trackntrace/-/search/').carrier).not.toBe('gebrueder-weiss');
    for (const number of [NUMBER, 'ZZ1234500000001', 'SMP7000000001']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('gebrueder-weiss');
    }
    expect(carrierDefinition('gebrueder-weiss').tracking).toMatchObject({ adapter: 'gebrueder-weiss',
      localClocks: true, requirements: [expect.objectContaining({ field: 'postcode', optional: true })] });
    expect(carrierDefinition('gebrueder-weiss').tracking).not.toHaveProperty('recognition');
  });

  it('posts the search once with the number and postcode, and asks nothing without the postcode', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init): Promise<Response> => {
      expect(String(url)).toBe(`${GEBRUEDER_WEISS_ENDPOINT}?orderReferenceQuery=${NUMBER}&shipperConsigneeAddressQuery=${POSTCODE}&offset=0&pageSize=20`);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(init?.body).toBeUndefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBeTruthy();
      expect(headers.get('accept')).toContain('application/json');
      expect(headers.get('origin')).toBe('https://my.gw-world.com');
      expect(headers.has('cookie')).toBe(false);
      return reply(text('delivered.json'));
    });
    const instance = adapter(environment(fetcher));
    expect(instance.recognize).toBeUndefined();
    expect(await instance.track({ number: ` ${NUMBER} `, postcode: POSTCODE })).toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'input_required' });
    await expect(instance.track({ number: NUMBER, postcode: null })).rejects.toMatchObject({ kind: 'input_required' });
    await expect(instance.track({ number: 'ABC', postcode: POSTCODE })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the failure taxonomy without the postcode in its details, retries a failed connection once and bounds bodies', async () => {
    const tracker = (fetcher: typeof fetch) => new GebruederWeissTracker({ fetcher });
    await expect(tracker(vi.fn(async () => reply(text('empty.json'))) as unknown as typeof fetch).fetch(NUMBER, POSTCODE))
      .rejects.toMatchObject({ kind: 'not_found' });
    for (const [body, status, type, kind] of [
      [text('rejected.html'), 200, 'text/html', 'challenge'], ['<html><body>Service</body></html>', 200, 'text/html', 'schema'],
      ['', 200, 'application/json', 'schema'], ['', 404, 'text/html', 'transport'], ['', 405, 'text/html', 'transport'],
      ['', 403, 'text/html', 'challenge'], ['', 429, 'text/html', 'rate_limited'], ['', 503, 'text/html', 'maintenance'],
      ['', 500, 'text/html', 'indeterminate'], ['', 400, 'text/html', 'transport'],
    ] as const) {
      const failure = await tracker(vi.fn(async () => reply(body, status, type)) as unknown as typeof fetch).fetch(NUMBER, POSTCODE)
        .then(() => undefined, (error: unknown) => error as Record<string, unknown>);
      expect(failure, `${status} ${body.slice(0, 20)}`).toMatchObject({ kind });
      expect(failure!.request).toBeUndefined();
      expect(failure!.diagnostics).toBeUndefined();
    }
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered.json')));
    expect(await tracker(flaky as unknown as typeof fetch).fetch(NUMBER, POSTCODE)).toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const down = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const failure = await tracker(down as unknown as typeof fetch).fetch(NUMBER, POSTCODE).catch((error: unknown) => error as Record<string, unknown>);
    expect(failure).toMatchObject({ kind: 'transport' });
    expect(failure.request).toBeUndefined();
    expect(down).toHaveBeenCalledTimes(2);
    const large = vi.fn(async () => new Response(new Uint8Array(1_100_000))) as unknown as typeof fetch;
    await expect(tracker(large).fetch(NUMBER, POSTCODE)).rejects.toThrow('unexpectedly large');
  });

  it('honors cancellation and the whole-lookup budget', async () => {
    const immediate = vi.fn(async () => reply(text('delivered.json'))) as unknown as typeof fetch;
    await expect(new GebruederWeissTracker({ fetcher: immediate }).fetch(NUMBER, POSTCODE, { signal: AbortSignal.abort() }))
      .rejects.toBeInstanceOf(Error);
    await expect(new GebruederWeissTracker({ fetcher: immediate }).fetch(NUMBER, POSTCODE, { budgetMs: 0 }))
      .rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(new GebruederWeissTracker({ fetcher: slow }).fetch(NUMBER, POSTCODE, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
