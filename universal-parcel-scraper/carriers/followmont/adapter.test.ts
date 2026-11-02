import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FOLLOWMONT_BOOKING_API, FOLLOWMONT_TRACE_API, FollowmontTracker } from './adapter.js';
import { followmontBookingWindow, normalizeFollowmontNumber, parseFollowmontBooking, parseFollowmontTrace } from './parser.js';
import { followmontMappedStage, followmontStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '12345679';
const IN_TRANSIT = 'P123456789';
const BOOKED = 'U1234567';
const UNKNOWN = '0000000';
// 9 July 2026, 01:30 UTC.
const NOW = Date.UTC(2026, 6, 9, 1, 30);

type Row = Record<string, unknown>;
type Consignment = Row & { Events: Row[] };
type Reply = Row & { Consignments: Consignment[] };

const fixture = <T = Reply>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const changed = (name: string, change: (consignment: Consignment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.Consignments[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
/** Answers the freight system's trace and the bookings search with their own replies. */
const routed = (trace: () => Response, booking: () => Response = () => reply(fixture('booking-not-found'))) =>
  vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === FOLLOWMONT_TRACE_API ? trace() : booking()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const tracker = (fetcher: typeof fetch) => new FollowmontTracker({ fetcher, userAgent: 'SyntheticHost/1.0', now: () => NOW });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Followmont HTTP adapter', () => {
  it('asks the freight system’s trace for the whole number once, as the page does', async () => {
    const fetcher = routed(() => reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const lookup = new FollowmontTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => NOW });
    await expect(lookup.fetch(' 1234-5679 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(FOLLOWMONT_TRACE_API);
    expect(url).toMatch(/^https:\/\/www\.followmont\.com\.au\/ic\/builder\/rt\/followmont_master\/live;profile=development\/services\/auth\/1\.1\/proxy\/oracleIntegrationCloud\//);
    expect(JSON.parse(String(init.body))).toEqual({ ConsignmentIDs: DELIVERED });
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'followmont', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered consignment from its items’ scans, newest first, as wall clocks', () => {
    const result = parseFollowmontTrace(fixture('delivered'), DELIVERED)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery', last_update: null, last_update_local: '2026-03-03T09:15:30', expected_delivery: null });
    // Each item's scan of one kind at one place in the same minute is kept once, at its first clock.
    expect(result.events).toEqual([
      { local_time: '2026-03-03T09:15:30', location: 'TESTVILLE', description: 'Delivery', provider_code: 'DELIVERY', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-03-03T07:45:10', description: 'On Delivery', provider_code: 'ONDELIVERY', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-03-03T06:30:00', description: 'Depot In', provider_code: 'DEPOTIN', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-03-02T17:20:05', location: 'EXAMPLE HUB', description: 'Tunnel', provider_code: 'TUNNEL', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-03-02T10:05:00', location: 'SAMPLETON', description: 'Pickup', provider_code: 'PICKUP', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // Addresses, parties, the account code and handling notes stay out.
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE ST|SAMPLE RD|PTY LTD|SAMPLE001|TRACE MATCH|0000|-000\d/);
  });

  it('keeps the estimate in transit, a booking row without a stage and no address as a place', () => {
    const result = parseFollowmontTrace(fixture('in-transit'), IN_TRANSIT)!;
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Depot In',
      last_update_local: '2026-07-08T05:55:00', expected_delivery: '2026-07-09' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-07-08T05:55:00', 'DEPOTIN', 'EXAMPLE DOWNS', 'in_transit'],
      // A place with a digit is an address or a dock, not a town.
      ['2026-07-06T21:40:00', 'LHLOAD', null, 'in_transit'],
      ['2026-07-06T14:12:00', 'PICKUP', 'SAMPLE CREEK', 'accepted'],
      ['2026-07-06T14:10:00', 'PICKUP', 'SAMPLE CREEK', 'accepted'],
      ['2026-07-03T11:00:00', 'ADDED', null, null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/TEST LANE|EXAMPLE AVE|SAMPLE SUPPLIES|TEST CUSTOMER|SAMPLE DOCK|SAMPLE002/);
  });

  it('reads a consignment the freight system holds without scans as booked', () => {
    const empty = changed('in-transit', (consignment) => { consignment.Events = []; });
    expect(parseFollowmontTrace(empty, IN_TRANSIT)).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment Info Received', last_update: null, expected_delivery: '2026-07-09', summary_only: true, events: [] });
    const unlisted = changed('in-transit', (consignment) => { delete (consignment as Row).Events; });
    expect(parseFollowmontTrace(unlisted, IN_TRANSIT)).toMatchObject({ current_stage: 'registered', summary_only: true });
    const recorded = changed('in-transit', (consignment) => { consignment.Events = consignment.Events.slice(0, 1); });
    expect(parseFollowmontTrace(recorded, IN_TRANSIT)).toMatchObject({ status: 'pending', current_stage: 'registered',
      last_status_text: 'Shipment Info Received', last_update_local: '2026-07-03T11:00:00', events: [{ provider_code: 'ADDED' }] });
  });

  it('leaves an event the system has no date for out, and an estimate it has none for empty', () => {
    const result = parseFollowmontTrace(changed('in-transit', (consignment) => {
      consignment.ETA = '1899-12-30 00:00:00';
      consignment.Events[5]!.EventDate = '1899-12-30 00:00:00';
      consignment.Events[6]!.EventDate = '1899-12-30 00:00:00';
    }), IN_TRANSIT)!;
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'LHLOAD', expected_delivery: null });
    expect(result.events).toHaveLength(4);
  });

  it('asks the bookings of the past month when the freight system holds no consignment', async () => {
    const fetcher = routed(() => reply(fixture('not-found')), () => reply(fixture('booking')));
    await expect(tracker(fetcher).fetch(BOOKED)).resolves.toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', last_status_text: 'Shipment Info Received', last_update: null, expected_delivery: null,
      summary_only: true, events: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(FOLLOWMONT_BOOKING_API);
    expect(JSON.parse(String(init.body))).toEqual({ ConID: BOOKED, FromDate: '2026-06-09', ToDate: '2026-07-10' });
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal) });
    expect(followmontBookingWindow(Date.UTC(2026, 2, 31, 23, 0))).toEqual({ FromDate: '2026-02-28', ToDate: '2026-04-01' });
  });

  it('reads a number neither the freight system nor the bookings hold as not found', async () => {
    expect(parseFollowmontTrace(fixture('not-found'), UNKNOWN)).toBeNull();
    expect(() => parseFollowmontBooking(fixture('booking-not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = routed(() => reply(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Another refusal of either is no answer about the consignment.
    for (const body of [{ Status: 'N', Description: 'Internal Error' }, { Status: 'E', Description: 'Not Found' }]) {
      expect(() => parseFollowmontTrace(body, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
      expect(() => parseFollowmontBooking(body, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    await expect(carrier(routed(() => reply({ Status: 'N', Description: 'Timeout' }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps only a consignment that names the whole number asked', () => {
    expect(() => parseFollowmontTrace(fixture('delivered'), `${DELIVERED.slice(0, 7)}`))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Followmont answered for another consignment' }));
    expect(() => parseFollowmontTrace(changed('delivered', (consignment) => { consignment.ConsignmentNumber = 'P123456789'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFollowmontTrace(changed('delivered', (consignment) => { consignment.ConId = `${DELIVERED} 9`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Another consignment beside the one asked is not read.
    const both = changed('delivered', (_consignment, body) => { body.Consignments.push(fixture('in-transit').Consignments[0]!); });
    expect(parseFollowmontTrace(both, DELIVERED)).toMatchObject({ current_stage: 'delivered', events: { length: 5 } });
    expect(JSON.stringify(parseFollowmontTrace(both, DELIVERED))).not.toMatch(/SAMPLE CREEK|LHLOAD/);
    expect(parseFollowmontTrace(changed('in-transit', (consignment) => { consignment.ConId = 'p123456789 '; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit' });
    // The bookings search also finds references, and does not repeat them.
    expect(() => parseFollowmontBooking(fixture('booking'), 'P123456789'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Followmont answered for another consignment' }));
  });

  it('rejects a changed reply', () => {
    for (const [index, change] of [
      (_consignment: Consignment, body: Reply) => { delete (body as Row).Status; },
      (_consignment: Consignment, body: Reply) => { body.Consignments = 'consignment' as never; },
      (_consignment: Consignment, body: Reply) => { body.Consignments = Array.from({ length: 21 }, () => body.Consignments[0]!); },
      (_consignment: Consignment, body: Reply) => { body.Consignments.push('consignment' as never); },
      (_consignment: Consignment, body: Reply) => { body.Consignments.push(body.Consignments[0]!); },
      (consignment: Consignment) => { consignment.Events = 'events' as never; },
      (consignment: Consignment) => { consignment.Events = Array.from({ length: 2001 }, () => consignment.Events[0]!); },
      (consignment: Consignment) => { consignment.Events[0] = 'event' as never; },
      (consignment: Consignment) => { consignment.Events[0]!.EventDate = '2026-03-03T09:15:30+10:00'; },
      (consignment: Consignment) => { consignment.Events[0]!.EventDate = '03/03/2026 09:15'; },
      (consignment: Consignment) => { consignment.Events[0]!.EventDate = '2026-02-30 09:15:30'; },
      (consignment: Consignment) => { consignment.Events[0]!.EventDate = '2026-03-03 24:00:00'; },
      (consignment: Consignment) => { delete consignment.Events[0]!.EventDate; },
      (consignment: Consignment) => { consignment.Events[0]!.EventStatus = ' '; },
      (consignment: Consignment) => { consignment.Events[0]!.EventStatus = ['Delivery']; },
      (consignment: Consignment) => { consignment.Events[0]!.EventLocation = 7; },
      (consignment: Consignment) => { consignment.ETA = 20260303; },
    ].entries()) {
      expect(() => parseFollowmontTrace(changed('delivered', change), DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseFollowmontTrace(changed('delivered', (_consignment, body) => { body.Consignments = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFollowmontTrace('Sample', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const body of ['Sample', { Status: 'S' }, { Status: 'S', items: 'items' }, { Status: 'S', items: ['item'] }]) {
      expect(() => parseFollowmontBooking(body, BOOKED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a browser check, a refusal, a moved route and a broken reply apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(routed(response)).track({ number: DELIVERED });
    await expect(lookup(() => reply(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => reply('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://www.followmont.com.au/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    // The tracker's page itself, in place of the flow's reply.
    await expect(lookup(() => reply('<!DOCTYPE html><html><oj-vb-content config="[[vbApplication]]"></oj-vb-content></html>')))
      .rejects.toMatchObject({ kind: 'schema' });
    // The bookings search is held to the same rules.
    await expect(carrier(routed(() => reply(fixture('not-found')), () => reply(CLOUDFLARE))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      await expect(carrier(routed(() => new Response('', { status }))).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(routed(() => reply(fixture('not-found')), () => new Response('', { status }))).track({ number: UNKNOWN }))
        .rejects.toMatchObject({ kind });
    });

  it('refuses what Followmont does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123456', '123456789', 'P12345', 'P12345678901', 'ABCD1234567', '1234567P', 'P1234567A', 'U1234567/1',
      '12345678,1234567', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeFollowmontNumber(' p 1234-56789 ')).toBe(IN_TRANSIT);
    expect(normalizeFollowmontNumber('0000000')).toBe(UNKNOWN);
    expect(normalizeFollowmontNumber('U1234567')).toBe(BOOKED);
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('declares no recognition: no detection rule offers its numbers', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a number filed under Followmont to the adapter', async () => {
    const fetcher = routed(() => reply(fixture('delivered')));
    const tracking = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracking.track({ number: DELIVERED, carrier: 'followmont' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'followmont', source: 'followmont', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === FOLLOWMONT_TRACE_API)).toBe(true);
  });
});

describe('Followmont status vocabulary', () => {
  it('records every event code and page status the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'followmont', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      if (entry.code) expect(followmontStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves the booking rows without a stage, and another code to the shared rules', () => {
    expect(followmontStage('ADDED', 'Added')).toBeNull();
    expect(statusMapAnswer({ carrier: 'followmont', providerCode: 'SHIPPER', description: 'Shipper' })).toMatchObject({ kind: 'intentional_gap' });
    expect(followmontMappedStage('SAMPLE')).toBeUndefined();
    expect(followmontStage('SAMPLE', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(followmontStage('SAMPLE', 'Sample')).toBeNull();
    expect(statusMap.stage('SAMPLE', 'in-transit')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'followmont', providerCode: 'SAMPLE', description: 'Sample' })).toEqual({ kind: 'unknown' });
  });
});
