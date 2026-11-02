import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CONNECT_COURIERS_ACTION, CONNECT_COURIERS_API, ConnectCouriersTracker } from './adapter.js';
import { connectCouriersWording, normalizeConnectCouriersNumber, parseConnectCouriers } from './parser.js';
import { connectCouriersStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '00000000017';
const IN_TRANSIT = '00000000025';
const OTHER_PIECE = '00000000033';
const UNKNOWN = '00000000000';

type Row = Record<string, unknown>;
type Group = Row & { items: Row[] };
type Shipment = Row & { packageData: Row[]; trackingHistory: Group[] };
type Reply = Row & { data: Shipment };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (stageStatus: string, stageDateTime: string, packages: string[] = [IN_TRANSIT]) => ({
  packageCount: packages.length, packages: packages.map((trackingNumber) => ({ trackingNumber })), username: 'sample@connect', stageStatus, stageDateTime,
});

describe('Connect Couriers HTTP adapter', () => {
  it('posts the whole number to the tracking page’s WordPress action once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ConnectCouriersTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 000 0000 0025 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(CONNECT_COURIERS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ action: CONNECT_COURIERS_ACTION, tracking_number: IN_TRANSIT });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'connect-couriers', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('orders a day’s scans by their wall clocks and keeps neither the staff accounts nor the recipient’s town', () => {
    const result = parseConnectCouriers(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-12T15:20:00', destination_country: 'MT' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-03-12T15:20:00', 'Delivered', 'delivered'],
      ['2026-03-12T12:05:00', 'Awaiting collection by recipient as requested', 'ready_for_pickup'],
      ['2026-03-12T09:40:00', 'Attempted Delivery / Client not home', 'failed_attempt'],
      ['2026-03-12T07:30:00', 'Out for Delivery', 'out_for_delivery'],
      ['2026-03-10T10:02:00', 'Attempted Delivery / Client not home', 'failed_attempt'],
      ['2026-03-10T07:51:00', 'Out for Delivery', 'out_for_delivery'],
      ['2026-03-10T06:15:00', 'Arrived at Operations Facility - Malta', 'in_transit'],
      ['2026-02-27T19:48:00', 'Shipment data received', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    expect(JSON.stringify(result)).not.toMatch(/sample\.|@connect|@partner|SAMPLETOWN|100001|Package|Origin|Shipment picked up/i);
  });

  it('keeps the scans of the piece asked out of a consignment of several', () => {
    const result = parseConnectCouriers(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at Operations Facility - Malta', last_update_local: '2026-05-06T06:40:00', destination_country: 'MT' });
    // The other piece's delivery round is not this parcel's.
    expect(result.events!.map((event) => event.description)).toEqual(['Arrived at Operations Facility - Malta', 'Shipment data received']);
    // A scan that names no piece concerns them all; a repeated one is kept once.
    const shared = parseConnectCouriers(changed('in-transit', (data) => {
      data.trackingHistory[0]!.items.push({ ...scan('Out for Delivery', '2026-05-07T07:55:00'), packages: [], packageCount: 0 });
      data.trackingHistory[1]!.items.push(scan('Shipment data received', '2026-05-02T11:26:00'));
      data.trackingHistory.push({ groupDate: '2026-05-01T00:00:00', items: null as never });
    }), IN_TRANSIT);
    expect(shared.events!.map((event) => event.stage)).toEqual(['out_for_delivery', 'in_transit', 'registered']);
    expect(shared).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
  });

  it('takes the headline status’s word for a delivery or a cancellation, and the newest scan’s otherwise', () => {
    const cancelled = parseConnectCouriers(changed('in-transit', (data) => { data.packageData[1]!.stageStatus = 'Cancelled'; }), IN_TRANSIT);
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at Operations Facility - Malta' });
    // The other piece's headline is not this parcel's.
    expect(parseConnectCouriers(changed('in-transit', (data) => { data.packageData[0]!.stageStatus = 'Delivered'; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
    // A scan the map does not know falls to the shared wording rules.
    const unmapped = parseConnectCouriers(changed('in-transit', (data) => {
      data.trackingHistory[0]!.items.push(scan('Synthetic note', '2026-05-06T09:00:00'));
    }), IN_TRANSIT);
    expect(unmapped).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note', last_update_local: '2026-05-06T09:00:00' });
    expect(unmapped.events![0]!.stage).toBeUndefined();
  });

  it('takes a signatory and phone numbers out of the wording', () => {
    expect(connectCouriersWording('Delivered - signed by Sample Person')).toBe('Delivered');
    expect(connectCouriersWording('Delivered (signed for by Sample Person)')).toBe('Delivered');
    expect(connectCouriersWording('Attempted Delivery / Client not home, call +000 0000 0000')).toBe('Attempted Delivery / Client not home, call');
    expect(connectCouriersWording(' Out for Delivery ')).toBe('Out for Delivery');
    expect(connectCouriersWording('Awaiting collection by recipient as requested')).toBe('Awaiting collection by recipient as requested');
  });

  it('reads an unknown number as not found, a failed lookup as inconclusive and a shipment without scans as no history', () => {
    expect(() => parseConnectCouriers(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseConnectCouriers({ success: false, data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseConnectCouriers({ success: false, data: { message: 'Synthetic failure' } }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseConnectCouriers(changed('delivered', (data) => { data.trackingHistory = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseConnectCouriers(changed('in-transit', (data) => { data.trackingHistory[0]!.items.splice(1); data.trackingHistory.splice(1); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it and one of its pieces name the number asked', () => {
    expect(() => parseConnectCouriers(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Connect Couriers answered for another shipment' }));
    expect(() => parseConnectCouriers(changed('in-transit', (data) => { data.packageData.splice(1); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseConnectCouriers(changed('in-transit', (data) => { data.trackingNumber = OTHER_PIECE; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_data: Shipment, body: Reply) => { delete (body as Row).success; },
      (_data: Shipment, body: Reply) => { body.success = 'true'; },
      (_data: Shipment, body: Reply) => { body.data = 'shipment' as never; },
      (data: Shipment) => { delete data.trackingNumber; },
      (data: Shipment) => { data.trackingNumber = 25; },
      (data: Shipment) => { data.packageData = 'pieces' as never; },
      (data: Shipment) => { data.trackingHistory = 'history' as never; },
      (data: Shipment) => { data.trackingHistory[0] = 'group' as never; },
      (data: Shipment) => { data.trackingHistory[0]!.items = 'scans' as never; },
      (data: Shipment) => { data.trackingHistory[0]!.items[1] = 'scan' as never; },
      (data: Shipment) => { data.trackingHistory[0]!.items[1]!.packages = 'pieces'; },
      (data: Shipment) => { data.trackingHistory[0]!.items[1]!.packages = [IN_TRANSIT]; },
      (data: Shipment) => { data.trackingHistory[0]!.items[1]!.stageDateTime = '06/05/2026 06:40'; },
      (data: Shipment) => { data.trackingHistory[0]!.items[1]!.stageDateTime = '2026-05-06T24:00:00'; },
      (data: Shipment) => { data.trackingHistory[0]!.items[1]!.stageDateTime = '2026-02-30T06:40:00'; },
      (data: Shipment) => { data.trackingHistory[0]!.items[1]!.stageDateTime = '2026-05-06T06:40:00+02:00'; },
      (data: Shipment) => { data.trackingHistory[0]!.items[1]!.stageDateTime = null; },
      (data: Shipment) => { data.trackingHistory[0]!.items[1]!.stageStatus = ['Delivered']; },
      (data: Shipment) => { data.trackingHistory[0]!.items[1]!.stageStatus = ' '; },
      (data: Shipment) => { data.trackingHistory[0]!.items = Array.from({ length: 501 }, () => data.trackingHistory[0]!.items[1]!); },
    ]) {
      expect(() => parseConnectCouriers(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A fraction of a second is dropped.
    expect(parseConnectCouriers(changed('in-transit', (data) => { data.trackingHistory[0]!.items[1]!.stageDateTime = '2026-05-06T06:40:00.25'; }), IN_TRANSIT))
      .toMatchObject({ last_update_local: '2026-05-06T06:40:00' });
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The tracker answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.connectcouriers.eu/' } })).rejects.toMatchObject({ kind: 'transport' });
    // WordPress's answer for an action no plugin registers.
    await expect(lookup('0', { status: 400 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('0')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<p>There has been a critical error on this website.</p>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Connect Couriers does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-12T15:20:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('CC00000000017')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Connect Couriers does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000017', 'SAMPLETRACKING', 'CC00000000017', '0'.repeat(21)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeConnectCouriersNumber('000-0000 0017')).toBe(DELIVERED);
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

  it('routes a number filed under Connect Couriers to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'connect-couriers' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'connect-couriers', source: 'connect-couriers', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === CONNECT_COURIERS_API)).toBe(true);
  });
});

describe('Connect Couriers status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(connectCouriersStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'connect-couriers', providerCode: null, description: 'Attempted Delivery / Client not home' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'connect-couriers', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(connectCouriersStage('Shipment returned to sender')).toMatchObject({ stage: 'returned' });
    expect(connectCouriersStage('Synthetic note')).toBeNull();
  });
});
