import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NORTHLINE_API, NorthlineTracker, northlineLookupUrl } from './adapter.js';
import { normalizeNorthlineNumber, parseNorthline } from './parser.js';
import { northlineMappedStage, northlineStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1ABC00000000';
const IN_TRANSIT = '1ABC123456789';
const UNKNOWN = '1ABC0000000';

type Row = Record<string, unknown>;
type Consignment = Row & { milestoneHistory: Row[] };
type Reply = Row & { data: Consignment };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Consignment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Northline HTTP adapter', () => {
  it('asks the tracker’s lookup for the whole number once, with the device id the page sends', async () => {
    const fetcher = replying(() => reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new NorthlineTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', deviceId: '00000000-0000-4000-8000-000000000000' });
    await expect(tracker.fetch(' 1abc 123-456-789 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${NORTHLINE_API}?referenceNo=${IN_TRANSIT}`);
    expect(url).toBe(northlineLookupUrl(IN_TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0', 'x-device-id': '00000000-0000-4000-8000-000000000000' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'northline', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps one random device id per adapter, as a browser keeps its own', async () => {
    const fetcher = replying(() => reply(fixture('not-found')));
    const first = carrier(fetcher);
    await expect(first.track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(first.track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const ids = fetcher.mock.calls.map(([, init]) => (init!.headers as Record<string, string>)['x-device-id']);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('dates each milestone with the offset of the zone its branch names, across zones', () => {
    const result = parseNorthline(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2025-12-02T10:50:48+11:00', delivered_at: '2025-12-02T10:50:48+11:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.stage])).toEqual([
      ['2025-12-02T10:50:48+11:00', '851', 'Delivered', 'delivered'],
      ['2025-12-02T06:32:03+11:00', '701', 'Out For Delivery', 'out_for_delivery'],
      // The depot scan listed twice is kept once.
      ['2025-12-01T14:27:20+11:00', '601', 'Depot Arrival', 'in_transit'],
      ['2025-12-01T08:47:11+11:00', '701', 'Out For Delivery', 'out_for_delivery'],
      ['2025-11-27T10:01:00+11:00', '601', 'Depot Arrival', 'in_transit'],
      ['2025-11-27T00:19:35+10:00', '501', 'In Transit', 'in_transit'],
      ['2025-11-26T18:49:34+10:00', '401', 'In Transit', 'in_transit'],
      ['2025-11-26T16:09:50+10:00', '201', 'Picked Up', 'accepted'],
      ['2025-11-20T10:55:59+10:00', '101', 'Not Available', 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map' && !event.location)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|0000"|QLD|NSW|1ABC00"|10000001|2000000/);
  });

  it('orders a history by instant where wall clocks of two zones disagree, and keeps the estimate until delivery', () => {
    const result = parseNorthline(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Depot Arrival',
      last_update: '2026-04-01T10:48:34+08:00', delivered_at: null, expected_delivery: '2026-04-03' });
    // The origin update's wall clock is later, its instant earlier.
    expect(result.events!.map((event) => [event.time, event.provider_code])).toEqual([
      ['2026-04-01T10:48:34+08:00', '601'],
      ['2026-04-01T12:30:00+10:00', '501'],
      ['2026-03-30T00:05:45+10:00', '501'],
      ['2026-03-29T17:56:15+10:00', '401'],
      ['2026-03-28T17:36:55+10:00', '201'],
    ]);
  });

  it('keeps a milestone without a known zone as a wall clock, in the order the reply gives', () => {
    const result = parseNorthline(changed('in-transit', (data) => { data.milestoneHistory[1]!.branch = null; }), IN_TRANSIT);
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code])).toEqual([
      ['2026-04-01T12:30:00+10:00', '501'],
      ['2026-04-01T10:48:34', '601'],
      ['2026-03-30T00:05:45+10:00', '501'],
      ['2026-03-29T17:56:15+10:00', '401'],
      ['2026-03-28T17:36:55+10:00', '201'],
    ]);
    const local = parseNorthline(changed('delivered', (data) => { data.milestoneHistory[0]!.branch = 'NZST'; }), DELIVERED);
    expect(local.events![0]).toEqual({ local_time: '2025-12-02T10:50:48', description: 'Delivered', provider_code: '851',
      stage: 'delivered', stage_source: 'carrier_map' });
    // A delivery without an instant has no delivery instant.
    expect(local).toMatchObject({ delivered_at: null, last_update: null, last_update_local: '2025-12-02T10:50:48' });
  });

  it('reads a booked consignment without milestones as its status alone', () => {
    const booked = changed('in-transit', (data) => {
      Object.assign(data, { statusValue: 200, statusName: 'Not Available', completedStatus: null, milestoneHistory: [] });
    });
    expect(parseNorthline(booked, IN_TRANSIT)).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Not Available', provider_code: '200', last_update: null, expected_delivery: '2026-04-03', summary_only: true, events: [] });
    const unknown = changed('in-transit', (data) => { Object.assign(data, { statusValue: null, statusName: null, milestoneHistory: null }); });
    expect(() => parseNorthline(unknown, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('takes the consignment’s own word for a delivery its milestones do not reach yet', () => {
    const result = parseNorthline(changed('delivered', (data) => { data.milestoneHistory.shift(); }), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2025-12-02T06:32:03+11:00', delivered_at: null, expected_delivery: null });
    expect(result.events![0]).toMatchObject({ provider_code: '701' });
  });

  it('reads an unknown number as not found and the service’s own refusal as inconclusive', async () => {
    expect(() => parseNorthline(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A request without a device id, or with one the service does not take.
    const refused = { data: null, message: 'DEVICE_ID_NOT_FOUND', status: 'error', validationResult: null };
    expect(() => parseNorthline(refused, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseNorthline({ data: null, message: 'Sample', status: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(replying(() => reply(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(replying(() => reply(refused))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps only a consignment, and milestones, that name the whole number asked', () => {
    expect(() => parseNorthline(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Northline answered for another consignment' }));
    expect(() => parseNorthline(changed('delivered', (data) => { data.connoteNo = `${DELIVERED}0`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Northline answered for another consignment' }));
    expect(() => parseNorthline(changed('delivered', (data) => { data.milestoneHistory[3]!.connoteNo = '1ABC000000000'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseNorthline(changed('delivered', (data) => { data.connoteNo = DELIVERED.toLowerCase(); }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed reply', () => {
    for (const [index, change] of [
      (_data: Consignment, body: Reply) => { delete (body as Row).data; },
      (_data: Consignment, body: Reply) => { body.data = 'consignment' as never; },
      (data: Consignment) => { delete data.connoteNo; },
      (data: Consignment) => { data.milestoneHistory = 'milestones' as never; },
      (data: Consignment) => { data.milestoneHistory = Array.from({ length: 501 }, () => data.milestoneHistory[0]!); },
      (data: Consignment) => { data.milestoneHistory[0] = 'milestone' as never; },
      (data: Consignment) => { data.milestoneHistory[0]!.updatedOn = '2025-12-02T10:50:48+11:00'; },
      (data: Consignment) => { data.milestoneHistory[0]!.updatedOn = '2025-12-02 10:50:48'; },
      (data: Consignment) => { data.milestoneHistory[0]!.updatedOn = '2025-02-30T10:50:48Z'; },
      (data: Consignment) => { data.milestoneHistory[0]!.updatedOn = '2025-12-02T24:00:00Z'; },
      (data: Consignment) => { delete data.milestoneHistory[0]!.updatedOn; },
      (data: Consignment) => { data.milestoneHistory[0]!.newStatusValue = null; },
      (data: Consignment) => { data.milestoneHistory[0]!.newStatusValue = 'Delivered'; },
      (data: Consignment) => { data.milestoneHistory[0]!.newStatusText = ' '; },
      (data: Consignment) => { data.milestoneHistory[0]!.newStatusText = ['Delivered']; },
      (data: Consignment) => { data.milestoneHistory[0]!.branch = 11; },
      (data: Consignment) => { data.statusName = 851; },
    ].entries()) {
      expect(() => parseNorthline(changed('delivered', change), DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseNorthline('Sample', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads no estimate it cannot parse', () => {
    for (const value of [null, '2026-04-31T00:00:00Z', '03/04/2026', 7]) {
      const body = changed('in-transit', (data) => { data.expectedDeliveryDate = value; });
      if (typeof value === 'number') expect(() => parseNorthline(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
      else expect(parseNorthline(body, IN_TRANSIT), String(value)).toMatchObject({ expected_delivery: null });
    }
  });

  it('keeps a browser check, a refusal, a moved route and a broken reply apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: DELIVERED });
    await expect(lookup(() => reply(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => reply('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://track.northline.com.au/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    // The page itself, in place of the lookup's reply.
    await expect(lookup(() => reply('<!doctype html><html><title>Northline - TRACK</title><app-root></app-root></html>')))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      await expect(carrier(replying(() => new Response('', { status }))).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    });

  it('refuses what Northline does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1ABC0000', 'ABC00000000', '1AB000000000', '11ABC0000000', `1ABC${'0'.repeat(12)}`, '1ABC00000000?',
      '1ABC00000/00', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeNorthlineNumber(' 1abc-0000 0000 ')).toBe(DELIVERED);
    expect(normalizeNorthlineNumber('1ABC00000')).toBe('1ABC00000');
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

  it('routes a number filed under Northline to the adapter', async () => {
    const fetcher = replying(() => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'northline' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'northline', source: 'northline', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === northlineLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Northline status vocabulary', () => {
  it('records every status value the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      if (!entry.code) continue;
      expect(statusMapAnswer({ carrier: 'northline', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(northlineStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves another value to the shared rules', () => {
    expect(northlineMappedStage('999')).toBeUndefined();
    expect(northlineStage('999', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(northlineStage('999', 'Sample Wording')).toBeNull();
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'northline', providerCode: '999', description: 'Sample Wording' })).toEqual({ kind: 'unknown' });
  });
});
