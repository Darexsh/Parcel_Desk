import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FASTFRATE_API, FastfrateTracker } from './adapter.js';
import { normalizeFastfrateNumber, parseFastfrate } from './parser.js';
import { fastfrateMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1234067892';
const IN_TRANSIT = '123406789';
const UNKNOWN = '12340678';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Record<string, unknown> & { timeline: Record<string, unknown>[] };
const reply = (body: string, status = 200, type = 'application/json; charset=utf-8') =>
  new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseFastfrate>) =>
  result.events!.map(event => [event.local_time, event.location ?? null, event.description, event.stage ?? null]);
// The shipper's references and the service message.
const PRIVATE = /PO-0000|BOL-SAMPLE|PURCHASE ORDER|Customer Service/i;

describe('Fastfrate tracking adapter', () => {
  it('asks the quick track lookup once for the whole probill through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new FastfrateTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${DELIVERED.slice(0, 5)} ${DELIVERED.slice(5)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://tracker.fastfrate.com/trackerapi/shipmentinformation/quicktrack?probillnumber=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('authorization')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fastfrate', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered timeline newest first, as wall clocks, without the estimate, the appointment or the references', () => {
    const result = parseFastfrate(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-11T16:07:12', expected_delivery: null });
    expect(rows(result)).toEqual([
      // The driver's device stamps its own rows after the delivery; they do not undo it.
      ['2026-03-11T16:07:12', null, 'Departed Consignee', 'out_for_delivery'],
      ['2026-03-11T16:06:59', null, 'Arrived at Consignee', 'out_for_delivery'],
      ['2026-03-11T14:00:00', null, 'Delivered', 'delivered'],
      ['2026-03-11T11:40:00', 'Exampleburg, AB', 'Loaded to Delivery Unit', 'out_for_delivery'],
      ['2026-03-09T19:50:00', 'Exampleburg, AB', 'On Dock at Destination Terminal', 'in_transit'],
      // A row dated without a time keeps its day.
      ['2026-03-07', 'Exampleburg, AB', 'Appointment Requested', 'in_transit'],
      ['2026-03-04T10:10:00', 'Testville, ON', 'Enroute to Destination Terminal', 'in_transit'],
      // Repeated rows appear once.
      ['2026-03-03T21:21:00', 'Testville, ON', 'On Dock at Origin Terminal', 'in_transit'],
      ['2026-03-03T16:08:49', null, 'Departed Shipper', 'accepted'],
      ['2026-03-03T15:58:30', null, 'Arrived At Shipper', 'registered'],
      ['2026-03-03T15:58:00', 'Sampleton, ON', 'Picked Up', 'accepted'],
      ['2026-03-03T11:04:34', null, 'Driver assigned for Pickup', 'registered'],
      ['2026-03-02T10:15:33', null, 'Shipment Created', 'registered'],
      ['2026-03-02T09:46:30', null, 'Shipment accepted from EDI', 'registered'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    for (const field of ['summary_only', 'delivered_at', 'sender_name', 'receiver_name', 'weight_kg', 'delivery_carrier']) {
      expect(result).not.toHaveProperty(field);
    }
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      expect(JSON.stringify(parseFastfrate(fixture(name), number)), name).not.toMatch(PRIVATE);
    }
    // The reply's order does not matter.
    const reversed = fixture('delivered');
    reversed.timeline.reverse();
    expect(parseFastfrate(reversed, DELIVERED).events).toEqual(result.events);
  });

  it('follows the newest staged row in transit and keeps the estimate, or the appointment, until the delivery', () => {
    const result = parseFastfrate(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Enroute to Destination Terminal', last_update_local: '2026-11-03T06:45:00', expected_delivery: '2026-11-09' });
    expect(rows(result)).toEqual([
      ['2026-11-03T06:45:00', 'Testville, QC', 'Enroute to Destination Terminal', 'in_transit'],
      ['2026-11-02T18:05:00', 'Testville, QC', 'On Dock at Origin Terminal', 'in_transit'],
      ['2026-11-02T14:41:02', null, 'Arrived At Shipper', 'registered'],
      ['2026-11-02T14:30:00', 'Sampleton, QC', 'Picked Up', 'accepted'],
      ['2026-11-02T08:12:41', null, 'Shipment Created', 'registered'],
    ]);
    // The driver's arrival at the shipper, stamped after the pickup, does not step the shipment back.
    const picked = fixture('in-transit');
    picked.timeline.splice(3, 2);
    expect(parseFastfrate(picked, IN_TRANSIT)).toMatchObject({ current_stage: 'accepted', last_status_text: 'Picked Up',
      last_update_local: '2026-11-02T14:41:02' });
    // Before the pickup, it is the newest row.
    const booked = fixture('in-transit');
    booked.timeline.splice(1, 1);
    booked.timeline.splice(2, 2);
    expect(parseFastfrate(booked, IN_TRANSIT)).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Arrived At Shipper' });
    // An appointment's day comes before the estimate's, and its row is no scan.
    const appointed = fixture('in-transit');
    appointed.timeline.push({ description: 'Scheduled Appointment', timeStamp: '2026-11-10T13:00:00', city: 'Exampleburg', province: 'AB' });
    const withAppointment = parseFastfrate(appointed, IN_TRANSIT);
    expect(withAppointment).toMatchObject({ expected_delivery: '2026-11-10', last_update_local: '2026-11-03T06:45:00' });
    expect(withAppointment.events).toEqual(result.events);
    // Without either, there is no estimate.
    const unscheduled = fixture('in-transit');
    unscheduled.timeline.pop();
    expect(parseFastfrate(unscheduled, IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('stages new wording through the shared rules and leaves wording neither knows without a stage', () => {
    const returned = fixture('delivered');
    returned.timeline.push({ description: 'Returned to Shipper', timeStamp: '2026-03-12T09:00:00', city: 'Exampleburg', province: 'AB' });
    expect(parseFastfrate(returned, DELIVERED)).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:returned' });
    const unknown = fixture('in-transit');
    unknown.timeline.splice(5, 0, { description: 'Trailer sealed', timeStamp: '2026-11-03T07:00:00', city: null, province: null });
    const result = parseFastfrate(unknown, IN_TRANSIT);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Enroute to Destination Terminal', last_update_local: '2026-11-03T07:00:00' });
    expect(result.events![0]).toEqual({ local_time: '2026-11-03T07:00:00', description: 'Trailer sealed' });
    // A town with a digit could be an address; a province that is not a code is left out.
    const placed = fixture('in-transit');
    placed.timeline[1]!.city = '100 Sample Road';
    placed.timeline[3]!.province = 'Quebec';
    expect(rows(parseFastfrate(placed, IN_TRANSIT)).map(row => row[1])).toEqual(['Testville, QC', 'Testville', null, null, null]);
  });

  it('binds the reply to the whole requested probill', () => {
    // The service answers for the number it read, and a missing one reads as 0.
    expect(() => parseFastfrate(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: expect.stringContaining('another probill') }));
    for (const probill of [0, 1234067891]) {
      expect(() => parseFastfrate({ ...fixture('delivered'), probillNumber: probill }, DELIVERED), String(probill))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseFastfrate(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads only an empty timeline as a missing probill and rejects replies it cannot read', () => {
    expect(() => parseFastfrate(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A timeline with only an estimate has no scan.
    const estimateOnly = { ...fixture('not-found'), timeline: [{ description: 'Estimated Delivery Date', timeStamp: '2026-11-09T00:00:00' }] };
    expect(() => parseFastfrate(estimateOnly, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    const row = (patch: Record<string, unknown>) => ({ ...fixture('in-transit'),
      timeline: [{ ...fixture('in-transit').timeline[1], ...patch }] });
    for (const payload of [null, [], 'Probill not found', {}, { probillNumber: 12340678 }, { ...fixture('not-found'), timeline: null },
      { ...fixture('not-found'), probillNumber: '12340678' }, { ...fixture('not-found'), probillNumber: null },
      { ...fixture('not-found'), probillNumber: 12340678.5 }, { ...fixture('in-transit'), timeline: ['Picked Up'] },
      row({ description: '' }), row({ description: 42 }), row({ timeStamp: null }), row({ timeStamp: '2026-11-02T24:30:00' }),
      row({ timeStamp: '2026-02-30T14:30:00' }), row({ timeStamp: '2026-11-02T14:30:00Z' }), row({ timeStamp: '11/02/2026 14:30' }),
      row({ city: { name: 'Sampleton' } }), row({ province: 1 }),
      { ...fixture('in-transit'), timeline: Array.from({ length: 301 }, () => fixture('in-transit').timeline[1]) }]) {
      expect(() => parseFastfrate(payload, payload && typeof payload === 'object' && 'probillNumber' in payload
        && payload.probillNumber === 12340678 ? UNKNOWN : IN_TRANSIT), JSON.stringify(payload)?.slice(0, 120))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes six to ten digits that do not start with 0, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12345', '12345678901', '0123456789', '0000000000', '123456789A', 'ABCDEFGHIJ', '1Z9999999999999999', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFastfrateNumber('12340-67892')).toBe(DELIVERED);
    expect(normalizeFastfrateNumber('123456')).toBe('123456');
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('keeps a browser check, an HTML page and a malformed reply apart from a missing probill', async () => {
    for (const [body, kind] of [
      ['<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>', 'challenge'],
      ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>', 'challenge'],
      ['<!doctype html><html lang="en"><head><title>LTL Shipment Tracker - Fastfrate</title></head><body><app-root></app-root></body></html>', 'schema'],
      ['', 'schema'],
      ['{"probillNumber":12340678,"timeline":', 'schema'],
      ['{"errors":{"ProbillNumber":["The value is not valid."]},"status":400}', 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body, 200, 'text/html'));
      await expect(carrier(fetcher).track({ number: UNKNOWN }), body.slice(0, 60)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(200_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/v2/login-form' } })
        : reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
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

  it('routes a probill filed under Fastfrate to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'fastfrate' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'fastfrate', source: 'fastfrate', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(FASTFRATE_API))).toBe(true);
  });
});

describe('Fastfrate numbers', () => {
  it('leaves ten digits unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('fastfrate');
    }
  });
});

describe('Fastfrate status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(fastfrateMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(fastfrateMappedStage('  On Dock at   ORIGIN Terminal ')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'Estimated Delivery Date', 'Picked']) {
      expect(fastfrateMappedStage(wording), wording).toBeUndefined();
    }
    expect(statusMap.stage('7', 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'fastfrate', description: 'Loaded to Delivery Unit' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
