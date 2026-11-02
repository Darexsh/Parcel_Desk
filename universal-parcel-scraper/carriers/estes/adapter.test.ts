import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ESTES_ENDPOINT, EstesTracker, estesTrackingUrl } from './adapter.js';
import { normalizeEstesNumber, parseEstes } from './parser.js';
import { estesCodeStage, estesStage, estesWordingStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const TRANSIT = '9900000101';
const DELIVERED = '9900000202';
const REFUSED = '9900000303';
const ABSENT = '9999999999';
// A parsed fixture that tests change in place.
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const shipment = (payload: Reply): Reply => payload.data[0];
/** The refused fixture with its last delivery row, and the shipment's current status, changed alike. */
const refusedWith = (row: Reply): Reply => {
  const payload = fixture('refused');
  const delivery = shipment(payload).movementHistory[1].statusHistory;
  delivery[1] = { ...delivery[1], ...row };
  shipment(payload).status = { ...delivery[1] };
  return payload;
};

describe('Estes tracking adapter', () => {
  it('asks the tracking page’s service once for the PRO number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EstesTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 990-000-0202 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://myestes-api.estes-express.com/shipmenttracking/history?pro=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    const headers = new Headers(init!.headers);
    for (const name of ['cookie', 'authorization', 'x-auth-token', 'origin']) expect(headers.has(name), name).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'estes', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a shipment in transit newest first, with each terminal’s town and offset clocks', () => {
    const result = parseEstes(fixture('in-transit'), TRANSIT);
    const terminal = (time: string, description: string, location: string) =>
      ({ time, description, location, stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at Riverton, WA (992) delivery facility', last_update: '2026-03-04T21:58:31-08:00',
      expected_delivery: '2026-03-06', weight_kg: 204.117,
      events: [
        terminal('2026-03-04T21:58:31-08:00', 'Arrived at Riverton, WA (992) delivery facility', 'West Riverton, WA'),
        // Rows stamped alike keep the later one listed first.
        terminal('2026-03-04T02:30:00-08:00', 'En route to delivery facility at Riverton, WA (992)', 'West Riverton, WA'),
        terminal('2026-03-04T02:30:00-08:00', 'Departed Estes facility at Mesa Verde, NV (991)', 'North Mesa Verde, NV'),
        terminal('2026-03-03T20:11:09-08:00', 'Arrived at Estes facility at Mesa Verde, NV (991)', 'North Mesa Verde, NV'),
        terminal('2026-03-02T23:47:15-06:00', 'En route to Estes facility at Mesa Verde, NV (991)', 'North Mesa Verde, NV'),
        terminal('2026-03-02T23:47:15-06:00', 'Departed Estes facility at Oak Hollow, IL (990)', 'Oak Hollow, IL'),
        terminal('2026-03-02T19:01:02-06:00', 'Trailer Closed at Estes facility at Oak Hollow, IL (990)', 'Oak Hollow, IL'),
        terminal('2026-03-02T18:22:40-06:00', 'Loaded at Estes facility at Oak Hollow, IL (990)', 'Oak Hollow, IL'),
        // The pickup stands for the shipper's premises: no place.
        { time: '2026-03-02T14:05:11-06:00', description: 'Pickup Location Serviced', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // Parties, references, the driver, streets, postcodes, phones and coordinates stay behind.
    const text = JSON.stringify(result);
    for (const value of ['Sample Driver', 'Sampleton', 'Shipville', 'Synthetic Way', '00000', '00002', 'PO-SYNTH-1', 'BOL-SYNTH-1',
      '-90.0001', '(000)', 'example.invalid', 'not guaranteed']) expect(text, value).not.toContain(value);
  });

  it('reads a delivery once per row, with its time, and leaves the receiver, appointment and stop behind', () => {
    const result = parseEstes(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Completed - OK', last_update: '2026-04-09T10:26:50-06:00', expected_delivery: null,
      delivered_at: '2026-04-09T10:26:50-06:00', weight_kg: 105.233,
      events: [
        { time: '2026-04-09T10:26:50-06:00', description: 'Delivery Completed - OK', provider_code: 'OK', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-04-09T10:20:05-06:00', description: 'Unload at Delivery Location', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-04-09T10:02:13-06:00', description: 'Arrived at Delivery Location', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-04-09T07:31:44-06:00', description: 'Out for Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-04-08T15:40:20-06:00', description: 'Arrived at Pine Bluff, CO (994) delivery facility', location: 'Pine Ridge, CO',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-07T22:10:00-05:00', description: 'Departed Estes facility at Lakeview, MO (993)', location: 'Lakeview, MO',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-04-07T16:12:00-05:00', description: 'Pickup Location Serviced', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    const text = JSON.stringify(result);
    for (const value of ['SAMPLE SIGNER', 'Sample Consignee', 'Sample Street', '00001', '-91.2345', 'SHIP-REF-2', 'BOL-SYNTH-2',
      'appointment', '08:00:00', 'Sample Driver', 'subject to change']) expect(text, value).not.toContain(value);
  });

  it('stages a refusal Estes files under Delivered by its reason code, and keeps the estimate', () => {
    const result = parseEstes(fixture('refused'), REFUSED);
    expect(result).toEqual({
      status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Attempted - Freight Refused', last_update: '2026-05-11T11:05:30-06:00', expected_delivery: '2026-05-11',
      events: [
        { time: '2026-05-11T11:05:30-06:00', description: 'Delivery Attempted - Freight Refused', provider_code: 'RF',
          stage: 'failed_attempt', stage_source: 'carrier_map' },
        { time: '2026-05-11T08:40:00-06:00', description: 'Out for Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-05-11T06:15:00-06:00', description: 'Arrived at Pine Bluff, CO (994) delivery facility', location: 'Pine Ridge, CO',
          stage: 'in_transit', stage_source: 'carrier_map' },
      ],
    });
    // A hand-over to an interline partner is filed under Delivered too; it is no delivery.
    const interline = parseEstes(refusedWith({ expandedStatus: 'Delivery Completed - Delivered to Interline Partner', reasonCode: 'CTI',
      isException: false }), REFUSED);
    expect(interline).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', expected_delivery: '2026-05-11' });
    expect(interline.delivered_at).toBeUndefined();
    const returned = parseEstes(refusedWith({ expandedStatus: 'Undelivered - Returned to Shipper', reasonCode: 'DTS' }), REFUSED);
    expect(returned).toMatchObject({ current_stage: 'returned', expected_delivery: null });
  });

  it('stages a row by its code outside a pickup, then the wording, the exception flag, the milestone and the shared rules', () => {
    const stage = (row: Reply) => parseEstes(refusedWith(row), REFUSED).current_stage;
    // A known code outranks the wording.
    expect(stage({ expandedStatus: 'Delivery Completed - OK', reasonCode: 'RS' })).toBe('failed_attempt');
    // The pickup tables reuse delivery codes with other meanings: a pickup row reads by its wording.
    expect(stage({ conciseStatus: 'Departed Pickup Location', expandedStatus: 'Pickup Attempted - Freight Not Ready', reasonCode: 'NF',
      isException: true })).toBe('registered');
    expect(estesStage('NF', 'Pickup Attempted - Freight Not Ready', { milestone: '', isException: false }))
      .toEqual({ stage: 'registered', source: 'carrier_map' });
    // Unknown code and wording: the exception flag, then the milestone.
    expect(stage({ expandedStatus: 'Synthetic note', reasonCode: 'ZZ' })).toBe('exception');
    expect(stage({ expandedStatus: 'Synthetic note', reasonCode: 'ZZ', isException: false })).toBe('delivered');
    expect(stage({ conciseStatus: 'In Transit', expandedStatus: 'Synthetic note', reasonCode: null, isException: false })).toBe('in_transit');
    // The milestone alone names the row when Estes gives no wording.
    expect(parseEstes(refusedWith({ conciseStatus: 'Out for Delivery', expandedStatus: '', reasonCode: null, isException: false }), REFUSED))
      .toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Out for Delivery' });
    const worded = parseEstes(refusedWith({ conciseStatus: '', expandedStatus: 'Package returned to sender', reasonCode: null, isException: false }), REFUSED);
    expect(worded).toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    // Wording nobody knows keeps no stage, and the next staged row decides.
    const unknown = parseEstes(refusedWith({ conciseStatus: '', expandedStatus: 'Synthetic note', reasonCode: null, isException: false }), REFUSED);
    expect(unknown).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Synthetic note' });
    expect(unknown.events![0]).toEqual({ time: '2026-05-11T11:05:30-06:00', description: 'Synthetic note' });
  });

  it('names only a terminal’s town, whole when Estes cuts it to fifteen characters', () => {
    const place = (location: Reply, id = '991') => {
      const payload = fixture('in-transit');
      const movement = shipment(payload).movementHistory[2];
      movement.id = id;
      movement.location = { ...movement.location, ...location, address: { ...movement.location.address, ...location.address } };
      return parseEstes(payload, TRANSIT).events!.find((event) => event.description?.includes('Mesa Verde'))!.location;
    };
    expect(place({ name: 'Mesa Verde Springs', address: { city: 'Mesa Verde Spri' } })).toBe('Mesa Verde Springs, NV');
    expect(place({ name: 'Oak Hollow Springs', address: { city: 'OakHollowSpring' } })).toBe('Oak Hollow Springs, NV');
    // A town of fifteen characters is kept when the terminal's name is another.
    expect(place({ name: 'Mesa Verde', address: { city: 'North Riverbank' } })).toBe('North Riverbank, NV');
    expect(place({ address: { city: '12 SAMPLE ST' } })).toBe('NV');
    // A movement that is no terminal of its own, or names another, gets no place.
    expect(place({}, 'Planned Waypoint')).toBeUndefined();
    expect(place({ id: '999' })).toBeUndefined();
    const bare = fixture('in-transit');
    shipment(bare).movementHistory[2].location.address = null;
    expect(parseEstes(bare, TRANSIT).events!.find((event) => event.description?.includes('Mesa Verde'))!.location).toBeUndefined();
  });

  it('adds a newer current status as a scan, and answers with the status alone before any scan', () => {
    const newer = fixture('in-transit');
    Object.assign(shipment(newer).status, { conciseStatus: 'Out for Delivery', expandedStatus: 'Out for Delivery', referenceDate: '2026-03-05',
      referenceTime: '07:00:00-08:00' });
    expect(parseEstes(newer, TRANSIT)).toMatchObject({ current_stage: 'out_for_delivery', last_update: '2026-03-05T07:00:00-08:00' });
    expect(parseEstes(newer, TRANSIT).events![0]).toEqual({ time: '2026-03-05T07:00:00-08:00', description: 'Out for Delivery',
      stage: 'out_for_delivery', stage_source: 'carrier_map' });
    expect(parseEstes(newer, TRANSIT).events).toHaveLength(10);

    const summary = fixture('refused');
    shipment(summary).movementHistory = [];
    expect(parseEstes(summary, REFUSED)).toEqual({
      status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Attempted - Freight Refused', provider_code: 'RF', last_update: '2026-05-11T11:05:30-06:00',
      expected_delivery: '2026-05-11', summary_only: true, events: [],
    });
    // A planned stop without a clock is no scan; with no status either, nothing is known yet.
    const planned = fixture('refused');
    shipment(planned).movementHistory[0].statusHistory[0] = { conciseStatus: 'In Transit', expandedStatus: 'Synthetic planned stop',
      referenceDate: null, referenceTime: null };
    shipment(planned).movementHistory = [shipment(planned).movementHistory[0]];
    delete shipment(planned).status;
    expect(() => parseEstes(planned, REFUSED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the estimate’s days and the weight in pounds, and drops values that do not read', () => {
    const shaped = (change: (payload: Reply) => void) => {
      const payload = fixture('in-transit');
      change(payload);
      return parseEstes(payload, TRANSIT);
    };
    expect(shaped((payload) => { shipment(payload).estimatedDelivery = { startDate: '2026-03-06', endDate: '2026-03-09' }; }))
      .toMatchObject({ expected_delivery: '2026-03-09', expected_delivery_from: '2026-03-06' });
    for (const period of [null, {}, { startDate: '2026-02-30' }, { startDate: '03/06/2026' }]) {
      const result = shaped((payload) => { shipment(payload).estimatedDelivery = period; });
      expect(result.expected_delivery, JSON.stringify(period)).toBeNull();
      expect(result.expected_delivery_from).toBeUndefined();
    }
    for (const weight of ['', '0', '-4', 'n/a', '1000000', null]) {
      expect(shaped((payload) => { shipment(payload).totalWeight = weight; }).weight_kg, String(weight)).toBeUndefined();
    }
    expect(shaped((payload) => { shipment(payload).totalWeight = 1; }).weight_kg).toBe(0.454);
  });

  it('caps the history it returns', () => {
    const long = fixture('in-transit');
    const row = shipment(long).movementHistory[1].statusHistory[0];
    shipment(long).movementHistory[1].statusHistory = Array.from({ length: 120 }, (_, index) => ({ ...row,
      referenceDate: `2026-03-${String(1 + Math.floor(index / 24)).padStart(2, '0')}`, referenceTime: `${String(index % 24).padStart(2, '0')}:00:00-06:00` }));
    const result = parseEstes(long, TRANSIT);
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
  });

  it('counts only the service’s own not-found as a missing shipment, and a reply only for the number asked', () => {
    expect(() => parseEstes(fixture('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEstes(fixture('invalid'), ABSENT)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseEstes({ data: [], error: { code: 0 } }, ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    for (const code of [50000, 99999, -1]) {
      expect(() => parseEstes({ data: [], error: { code } }, ABSENT), String(code)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseEstes(fixture('delivered'), ABSENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const twice = fixture('delivered');
    twice.data.push(shipment(twice));
    expect(() => parseEstes(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const failed = fixture('delivered');
    shipment(failed).error = 'Synthetic failure';
    expect(() => parseEstes(failed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects replies it cannot read', () => {
    const row = (payload: Reply) => shipment(payload).movementHistory[1].statusHistory[0];
    const broken: Array<(payload: Reply) => void> = [
      (payload) => { payload.data[0] = 'found'; },
      (payload) => { shipment(payload).pro = { id: DELIVERED }; },
      (payload) => { payload.error = 'none'; },
      (payload) => { payload.error = { code: '50010' }; },
      (payload) => { shipment(payload).movementHistory = {}; },
      (payload) => { shipment(payload).movementHistory = Array.from({ length: 101 }, () => shipment(payload).movementHistory[0]); },
      (payload) => { shipment(payload).movementHistory[1] = null; },
      (payload) => { shipment(payload).movementHistory[1].statusHistory = 'Departed'; },
      (payload) => { shipment(payload).movementHistory[1].statusHistory[0] = null; },
      (payload) => { shipment(payload).movementHistory[1].location = 'Lakeview'; },
      (payload) => { shipment(payload).movementHistory[1].location.address = ['Lakeview']; },
      (payload) => { shipment(payload).status = 'Delivered'; },
      (payload) => { row(payload).referenceDate = '2026-02-30'; },
      (payload) => { row(payload).referenceTime = '24:00:00-05:00'; },
      (payload) => { row(payload).referenceTime = '22:10:00'; },
      (payload) => { row(payload).referenceTime = null; },
      (payload) => { row(payload).referenceDate = null; },
      (payload) => { row(payload).expandedStatus = ''; row(payload).conciseStatus = ''; },
      (payload) => { row(payload).expandedStatus = { text: 'Departed' }; },
      (payload) => { row(payload).isException = 'false'; },
      (payload) => { shipment(payload).deliveryTime = '10:26'; },
      (payload) => { shipment(payload).movementHistory[1].statusHistory = Array.from({ length: 501 }, () => row(payload)); },
    ];
    for (const [index, change] of broken.entries()) {
      const payload = fixture('delivered');
      change(payload);
      expect(() => parseEstes(payload, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, [], {}, 'Not found.', { data: {} }, { error: { code: 0 } }]) {
      expect(() => parseEstes(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes a ten-digit PRO number and refuses other input without a request', async () => {
    expect(normalizeEstesNumber(' 990.000.0202 ')).toBe(DELIVERED);
    expect(estesTrackingUrl('990 000 0202')).toBe(`${ESTES_ENDPOINT}?pro=${DELIVERED}`);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '990000020', '99000002020', 'AB00000202', '990000020/', '9'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a shipment Estes knows and reads its not-found and its refusal as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), 404)).mockResolvedValueOnce(reply(fixture('invalid'), 400))
      .mockResolvedValueOnce(reply(fixture('not-found'), 404));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-09T16:26:50.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    // A shipment with nothing to show yet is neither known nor missing.
    const pending = vi.fn<typeof fetch>().mockImplementation(async () => reply({ data: [], error: { code: 0 } }));
    await expect(carrier(pending).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    // Another number's answer is no answer either way.
    const other = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(carrier(other).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[400, 'schema'], [403, 'challenge'], [404, 'transport'], [410, 'transport'], [429, 'rate_limited'], [500, 'indeterminate'],
    [503, 'maintenance']] as const)('keeps HTTP %s without the service’s code as %s during retrieval and recognition, without a retry', async (status, kind) => {
    // A 400 or 404 counts only with its own code: the refusal, or the not-found.
    const body = status === 400 ? fixture('not-found') : status === 404 ? fixture('invalid') : '';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status));
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
    await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the rate limit’s wait, block pages, other pages and oversized replies apart from missing shipments', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(reply('', 429, { 'Retry-After': '30' }));
    await expect(carrier(limited).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    for (const [body, status] of [
      ['<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>', 200],
      ['<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.</body></html>', 200],
      ['<html><head><title>Access denied</title></head><body>Synthetic block</body></html>', 404],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, status));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'challenge' });
    }
    const missing = vi.fn<typeof fetch>().mockImplementation(async () => reply('<html><body>Not Found</body></html>', 404));
    await expect(carrier(missing).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'transport' });
    for (const body of ['', '<html><head><title>MyEstes</title></head><body><app-root></app-root></body></html>', '{"data":']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a PRO number to the adapter when the caller names Estes, which detection never offers', async () => {
    for (const number of [TRANSIT, DELIVERED, ABSENT]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('estes');
      expect(recognitionAskedCarriers(number), number).not.toContain('estes');
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'estes' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'estes', source: 'estes', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${ESTES_ENDPOINT}?pro=${DELIVERED}`)).toBe(true);
  });
});

describe('Estes status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    const flags = { milestone: '', isException: false };
    for (const entry of statuses.entries) {
      const code = 'code' in entry ? entry.code ?? '' : '';
      const label = `${code} ${entry.wording}`;
      expect(estesStage(code, entry.wording, flags), label).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(code || null, normalizeStatusWording(entry.wording)), label).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'estes', providerCode: code || null, description: entry.wording }), label)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    for (const code of ['constructor', 'toString', 'ZZ', '']) expect(estesCodeStage(code), code).toBeUndefined();
    expect(estesWordingStage('Synthetic note')).toBeUndefined();
    // A pickup row's reused code yields to its wording.
    expect(statusMap.stage('NF', normalizeStatusWording('Pickup Attempted - Freight Not Ready'))).toBe('registered');
    expect(statusMap.stage('NF', normalizeStatusWording('Delivery Attempted - Freight Unavailable'))).toBe('failed_attempt');
  });
});
