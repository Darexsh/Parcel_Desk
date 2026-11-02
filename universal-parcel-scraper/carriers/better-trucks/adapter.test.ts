import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BETTER_TRUCKS_API, betterTrucksLookupUrl, BetterTrucksTracker } from './adapter.js';
import { normalizeBetterTrucksNumber, parseBetterTrucks } from './parser.js';
import { betterTrucksStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'BTPA0123SMPL001';
const IN_TRANSIT = 'BTS_0123SMPL002';
const UNKNOWN = 'BTPA0999SMPL999';

type Row = Record<string, unknown>;
type Reply = Row & { tracking_number: string; tracking_status: Row; tracking_history: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const transit = (change: (body: Reply) => void) => changed('in-transit', change);
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const events = (result: ReturnType<typeof parseBetterTrucks>) => result.events!.map((event) => [event.time, event.description,
  event.stage ?? null, event.location ?? null, event.provider_code ?? null]);
// A scan in the history's shape, at a hub in winter time.
const scan = (status: string, details: string, time: string, local: string): Row => ({
  relative_time: [{ name: 'GREENWICH_MEAN_TIME', time, timezone: 'GMT+00:00' }, { name: 'LOCAL_TIME', time: local, timezone: 'GMT-06:00' }],
  object_created: time, status, status_details: details, location: { city: 'Sampleton', state: 'TX', zip: '77999', country: 'US' },
  latitude: 29.9001, longitude: -95.2002, location_info: null, event_details: null, images: null,
});

describe('Better Trucks HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BetterTrucksTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' bts_0123smpl002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BETTER_TRUCKS_API}${IN_TRANSIT}?isFromExternalTracking=true`);
    expect(betterTrucksLookupUrl('bts_0123smpl002')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'better-trucks', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history as instants in the scans’ own offsets, without who took it, where it was left or the photos', () => {
    const result = parseBetterTrucks(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2026-07-08T14:42:05-05:00', delivered_at: '2026-07-08T14:42:05-05:00', destination_country: 'US',
    });
    expect(events(result)).toEqual([
      ['2026-07-08T14:42:05-05:00', 'Delivered', 'delivered', 'Sampleton, TX', 'DELIVERED'],
      ['2026-07-08T09:05:31-05:00', 'Out For Delivery', 'out_for_delivery', 'Sampleton, TX', 'OUT_FOR_DELIVERY'],
      ['2026-07-07T18:15:00-05:00', 'Return To Station', 'failed_attempt', 'Sampleton, TX', 'RTS_RETURNED_TO_STATION'],
      ['2026-07-07T16:30:12-05:00', 'Delivery attempted', 'failed_attempt', 'Sampleton, TX', 'DELIVERY_FAILURE'],
      ['2026-07-07T08:58:40-05:00', 'Out For Delivery', 'out_for_delivery', 'Sampleton, TX', 'OUT_FOR_DELIVERY'],
      ['2026-07-07T05:20:44-05:00', 'Received at SMP hub', 'in_transit', 'Sampleton, TX', 'SCANNED_AT_HUB_SMP'],
      ['2026-07-06T20:12:09-05:00', 'Scanned at BT facility', 'in_transit', null, 'SCANNED_AT_HUB'],
      ['2026-07-06T20:11:52-05:00', 'Received in BT network', 'accepted', null, 'INJECTED'],
      ['2026-07-06T03:03:15-05:00', 'Shipment created', 'registered', 'Exampleville, TX', 'SHIPMENT_CREATED'],
    ]);
    // Only the hub scan with a town keeps its point; the door and the shipper's site do not.
    expect(result.events!.filter((event) => event.point)).toEqual([expect.objectContaining({
      provider_code: 'SCANNED_AT_HUB_SMP', point: { latitude: 29.9001, longitude: -95.2002 } })]);
    expect(JSON.stringify(result)).not.toMatch(/Jordan|Front Door|Recipient not available|sample-photo|storage\.googleapis|77999|75999|29\.9876|33\.0101|00000000-/);
    expect(result).not.toHaveProperty('expected_delivery');
  });

  it('reads an in-transit underscore number in winter time, and a scan without a local reading in UTC', () => {
    const result = parseBetterTrucks(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Received at SMP hub',
      last_update: '2026-01-21T05:47:26-06:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(events(result)).toEqual([
      ['2026-01-21T05:47:26-06:00', 'Received at SMP hub', 'in_transit', 'Sampleton, TX', 'SCANNED_AT_HUB_SMP'],
      ['2026-01-20T20:33:58-06:00', 'Scanned at BT facility', 'in_transit', null, 'SCANNED_AT_HUB'],
      ['2026-01-20T20:33:01-06:00', 'Received in BT network', 'accepted', null, 'INJECTED'],
      ['2026-01-20T10:09:38-06:00', 'Shipment created', 'registered', 'Exampleville, TX', 'SHIPMENT_CREATED'],
    ]);
    const clock = (change: (row: Row) => void) => parseBetterTrucks(transit((body) => change(body.tracking_history[0]!)), IN_TRANSIT).events![0]!.time;
    // No local reading, one at GMT+00:00, or one that is not the same instant: the scan stays in UTC.
    expect(clock((row) => { row.relative_time = null; })).toBe('2026-01-21T11:47:26Z');
    expect(clock((row) => { row.relative_time = [{ name: 'LOCAL_TIME', time: '2026-01-21T11:47:26', timezone: 'GMT+00:00' }]; }))
      .toBe('2026-01-21T11:47:26Z');
    expect(clock((row) => { row.relative_time = [{ name: 'LOCAL_TIME', time: '2026-01-21T06:47:26', timezone: 'GMT-06:00' }]; }))
      .toBe('2026-01-21T11:47:26Z');
    expect(clock((row) => { row.relative_time = [{ name: 'LOCAL_TIME', time: '2026-01-21T05:47:26', timezone: 'America/Chicago' }]; }))
      .toBe('2026-01-21T11:47:26Z');
    expect(clock((row) => { row.object_created = '2026-01-21T11:47:26.5123'; row.relative_time = []; })).toBe('2026-01-21T11:47:26Z');
    // A clock written with its offset is the same instant.
    expect(clock((row) => { row.object_created = '2026-01-21T11:47:26+00:00'; })).toBe('2026-01-21T05:47:26-06:00');
    expect(clock((row) => { row.object_created = '2026-01-21T05:47:26-06:00'; })).toBe('2026-01-21T05:47:26-06:00');
  });

  it('keeps a wait for the address’s confirmation as the status until the address is corrected', () => {
    const waiting = transit((body) => {
      body.tracking_history.unshift(scan('AWAITING_ADDRESS_CONFIRMATION', 'Awaiting address confirmation', '2026-01-21T15:00:00', '2026-01-21T09:00:00'));
    });
    expect(parseBetterTrucks(waiting, IN_TRANSIT)).toMatchObject({ status: 'exception', current_stage: 'exception',
      last_status_text: 'Awaiting address confirmation' });
    const corrected = transit((body) => {
      body.tracking_history.unshift(scan('ADDRESS_CORRECTED', 'Address corrected', '2026-01-21T17:30:00', '2026-01-21T11:30:00'),
        scan('AWAITING_ADDRESS_CONFIRMATION', 'Awaiting address confirmation', '2026-01-21T15:00:00', '2026-01-21T09:00:00'));
    });
    const result = parseBetterTrucks(corrected, IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Address corrected',
      last_update: '2026-01-21T11:30:00-06:00' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events![1]).toMatchObject({ provider_code: 'AWAITING_ADDRESS_CONFIRMATION', stage: 'exception' });
  });

  it('stages the codes the page names, words a code without wording, and leaves the page’s hidden rows out', () => {
    const newest = (status: string, details: string | null) => parseBetterTrucks(transit((body) => {
      body.tracking_history.unshift({ ...scan(status, '', '2026-01-21T15:00:00', '2026-01-21T09:00:00'), status_details: details });
    }), IN_TRANSIT);
    expect(newest('VGO_PARCEL_READY_FOR_RECIPIENT_PICKUP', 'Ready for pickup')).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    expect(newest('VGO_PARCEL_PICKED_UP_BY_RECIPIENT', 'Picked up')).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      delivered_at: '2026-01-21T09:00:00-06:00' });
    expect(newest('LOADED_ON_DELIVERY_VEHICLE', null)).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Loaded on delivery vehicle' });
    expect(newest('SCANNED_AT_HUB_NYC', 'Received at NYC hub').events![0]).toMatchObject({ stage: 'in_transit', point: { latitude: 29.9001 } });
    // A code the map leaves unstaged keeps the scan before it as the status, whatever its wording says.
    expect(newest('SHIPMENT_CHANGED', 'Delivered')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Delivered' });
    // A code the map does not know falls to the shared wording rules.
    expect(newest('SAMPLE_NEW_CODE', 'Out for delivery').events![0]).toMatchObject({ stage: 'out_for_delivery', stage_source: 'wording:language' });
    expect(newest('SAMPLE_NEW_CODE', 'Sample note').events![0]).not.toHaveProperty('stage');
    for (const hidden of ['TRANSACTION_CREATED', 'ONFLEET_FAILED']) {
      expect(newest(hidden, 'Sample').events!.map((event) => event.provider_code)).not.toContain(hidden);
    }
    // A history of hidden rows only has nothing to show.
    expect(() => parseBetterTrucks(transit((body) => { body.tracking_history = [body.tracking_history[3]!]; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the unknown answer as not found, and a reply only when it names the number asked', () => {
    expect(() => parseBetterTrucks(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBetterTrucks(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate',
      message: 'Better Trucks answered for another parcel' }));
    expect(() => parseBetterTrucks(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker answers in upper case for a number typed in lower case.
    expect(parseBetterTrucks(transit((body) => { body.tracking_number = ' bts_0123smpl002 '; }), IN_TRANSIT).events).toHaveLength(4);
    // A known number without scans is not an unknown one.
    expect(() => parseBetterTrucks(transit((body) => { body.tracking_history = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).tracking_number; },
      (body: Reply) => { (body as Row).tracking_number = 12; },
      (body: Reply) => { (body as Row).tracking_history = 'none'; },
      (body: Reply) => { body.tracking_history[0] = 'scan' as never; },
      (body: Reply) => { body.tracking_history[0]!.status = null; },
      (body: Reply) => { body.tracking_history[0]!.status = 7; },
      (body: Reply) => { body.tracking_history[0]!.status_details = ['Received']; },
      (body: Reply) => { body.tracking_history[0]!.location = 'Sampleton, TX'; },
      (body: Reply) => { body.tracking_history[0]!.location = { city: 7 }; },
      (body: Reply) => { body.tracking_history[0]!.object_created = '01/21/2026 11:47 AM'; },
      (body: Reply) => { body.tracking_history[0]!.object_created = '2026-01-21T24:00:00'; },
      (body: Reply) => { body.tracking_history[0]!.object_created = '2026-02-30T08:00:00'; },
      (body: Reply) => { body.tracking_history[0]!.object_created = null; },
      (body: Reply) => { body.tracking_history[0]!.relative_time = { name: 'LOCAL_TIME' }; },
      (body: Reply) => { body.tracking_history = Array.from({ length: 501 }, () => body.tracking_history[0]!); },
    ]) {
      expect(() => parseBetterTrucks(transit(change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', null, [], {}, { tracking_number: IN_TRANSIT }]) {
      expect(() => parseBetterTrucks(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://tracking.bettertrucks.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHALLENGE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    // The tracker's own page in place of the reply is a changed route, not a missing parcel.
    await expect(lookup('<!doctype html><html><head><title>Better Trucks - Tracking</title></head><body><div id="root"></div></body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ title: 'One or more validation errors occurred.', status: 400 })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ title: 'Synthetic failure' }, { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown answer, and asks nothing for a package code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-07-08T19:42:05.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(fetcher).recognize!('7H3N2')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects package codes and what Better Trucks does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // Five-character package codes, and BTS with a code and no underscore, stand for another number.
    for (const number of ['7H3N2', '7h3n2', 'BTS7H3N2', 'BTS7H3N2ABCDE', 'BTSA0123SMPL002']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input',
        message: 'Better Trucks package codes are not tracking numbers' });
    }
    for (const number of ['12345', 'BTPA01234', 'BTPASAMPLEXYZ', 'BTPA0123/SMPL01', 'BTPA0123%SMPL01', `BTPA0123SMPL001${'1'.repeat(30)}`, `${'1'.repeat(65)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const [typed, number] of [[' btpa-0123-smpl001 ', DELIVERED], [IN_TRANSIT, IN_TRANSIT], ['BTO_0123SMPL003', 'BTO_0123SMPL003']]) {
      expect(normalizeBetterTrucksNumber(typed!), typed).toBe(number);
    }
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a number the caller names Better Trucks’ to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'better-trucks' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'better-trucks', source: 'better-trucks', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === betterTrucksLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Better Trucks numbers', () => {
  it('offers BTPA numbers to recognition, and reads tracker links', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['better-trucks'] });
    expect(recognitionAskedCarriers(DELIVERED)).toEqual(['better-trucks']);
    for (const link of [`https://tracking.bettertrucks.com/tracking?trackingNumber=${DELIVERED}`,
      `https://tracking.bettertrucks.com/Tracking?ShipmentId=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'better-trucks', source: 'link' });
    }
  });
});

describe('Better Trucks status vocabulary', () => {
  it('records every code the map knows with the stage it gives, and the codes it leaves unstaged', () => {
    for (const entry of statuses.entries as { code?: string; wording?: string; stage?: string; unmapped?: boolean }[]) {
      if (!entry.code) {
        // The page's own labels, which replace a scan's wording; the shared rules read them.
        expect(betterTrucksStage('', entry.wording!)?.stage, entry.wording).toBe(entry.stage);
        continue;
      }
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording ?? '')), entry.code).toBe(entry.stage);
      expect(betterTrucksStage(entry.code, entry.wording ?? '') ?? null, entry.code)
        .toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
      if (entry.unmapped) expect(statusMap.gaps.map((gap) => gap.code), entry.code).toContain(entry.code);
    }
    expect(statusMapAnswer({ carrier: 'better-trucks', providerCode: 'DELIVERED', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'better-trucks', providerCode: 'SCANNED_AT_HUB_ABC', description: 'Received at ABC hub' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'better-trucks', providerCode: 'ADDRESS_CORRECTED', description: 'Address corrected' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    expect(statusMapAnswer({ carrier: 'better-trucks', providerCode: 'SAMPLE_NEW_CODE', description: 'sample note' })).toEqual({ kind: 'unknown' });
  });
});
