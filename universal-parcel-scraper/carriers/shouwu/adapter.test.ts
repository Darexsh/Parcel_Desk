import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { sameInstantIdentityPolicy } from '../../app.js';
import { adapter, SHOUWU_API, SHOUWU_PAGE, ShouwuTracker } from './adapter.js';
import { normalizeShouwuNumber, parseShouwu } from './parser.js';
import { shouwuStage, shouwuStatusLabel, shouwuStatusStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'SWECN990000000001YQ';
const OTHER = 'SWECN990000000002YQ';
const UNKNOWN = 'SWECN990000000003YQ';

type Row = Record<string, unknown>;
type Entry = { order: Row; traces: Row[] };
type Reply = Row & { result: Row; data: Entry[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
const changed = (change: (traces: Row[], order: Row, reply: Reply) => void) => {
  const reply = fixture('delivered');
  change(reply.data[0]!.traces, reply.data[0]!.order, reply);
  return reply;
};
const trace = (traceTime: unknown, traceDesc: unknown, traceLocation: unknown = null): Row => ({ traceTime, traceDesc, traceLocation, traceType: 'TRACE_TYPE_TAIL' });
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Shouwu International HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ShouwuTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' swecn 9900-0000-0001 yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(SHOUWU_API);
    expect(JSON.parse(String(init.body))).toEqual({ strs: [DELIVERED] });
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://admin.shshouwu.com', Referer: SHOUWU_PAGE,
      'x-locale': 'zh-cn', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shouwu', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel’s scans as wall clocks on Beijing time, newest first, with their towns, its destination, and no address', () => {
    const result = parseShouwu(fixture('delivered'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Front Door', last_update: null, last_update_local: '2026-04-17T01:39:12', expected_delivery: null,
      destination_country: 'US', events: expect.any(Array) });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-04-17T01:39:12', 'SAMPLE CITY, CA', 'Delivered, Front Door', 'delivered'],
      ['2026-04-16T16:15:14', 'SAMPLE CITY, CA', 'Out for Delivery', 'out_for_delivery'],
      // A place with a digit could be an address or name a postcode, and is not read.
      ['2026-04-16T06:05:28', undefined, 'Arrived at Sorting Facility', 'in_transit'],
      ['2026-04-13T14:20:00', 'EXAMPLE GATEWAY', 'Customs clearance completed', 'in_transit'],
      ['2026-04-12T18:41:09', 'Shanghai', 'Departed from origin airport', 'in_transit'],
      // The scan listed twice counts once.
      ['2026-04-11T10:00:12', '上海', '已出库', undefined],
      ['2026-04-10T17:30:45', undefined, '已入库', 'accepted'],
      ['2026-04-10T11:12:00', undefined, 'Sample Status Note', undefined],
    ]);
    expect(result.events!.every((event) => !('time' in event) && !('provider_code' in event))).toBe(true);
    const json = JSON.stringify(result);
    for (const excluded of ['Sample Road', '99999', 'Sample Desk', 'Sample status text', 'United States', 'TRACE_TYPE', 'TRACE_STATUS']) {
      expect(json).not.toContain(excluded);
    }
  });

  it('reads epoch seconds as numbers or digits, milliseconds as the page does, and checks every clock', () => {
    const result = parseShouwu(changed((traces) => {
      traces.splice(0, traces.length, trace('1776361152', 'Delivered'), trace(1776327314999, 'Out for Delivery'), trace(1776290728, 'Arrived at Sorting Facility'));
    }), DELIVERED);
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-04-17T01:39:12', '2026-04-16T16:15:14', '2026-04-16T06:05:28']);
    // Equal instants keep the reply's order, newest first.
    const tied = parseShouwu(changed((traces) => {
      traces.splice(0, traces.length, trace(1776361152, 'Delivered'), trace(1776361152, 'Out for Delivery'));
    }), DELIVERED);
    expect(tied.events!.map((event) => event.description)).toEqual(['Delivered', 'Out for Delivery']);
    // The page shows no time for an empty or zero value; such a row places nothing.
    const timeless = parseShouwu(changed((traces) => {
      traces.splice(0, traces.length, trace(null, 'Delivered'), trace(0, 'Delivered'), trace('', 'Delivered'), trace(1776327314, 'Out for Delivery'));
    }), DELIVERED);
    expect(timeless.events!.map((event) => event.description)).toEqual(['Out for Delivery']);
    for (const time of [-1776361152, 1776361152.5, 177636115, 17763611520, '2026-04-16 17:39:12', '1776361152s', true, {}]) {
      expect(() => parseShouwu(changed((traces) => { traces[0]!.traceTime = time; }), DELIVERED), String(time))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps scans of one instant in the carrier\'s order when it lists them oldest first', () => {
    const result = parseShouwu(changed((traces) => {
      traces.splice(0, traces.length, trace(1776290728, 'Arrived at Sorting Facility'), trace(1776327314, 'Out for Delivery'), trace(1776327314, 'Delivered'));
    }), DELIVERED);
    expect(result.events!.map((event) => event.description)).toEqual(['Delivered', 'Out for Delivery', 'Arrived at Sorting Facility']);
  });

  it('lets the tracker’s status decide, refined by the newest staged scan within what the status covers', () => {
    const staged = (status: unknown, traces: Row[]) => parseShouwu(changed((rows, order) => {
      order.traceStatus = status;
      rows.splice(0, rows.length, ...traces);
    }), DELIVERED);
    // In Transit covers the delivery round, Preparing the warehouse taking the parcel.
    expect(staged('TRACE_STATUS_ON_THE_WAY', [trace(1776327314, 'Out for Delivery'), trace(1775990469, 'Departed from origin airport')]))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    expect(staged('TRACE_STATUS_ON_THE_WAY', [trace(1775990469, 'Departed from origin airport')]))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    // The page turns In Transit with the row Shouwu writes two hours after the order data, before
    // anyone has the parcel; a scan the map does not know may be the parcel moving.
    expect(staged('TRACE_STATUS_ON_THE_WAY', [trace(1776361152, 'Carrier received the shipment'), trace(1776353952, 'Shipment information received')]))
      .toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
        events: [{ stage: 'registered', stage_source: 'carrier_map' }, { stage: 'registered', stage_source: 'carrier_map' }] });
    expect(staged('TRACE_STATUS_ON_THE_WAY', [trace(1776361152, 'Carrier received the shipment'), trace(1776353952, 'Shipment information received'),
      trace(1776720000, 'Waybill printed at a partner depot')]))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(staged('TRACE_STATUS_READY', [trace(1775813445, '已入库')]))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'wording:language' });
    // The warehouse's own scans are the parcel at the warehouse, which Preparing covers.
    expect(staged('TRACE_STATUS_READY', [trace(1775990469, 'Package processing completed'), trace(1775813445, 'Arrival processing center')]))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map' });
    expect(staged('TRACE_STATUS_READY', [trace(1775990469, 'Departed from origin airport')]))
      .toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map' });
    expect(staged('TRACE_STATUS_FAILED', [trace(1776361152, 'Returned to sender'), trace(1776327314, 'Out for Delivery')]))
      .toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'wording:language' });
    expect(staged('TRACE_STATUS_FAILED', [trace(1776327314, 'Out for Delivery')]))
      .toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map' });
    // Delivered is the end: no scan refines it, and no instant dates it.
    const signed = staged('TRACE_STATUS_SIGNED', [trace(1776361152, 'Sample Status Note'), trace(1776327314, 'Out for Delivery')]);
    expect(signed).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Sample Status Note' });
    expect(signed).not.toHaveProperty('delivered_at');
    // A status the map does not know, or none, leaves the newest staged scan; a late booking record is no step back.
    for (const status of ['TRACE_STATUS_SAMPLE', null]) {
      expect(staged(status, [trace(1776361152, 'Shipment information received'), trace(1776327314, 'Out for Delivery')]), String(status))
        .toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'carrier_map', last_status_text: 'Shipment information received' });
      const unstaged = staged(status, [trace(1776361152, 'Sample Status Note')]);
      expect(unstaged, String(status)).toMatchObject({ status: 'unknown', last_status_text: 'Sample Status Note' });
      expect(unstaged, String(status)).not.toHaveProperty('current_stage');
    }
  });

  it('reads a status without scans as a summary, and a parcel with neither as no history', () => {
    expect(parseShouwu(changed((traces, order) => { order.traceStatus = 'TRACE_STATUS_READY'; traces.splice(0); }), DELIVERED)).toEqual({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map', provider_code: 'TRACE_STATUS_READY',
      last_status_text: 'Preparing', last_update: null, expected_delivery: null, destination_country: 'US', summary_only: true, events: [] });
    expect(parseShouwu(changed((_traces, order, whole) => { delete (whole.data[0] as Row).traces; order.countryCodeTwo = 'United States'; }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered', summary_only: true, last_status_text: 'Delivered' });
    for (const status of ['TRACE_STATUS_SAMPLE', null]) {
      expect(() => parseShouwu(changed((traces, order) => { order.traceStatus = status; traces.splice(0); }), DELIVERED), String(status))
        .toThrow(NoHistoryError);
    }
    // Rows without wording or a time place nothing.
    expect(() => parseShouwu(changed((traces, order) => {
      order.traceStatus = null;
      traces.splice(0, traces.length, trace(1776361152, ''), trace(1776361152, null), trace(null, 'Delivered'));
    }), DELIVERED)).toThrow(NoHistoryError);
  });

  it('reads only the tracker’s empty answer as not found, and only the entries naming the whole number asked', () => {
    expect(() => parseShouwu(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The reply names another number only.
    for (const number of [OTHER, `${DELIVERED}1`, DELIVERED.slice(1), '']) {
      expect(() => parseShouwu(changed((_traces, order) => { order.orderNo = number; }), DELIVERED), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // Beside another number's entry, ours is read; the number is matched in capitals without spaces.
    const mixed = changed((_traces, _order, whole) => {
      whole.data.unshift({ order: { orderNo: OTHER, traceStatus: 'TRACE_STATUS_READY' }, traces: [trace(1776400000, 'Sample Status Note')] });
      whole.data[1]!.order.orderNo = 'swecn990000000001yq ';
    });
    expect(parseShouwu(mixed, DELIVERED)).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-04-17T01:39:12' });
    // Of two entries under the number, the one with the newest scan is the parcel.
    const twice = changed((_traces, _order, whole) => {
      whole.data.push({ order: { orderNo: DELIVERED, traceStatus: 'TRACE_STATUS_ON_THE_WAY' }, traces: [trace(1776400000, 'Departed from origin airport')] },
        { order: { orderNo: DELIVERED, traceStatus: 'TRACE_STATUS_READY' }, traces: [] });
    });
    expect(parseShouwu(twice, DELIVERED)).toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-04-17T12:26:40' });
    expect(parseShouwu(twice, DELIVERED)).not.toHaveProperty('destination_country');
  });

  it('keeps a failed lookup apart, and rejects a changed reply', () => {
    for (const payload of [{ result: { code: 500 } }, { result: { code: 505, message: 'Content-Type not supported' } }, { result: { code: 1000 }, data: [] }]) {
      expect(() => parseShouwu(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const change of [
      (_traces: Row[], order: Row) => { delete order.orderNo; },
      (_traces: Row[], order: Row) => { order.orderNo = 990000000001; },
      (_traces: Row[], order: Row) => { order.traceStatus = 7; },
      (_traces: Row[], order: Row) => { order.traceStatus = 'Delivered'; },
      (_traces: Row[], order: Row) => { order.countryCodeTwo = ['US']; },
      (traces: Row[]) => { traces[0]!.traceDesc = 7; },
      (traces: Row[]) => { traces[0]!.traceLocation = ['SAMPLE CITY']; },
      (traces: Row[]) => { traces.push('scan' as unknown as Row); },
      (traces: Row[]) => { traces.push(...Array.from({ length: 500 }, () => trace(1776290728, 'Arrived at Sorting Facility'))); },
      (_traces: Row[], _order: Row, whole: Reply) => { (whole.data[0] as Row).traces = {}; },
      (_traces: Row[], _order: Row, whole: Reply) => { (whole.data[0] as Row).order = null; },
      (_traces: Row[], _order: Row, whole: Reply) => { whole.data.push(null as unknown as Entry); },
      (_traces: Row[], _order: Row, whole: Reply) => { whole.data.push(...Array.from({ length: 20 }, () => ({ order: { orderNo: OTHER }, traces: [] }))); },
      (_traces: Row[], _order: Row, whole: Reply) => { delete (whole as Row).data; },
      (_traces: Row[], _order: Row, whole: Reply) => { (whole as Row).data = {}; },
      (_traces: Row[], _order: Row, whole: Reply) => { whole.result.code = '0'; },
      (_traces: Row[], _order: Row, whole: Reply) => { delete (whole as Row).result; },
    ]) expect(() => parseShouwu(changed(change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [null, [], 'reply', {}]) expect(() => parseShouwu(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the newest hundred scans of a long history and says it cut the rest', () => {
    const result = parseShouwu(changed((traces) => {
      traces.splice(0, traces.length, ...Array.from({ length: 120 }, (_, index) => trace(1775000000 + index * 60, 'Arrived at Sorting Facility')));
    }), DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update_local: '2026-04-01T09:32:20' });
  });

  it('keeps an unknown number, a failed lookup, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(JSON.stringify({ result: { code: 500 } }))).rejects.toMatchObject({ kind: 'indeterminate' });
    // The lookup answers every number with HTTP 200: a 404, as for a renamed route, or a redirect is a moved route.
    await expect(lookup(JSON.stringify({ status: 404, error: 'Not Found', path: '/order/PubOrder/getOrderTrace' }), { status: 404 }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://admin.shshouwu.com/login.html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Attention Required! | Cloudflare</title></head></html>')).rejects.toMatchObject({ kind: 'challenge' });
    // The tracking page, or an empty body, in place of the reply.
    await expect(lookup('<!DOCTYPE html><html lang=en><head><title>包裹追踪</title></head></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('refuses numbers Shouwu does not issue, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'SWECN99000000001YQ', 'SWECN9900000000011YQ', 'SWEUS990000000001YQ', 'SWECN990000000001', '990000000001', `SWECN${'0'.repeat(70)}YQ`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeShouwuNumber('swecn-990000-000001-yq')).toBe(DELIVERED);
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(256 * 1024 + 1)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('recognizes a number the tracker knows, and not one it does not know or Shouwu does not issue', async () => {
    const recognize = (body: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).recognize!(DELIVERED);
    await expect(recognize(text('delivered'))).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-17T01:39:12' });
    await expect(recognize(text('not-found'))).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('SWECN99000000001YQ')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(recognize(JSON.stringify({ result: { code: 500 } }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('answers a lookup for a Shouwu number from its own tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === SHOUWU_API
      ? reply(text('delivered')) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'shouwu', source: 'shouwu', result: { current_stage: 'delivered', destination_country: 'US' } });
    expect(answer.result.events[0]).toMatchObject({ local_time: '2026-04-17T01:39:12', description: 'Delivered, Front Door' });
    expect(fetcher.mock.calls.filter(([url]) => String(url) === SHOUWU_API)).toHaveLength(1);
  });

  it('dates each Beijing wall clock on its place’s zone, so a flight out of Shanghai lasts as long as it did', async () => {
    const flown = changed((traces, order) => {
      order.countryCodeTwo = 'DE';
      traces.splice(0, traces.length, trace(1775950200, 'Arrived at airport of Destination', 'Frankfurt'),
        trace(1775930400, 'Departed from export airport', 'Shanghai'), trace(1775900000, 'Package processing completed'));
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === SHOUWU_API
      ? reply(JSON.stringify(flown)) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'shouwu' }, { budgetMs: 3000 });
    expect(answer.result.events.map((event) => [event.local_time, event.time, event.time_zone, event.time_zone_basis])).toEqual([
      ['2026-04-12T07:30:00', '2026-04-12T07:30:00+02:00', 'Europe/Berlin', 'place'],
      ['2026-04-12T02:00:00', '2026-04-12T02:00:00+08:00', 'Asia/Shanghai', 'place'],
      // A scan without a place takes the clock of the nearest one that has one: in China, its instant is the epoch's.
      ['2026-04-11T17:33:20', '2026-04-11T17:33:20+08:00', 'Asia/Shanghai', 'neighbour'],
    ]);
  });

});

describe('Shouwu International stored scans', () => {
  it('lets a scan abroad, stored at the instant its wall clock reads in Beijing, take over its row by wording and place', () => {
    const policy = sameInstantIdentityPolicy('shouwu', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['shouwu'], requireProviderCode: false, matchEachScan: true,
      relabelledFrom: 'Asia/Shanghai', matchWallClock: true });
    const wall = (time: string, zone?: string) =>
      DateTime.fromISO(time, zone ? { zone } : { setZone: true }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
    expect(wall('2026-04-11T23:30:00Z', policy?.relabelledFrom)).toBe(wall('2026-04-12T07:30:00+02:00'));
    const scan = { stage: 'in_transit', description: 'Arrived at airport of Destination', location: 'Frankfurt', providerCode: '' };
    expect(policy?.matches?.(scan, { ...scan, description: ' arrived at  airport of destination ' })).toBe(true);
    for (const other of [{ ...scan, location: 'Shanghai' }, { ...scan, description: 'Departed from export airport' }]) {
      expect(policy?.matches?.(scan, other)).toBe(false);
    }
  });

  it('reads a place without the country\'s code it opens with, and lets the row stored with that code keep its identity', () => {
    const coded = changed((traces) => {
      traces.splice(0, traces.length, trace(1775900000, 'Package processing completed', 'CN,SWE Sample Sort Facility'));
    });
    expect(parseShouwu(coded, DELIVERED).events!.map((event) => event.location)).toEqual(['SWE Sample Sort Facility']);
    const policy = sameInstantIdentityPolicy('shouwu', { supportsScanMatching: true });
    const scan = { stage: 'accepted', description: 'Package processing completed', location: 'SWE Sample Sort Facility', providerCode: '' };
    expect(policy?.matches?.(scan, { ...scan, location: 'CN,SWE Sample Sort Facility' })).toBe(true);
    for (const other of [{ ...scan, location: 'CN,SWE Other Sort Facility' }, { ...scan, location: 'CN,SWE Sample Sort Facility', description: 'Arrival processing center' }]) {
      expect(policy?.matches?.(scan, other)).toBe(false);
    }
  });
});

describe('Shouwu International numbers', () => {
  it('names Shouwu for SWECN, twelve digits and YQ', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'shouwu', confidence: 'high' });
  });
});

describe('Shouwu International status vocabulary', () => {
  it('maps every status it recorded to the stage recorded for it, and keeps the page’s labels off scan wording', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      if (!entry.code) {
        // Scan wording recorded without a code.
        expect(shouwuStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
        expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null, description: entry.wording }), entry.wording)
          .toEqual({ kind: 'mapped', stage: entry.stage });
        continue;
      }
      expect(shouwuStatusStage(entry.code), entry.code).toBe(entry.stage);
      expect(shouwuStatusLabel(entry.code), entry.code).toBe(entry.wording);
      expect(statusMap.stage(entry.code, ''), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'shouwu', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null, description: 'Preparing' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'shouwu', providerCode: 'TRACE_STATUS_SAMPLE', description: 'Sample Status Note' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', 'Sample Status Note', 'Preparing']) expect(shouwuStage(wording), wording).toBeNull();
  });
});
