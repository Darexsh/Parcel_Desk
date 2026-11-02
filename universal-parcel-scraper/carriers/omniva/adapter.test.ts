import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, OMNIVA_ENDPOINT, OmnivaTracker } from './adapter.js';
import { parseOmniva } from './parser.js';
import { omnivaEventStage, omnivaState, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const COLLECTED = 'CC900000019EE';
const CUSTOMS = 'CE900000019EE';
const COURIER = 'JJEE90000000000000001';
const RETURNED = 'CC900000022EE';
const SUMMARY = 'LL900000019EE';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

interface Row { eventCode: string; eventDate: string; eventName?: string; location?: unknown }
interface Reply { shipmentBarcode?: string; currentStateCode?: string; returningShipment?: boolean; deliveryLocation?: unknown; events: Row[] }
const edited = (name: string, change: (payload: Reply) => void = () => {}): Reply => {
  const payload = JSON.parse(text(name)) as Reply;
  change(payload);
  return payload;
};
const rows = (result: ReturnType<typeof parseOmniva>) =>
  result.events!.map(event => [event.time, event.provider_code, event.stage ?? null, event.stage_source ?? null, event.location ?? null]);

describe('Omniva tracking adapter', () => {
  it('asks the app’s guest lookup for the whole number once and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('collected')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new OmnivaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cc 900 000 019 ee ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://mobile-be.omniva.ee/api/v2/shipment/trackSingleShipment/${COLLECTED}`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'omniva', step: 'direct', outcome: 'ok' }));
  });

  it('orders an item collected from a parcel machine newest first, keeps UTC clocks and names only Omniva’s sites', () => {
    const result = parseOmniva(JSON.parse(text('collected')), COLLECTED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment delivered', last_update: '2026-03-04T17:05:22.097Z', delivered_at: '2026-03-04T17:05:22.097Z',
      expected_delivery: null, pickup_point: 'Example Centre parcel machine', destination_country: 'EE' });
    expect(result.history_truncated).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-03-04T17:05:22.097Z', 'TRT_SHIPMENT_DELIVERED', 'delivered', 'carrier_map', 'Example Centre parcel machine'],
      // A notice keeps the stage of the scan before it.
      ['2026-03-03T09:50:13.004Z', 'TRT_SHIPMENT_ARRIVAL_PM_NOTIFICATION', 'ready_for_pickup', 'none', null],
      ['2026-03-03T09:50:11.500Z', 'TRT_SHIPMENT_STORED_IN_PM', 'ready_for_pickup', 'carrier_map', 'Example Centre parcel machine'],
      ['2026-03-02T21:35:16.721Z', 'TRT_SHIPMENT_ARRIVED_TO_PO', 'in_transit', 'carrier_map', 'Example terminal'],
      ['2026-03-02T21:32:13.876Z', 'TRT_SHIPMENT_ARRIVED_TO_PO', 'in_transit', 'carrier_map', 'Example sorting center'],
      ['2026-03-02T21:30:01.500Z', 'TRT_SHIPMENT_ARRIVED_TO_PO', 'in_transit', 'carrier_map', null],
      ['2026-03-02T15:00:57.237Z', 'TRT_SHIPMENT_DEPARTED_FROM_PM', 'in_transit', 'carrier_map', 'Sample Square parcel machine'],
      ['2026-03-02T12:19:19Z', 'TRT_SHIPMENT_HANDOVER_TO_PM', 'accepted', 'carrier_map', 'Sample Square parcel machine'],
      ['2026-03-02T08:10:42.123Z', 'TRT_SHIPMENT_REGISTERED', 'registered', 'carrier_map', null],
    ]);
    expect(result.events![0]!.description).toBe('Shipment delivered');
    const kept = JSON.stringify(result);
    for (const dropped of ['10001', '20002', '30003', '40004', 'Sample Shop', 'Example Road', 'IPS_GENERAL', 'Example sorting line',
      'Näidise', '+372', 'SMS', 'NOTIFICATION_CHANNEL', '1000001']) {
      expect(kept, dropped).not.toContain(dropped);
    }
  });

  it('reads scans at the same instant in the reply’s order and stages UPU events', () => {
    const result = parseOmniva(JSON.parse(text('customs')), CUSTOMS);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Shipment is under customs review',
      last_update: '2026-03-05T00:25:00Z' });
    expect(result.destination_country).toBeUndefined();
    expect(result.pickup_point).toBeUndefined();
    expect(rows(result).slice(0, 2)).toEqual([
      ['2026-03-05T00:25:00Z', 'TRT_SHIPMENT_EDB', 'customs', 'carrier_map', null],
      ['2026-03-05T00:25:00Z', 'TRT_SHIPMENT_EMD', 'in_transit', 'carrier_map', null],
    ]);
  });

  it('reads the UPU event that repeats Omniva’s own scan of the parcel machine as that scan', () => {
    const waiting = (edh: string, keepStored = true) => parseOmniva(edited('collected', (payload) => {
      delete payload.currentStateCode;
      payload.events = payload.events.filter(row => row.eventCode !== 'TRT_SHIPMENT_DELIVERED' && row.eventCode !== 'TRT_SHIPMENT_ARRIVAL_PM_NOTIFICATION'
        && (keepStored || row.eventCode !== 'TRT_SHIPMENT_STORED_IN_PM'));
      payload.events.push({ eventCode: 'TRT_SHIPMENT_EDH', eventDate: edh, eventName: 'Shipment is ready for pickup at the post office', location: null });
    }), COLLECTED);
    const copied = waiting('2026-03-03T09:50:11.617Z');
    expect(copied).toMatchObject({ current_stage: 'ready_for_pickup', last_update: '2026-03-03T09:50:11.500Z',
      last_status_text: 'Shipment is ready for collection from the parcel machine', pickup_point: 'Example Centre parcel machine' });
    expect(copied.events!.map(event => event.provider_code)).not.toContain('TRT_SHIPMENT_EDH');
    // Without Omniva's own scan near it, the UPU event is the item's news.
    for (const lone of [waiting('2026-03-03T12:00:00Z'), waiting('2026-03-03T09:50:11.617Z', false)]) {
      expect(lone).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Shipment is ready for pickup at the post office' });
    }
  });

  it('keeps a courier item’s failed attempt current past the notices and drops the recipient’s address and the reason', () => {
    const result = parseOmniva(JSON.parse(text('courier')), COURIER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Delivery attempt made',
      last_update: '2026-03-10T09:32:00.500Z', destination_country: 'LT' });
    expect(result.pickup_point).toBeUndefined();
    expect(rows(result).slice(0, 4)).toEqual([
      ['2026-03-10T09:32:00.500Z', 'TRT_COURIER_PRE_DELIVERY_RECIPIENT_NOTIFICATION', 'failed_attempt', 'none', null],
      ['2026-03-10T09:31:47.100Z', 'TRT_SHIPMENT_FAILED_DELIVERY_ATTEMPT', 'failed_attempt', 'carrier_map', null],
      ['2026-03-10T09:15:00.250Z', 'TRT_COURIER_CALLED_TO_RECEIVER', 'out_for_delivery', 'none', null],
      ['2026-03-10T06:02:10.300Z', 'TRT_SHIPMENT_COURIER_DELIVERY_STARTED', 'out_for_delivery', 'carrier_map', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Example Lane|60006|70007|RECIPIENT_NOT_HOME|EMAIL|Sample sorting line/);
  });

  it('reads a delivery after a return as the sender’s, without a pickup point', () => {
    const result = parseOmniva(JSON.parse(text('returned')), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_update: '2026-02-12T16:00:00.600Z' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.pickup_point).toBeUndefined();
    expect(rows(result).map(row => row[2])).toEqual(['returned', 'ready_for_pickup', 'in_transit', 'exception', 'ready_for_pickup', 'registered']);
    // The flag stands in for a return scan an old history no longer holds.
    const trimmed = parseOmniva(edited('returned', payload => { payload.events = payload.events.slice(-1); }), RETURNED);
    expect(trimmed).toMatchObject({ current_stage: 'returned', history_truncated: true });
    // A cancelled return goes on to the recipient.
    const resumed = parseOmniva(edited('returned', payload => {
      payload.returningShipment = false;
      payload.events.splice(3, 0, { eventCode: 'TRT_SHIPMENT_RETURN_CANCELLED', eventName: 'Shipment return has been cancelled', eventDate: '2026-02-10T12:00:00Z' });
    }), RETURNED);
    expect(resumed).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-02-12T16:00:00.600Z', pickup_point: 'Sample Square parcel machine' });
  });

  it('marks an old item’s history that keeps only its delivery as truncated, and caps long histories', () => {
    const delivered = parseOmniva(edited('collected', payload => { payload.events = payload.events.filter(row => row.eventCode === 'TRT_SHIPMENT_DELIVERED'); }), COLLECTED);
    expect(delivered).toMatchObject({ current_stage: 'delivered', history_truncated: true, pickup_point: 'Example Centre parcel machine' });
    const long = parseOmniva(edited('customs', payload => {
      payload.events.push(...Array.from({ length: 120 }, (_, index) => ({ eventCode: 'TRT_SHIPMENT_ARRIVED_TO_PO',
        eventName: 'Shipment has arrived at a postal facility for further processing', eventDate: new Date(Date.UTC(2026, 2, 2, 0, index)).toISOString() })));
    }), CUSTOMS);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ current_stage: 'customs', history_truncated: true });
  });

  it('answers a state without scans as an identity-bound summary', () => {
    expect(parseOmniva(JSON.parse(text('summary')), SUMMARY)).toEqual({ status: 'delivered', current_stage: 'delivered',
      current_stage_source: 'carrier_map', last_status_text: 'Delivered', provider_code: 'DELIVERED', summary_only: true,
      last_update: null, expected_delivery: null, events: [] });
    const waiting = parseOmniva(edited('collected', payload => { payload.events = []; payload.currentStateCode = 'READY_FOR_PICKUP'; }), COLLECTED);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'Example Centre parcel machine',
      provider_code: 'READY_FOR_PICKUP', summary_only: true });
    const unknown = parseOmniva(edited('summary', payload => { payload.currentStateCode = 'PARCEL_WEIGHED'; }), SUMMARY);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'PARCEL_WEIGHED', provider_code: 'PARCEL_WEIGHED', summary_only: true });
    expect(unknown.current_stage).toBeUndefined();
    expect(() => parseOmniva(edited('summary', payload => { delete payload.currentStateCode; }), SUMMARY))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps new and uncertain codes visible without a stage, and falls back to the item’s state', () => {
    const result = parseOmniva(edited('customs', payload => {
      payload.events.push({ eventCode: 'TRT_SHIPMENT_EDF', eventName: 'Shipment is on hold at the delivery depot', eventDate: '2026-03-06T08:00:00Z' },
        { eventCode: 'TRT_SHIPMENT_WEIGHED', eventName: '', eventDate: '2026-03-06T07:00:00Z' });
    }), CUSTOMS);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment is on hold at the delivery depot' });
    expect(result.events!.slice(0, 2)).toEqual([
      { time: '2026-03-06T08:00:00Z', description: 'Shipment is on hold at the delivery depot', provider_code: 'TRT_SHIPMENT_EDF' },
      { time: '2026-03-06T07:00:00Z', description: 'TRT_SHIPMENT_WEIGHED', provider_code: 'TRT_SHIPMENT_WEIGHED' },
    ]);
  });

  it('binds the reply to the whole requested number and rejects malformed shipments', () => {
    expect(() => parseOmniva(JSON.parse(text('collected')), 'CC900000022EE')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (payload: Reply) => { delete payload.shipmentBarcode; },
      (payload: Reply) => { payload.events[0]!.eventDate = '2026-03-02T08:10:42.1234567'; },
      (payload: Reply) => { payload.events[0]!.eventCode = ''; },
      (payload: Reply) => { (payload as { events: unknown }).events = {}; },
      (payload: Reply) => { (payload.events as unknown[])[0] = 'scan'; },
      (payload: Reply) => { payload.currentStateCode = 'not a code'; },
    ]) expect(() => parseOmniva(edited('collected', change), COLLECTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [[], null, 'shipment']) expect(() => parseOmniva(payload, COLLECTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the empty object as a missing item and recognizes known items from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('collected'))).mockResolvedValueOnce(reply(text('not-found')));
    await expect(carrier(fetcher).recognize!(COLLECTED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T17:05:22.097Z' });
    await expect(carrier(fetcher).recognize!(COLLECTED)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const absent = vi.fn<typeof fetch>().mockResolvedValue(reply('{}'));
    await expect(carrier(absent).track({ number: COLLECTED })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('{}', status));
      await expect(carrier(fetcher).track({ number: COLLECTED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(COLLECTED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages and malformed replies apart from missing items', async () => {
    for (const [body, kind] of [
      ['<html><head><title>Just a moment...</title></head></html>', 'challenge'],
      ['<html><head><title>403 Forbidden</title></head><body><center>Microsoft-Azure-Application-Gateway/v2</center></body></html>', 'challenge'],
      ['<html><body>Maintenance</body></html>', 'schema'], ['{"items":[]}', 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/html' } }));
      await expect(carrier(fetcher).recognize!(COLLECTED), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: COLLECTED })).rejects.toThrow('unexpectedly large');
  });

  it('takes S10 codes, JJEE parcel ids and ZA numbers, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['CC900000018EE', 'JJEE9000000000000000', 'JJEE9000000000000000001', 'JJEEAB900000000001', 'ZA1234567', '123456789', 'ABC']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const any = vi.fn<typeof fetch>().mockImplementation(async () => reply('{}'));
    for (const number of ['RR900000019DE', 'JJEEABC90000000001', 'ZA90000001', COURIER]) {
      await expect(carrier(any).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(any.mock.calls.map(([url]) => String(url).slice(OMNIVA_ENDPOINT.length))).toEqual(['RR900000019DE', 'JJEEABC90000000001', 'ZA90000001', COURIER]);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('collected')));
    await expect(carrier(flaky).track({ number: COLLECTED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('collected')));
    await expect(carrier(immediate).track({ number: COLLECTED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: COLLECTED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: COLLECTED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes an item filed under Omniva to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('collected')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: COLLECTED, carrier: 'omniva' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'omniva', source: 'omniva', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === OMNIVA_ENDPOINT + COLLECTED)).toBe(true);
  });

  it('is named for its own items, asked about its other Estonian S10 codes, and claims JJEE ids', () => {
    expect(detectCarrierMatch(COLLECTED)).toMatchObject({ carrier: 'omniva', confidence: 'high' });
    expect(detectCarrierMatch('RO900000019EE')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers('RO900000019EE')[0]).toBe('omniva');
    expect(recognitionAskedCarriers('CC900000018EE')).not.toContain('omniva');
    expect(recognitionAskedCarriers('RR900000019DE')).not.toContain('omniva');
    expect(detectCarrierMatch(COURIER)).toMatchObject({ carrier: 'omniva', confidence: 'high' });
    expect(parseTrackingInput(`https://mana.omniva.lv/track/${COURIER}`)).toMatchObject({ trackingNumber: COURIER, carrier: 'omniva', source: 'link' });
  });
});

describe('Omniva status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(stage);
      expect(omnivaEventStage(entry.code) ?? omnivaState(entry.code)?.stage, entry.code).toBe(stage);
    }
    for (const code of ['constructor', 'toString', '__proto__']) expect(statusMap.stage(code, ''), code).toBeUndefined();
    expect(statusMap.stage(null, 'shipment delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'omniva', providerCode: 'TRT_SHIPMENT_STORED_IN_PM', description: 'Shipment is ready for collection from the parcel machine' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'omniva', providerCode: 'TRT_SHIPMENT_ARRIVAL_PM_NOTIFICATION', description: 'A notification of shipment arrival has been sent' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});
