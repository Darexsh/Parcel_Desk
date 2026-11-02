import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GIG_LOGISTICS_API, GIG_LOGISTICS_PAGE, GigLogisticsTracker } from './adapter.js';
import { normalizeGigLogisticsNumber, parseGigLogistics } from './parser.js';
import { gigLogisticsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1000000001';
const UNKNOWN = '1000000003';

type Row = Record<string, unknown>;
type Scan = Row & { ScanStatus: Row };
type Reply = Row & { Object: Row & { MobileShipmentTrackings: Scan[] } };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
const changed = (change: (scans: Scan[], reply: Reply) => void) => {
  const reply = fixture('delivered');
  change(reply.Object.MobileShipmentTrackings, reply);
  return reply;
};
const scan = (code: string, at: string, reason: string | null, location: string | null = null): Scan => ({
  Waybill: DELIVERED, Location: location, Status: code, DateTime: at, TrackingType: 'NotSpecified',
  ScanStatus: { Code: code, Incident: 'SAMPLE INCIDENT', Reason: reason, Comment: '' }, User: 'Sample Staff',
});
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GIG Logistics HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GigLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 000 001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(`${GIG_LOGISTICS_API}${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', Referer: GIG_LOGISTICS_PAGE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gig-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered shipment’s scans on their wall clocks, with their codes and service centres, and none of the addresses or names', () => {
    const result = parseGigLogistics(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'SHIPMENT COLLECTED BY CUSTOMER', last_update: null, last_update_local: '2026-04-16T09:39:12', expected_delivery: null });
    // No instant to give it.
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-04-16T09:39:12', 'SAMPLE HUB', 'SHIPMENT COLLECTED BY CUSTOMER', 'OKT', 'delivered'],
      ['2026-04-16T09:15:14', 'SAMPLE HUB', 'SHIPMENT WITH DELIVERY COURIER FOR DELIVERY', 'WC', 'out_for_delivery'],
      ['2026-04-16T08:11:26', 'SAMPLE HUB', 'SHIPMENT ARRIVED FINAL DESTINATION', 'ARF', 'in_transit'],
      ['2026-04-15T02:00:12', 'EXAMPLE GATEWAY', 'SHIPMENT DEPART SERVICE CENTER', 'DSC', 'in_transit'],
      // The scan listed twice counts once.
      ['2026-04-14T22:05:28', 'EXAMPLE GATEWAY', 'Shipment Arrives Collation Center', 'ACC', 'in_transit'],
      ['2026-04-14T18:16:06', 'SAMPLE DEPOT', 'SHIPMENT DEPART SERVICE CENTER', 'DSC', 'in_transit'],
      ['2026-04-14T13:05:19', 'SAMPLE DEPOT', 'SHIPMENT ARRIVED OPERATIONS', 'ARO', 'in_transit'],
      ['2026-04-14T13:05:15', undefined, 'SHIPMENT ARRIVED SERVICE CENTRE FOR ONWARD PROCESSING', 'MSVC', 'in_transit'],
      // A place with digits or commas could be an address, and is not read.
      ['2026-04-14T13:04:30', undefined, 'SHIPMENT ENROUTE DELIVERY', 'MSHC', 'in_transit'],
      ['2026-04-14T11:03:57', undefined, 'SHIPMENT ASSIGNED FOR PICKUP', 'MAPT', 'registered'],
      ['2026-04-14T11:01:36', undefined, 'SHIPMENT CREATED BY CUSTOMER', 'MCRT', 'registered'],
    ]);
    expect(result.events!.every((event) => !('time' in event) && event.stage_source === 'carrier_map')).toBe(true);
    const json = JSON.stringify(result);
    for (const excluded of ['Sample Staff', 'SAMPLE RECEIVER', 'Sample Street', 'Example Road', '100001', 'Sample Close', 'Example Town', 'NotSpecified', 'WHEN SHIPMENT']) {
      expect(json).not.toContain(excluded);
    }
  });

  it('orders scans by their clocks to the decimal, keeps an offset the reply states, and checks every clock', () => {
    const ordered = parseGigLogistics(changed((scans) => {
      scans.splice(0, scans.length, scan('MAPT', '2026-04-14T11:03:57.47', 'SHIPMENT ASSIGNED FOR PICKUP'),
        scan('WC', '2026-04-14T11:03:57.5', 'SHIPMENT WITH DELIVERY COURIER FOR DELIVERY'), scan('MCRT', '2026-04-14T11:03:57', 'SHIPMENT CREATED BY CUSTOMER'));
    }), DELIVERED);
    expect(ordered.events!.map((event) => event.provider_code)).toEqual(['WC', 'MAPT', 'MCRT']);
    expect(ordered).toMatchObject({ current_stage: 'out_for_delivery', last_update_local: '2026-04-14T11:03:57' });

    const stated = parseGigLogistics(changed((scans) => {
      scans.splice(0, scans.length, scan('OKT', '2026-04-16T09:39:12.007+01:00', 'SHIPMENT COLLECTED BY CUSTOMER'),
        scan('ARF', '2026-04-16T08:11:26Z', 'SHIPMENT ARRIVED FINAL DESTINATION'));
    }), DELIVERED);
    expect(stated.events!.map((event) => [event.time, event.local_time])).toEqual([
      ['2026-04-16T09:39:12+01:00', undefined], ['2026-04-16T08:11:26Z', undefined]]);
    expect(stated).toMatchObject({ last_update: '2026-04-16T09:39:12+01:00', delivered_at: '2026-04-16T09:39:12+01:00' });
    expect(stated).not.toHaveProperty('last_update_local');

    for (const date of ['2026-04-10T24:00:00', '2026-02-30T08:00:00', '0001-01-01T00:00:00', '2026-04-10 08:00:00', '2026-04-10T08:00', '2026-04-10T08:00:00.12345678', '', null, 7]) {
      expect(() => parseGigLogistics(changed((scans) => { scans[0]!.DateTime = date; }), DELIVERED), String(date))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('stages a new code by its wording, falls back to the recorded wording, and leaves a scan without either out', () => {
    const result = parseGigLogistics(changed((scans) => {
      scans.splice(0, scans.length, scan('XDL', '2026-04-16T10:00:00', 'SHIPMENT DELIVERED'), scan('ZZZ', '2026-04-16T09:50:00', 'Sample Status Note'),
        scan('WC', '2026-04-16T09:15:14', null, 'SAMPLE_HUB'), scan('QQQ', '2026-04-16T09:00:00', ''));
      scans[2]!.ScanStatus = null as unknown as Row;
    }), DELIVERED);
    expect(result.events!.map((event) => [event.provider_code, event.description, event.stage, event.stage_source])).toEqual([
      ['XDL', 'SHIPMENT DELIVERED', 'delivered', 'wording:language'],
      ['ZZZ', 'Sample Status Note', undefined, undefined],
      ['WC', 'SHIPMENT WITH DELIVERY COURIER FOR DELIVERY', 'out_for_delivery', 'carrier_map'],
    ]);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language' });
    const unstaged = parseGigLogistics(changed((scans) => { scans.splice(0, scans.length, scan('ZZZ', '2026-04-16T09:50:00', 'Sample Status Note')); }), DELIVERED);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'Sample Status Note' });
    expect(unstaged).not.toHaveProperty('current_stage');
    // A late record of the booking is no step back.
    const late = parseGigLogistics(changed((scans) => {
      scans.splice(0, scans.length, scan('MCRT', '2026-04-15T10:00:00', 'SHIPMENT CREATED BY CUSTOMER'), scan('ARO', '2026-04-15T09:00:00', 'SHIPMENT ARRIVED OPERATIONS'));
    }), DELIVERED);
    expect(late).toMatchObject({ current_stage: 'in_transit', last_status_text: 'SHIPMENT CREATED BY CUSTOMER' });
  });

  it('reads only the tracker’s unknown-waybill answer as not found, and a shipment without scans as no history', () => {
    expect(() => parseGigLogistics(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [{ Code: '400', ShortDescription: 'Sample failure' }, { Code: '500', ShortDescription: 'Invalid waybill number!!' },
      { Code: '401', ShortDescription: 'Authorization has been denied' }]) {
      expect(() => parseGigLogistics(payload, UNKNOWN), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseGigLogistics(changed((scans) => { scans.splice(0); }), DELIVERED)).toThrow(NoHistoryError);
    expect(() => parseGigLogistics(changed((_scans, whole) => { whole.Object.MobileShipmentTrackings = null as unknown as Scan[]; }), DELIVERED))
      .toThrow(NoHistoryError);
    expect(() => parseGigLogistics(changed((scans) => { scans.splice(0, scans.length, scan('QQQ', '2026-04-16T09:00:00', null)); }), DELIVERED))
      .toThrow(NoHistoryError);
  });

  it('reads only the scans that name the whole waybill asked, and rejects a changed reply', () => {
    const mixed = parseGigLogistics(changed((scans) => { scans[0]!.Waybill = '1000000002'; }), DELIVERED);
    expect(mixed.events).toHaveLength(10);
    expect(mixed).toMatchObject({ current_stage: 'out_for_delivery' });
    for (const waybill of ['1000000002', `${DELIVERED}1`, DELIVERED.slice(1)]) {
      expect(() => parseGigLogistics(changed((scans) => { for (const row of scans) row.Waybill = waybill; }), DELIVERED), waybill)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const change of [
      (scans: Scan[]) => { delete scans[0]!.Waybill; },
      (scans: Scan[]) => { scans[0]!.Waybill = 1000000001; },
      (scans: Scan[]) => { scans[0]!.Status = 'O K T'; scans[0]!.ScanStatus.Code = null; },
      (scans: Scan[]) => { scans[0]!.Status = null; scans[0]!.ScanStatus.Code = null; },
      (scans: Scan[]) => { scans[0]!.ScanStatus.Reason = 7; },
      (scans: Scan[]) => { scans[0]!.Location = ['SAMPLE HUB']; },
      (scans: Scan[]) => { scans.push('scan' as unknown as Scan); },
      (scans: Scan[]) => { scans.push(...Array.from({ length: 500 }, () => scan('ARO', '2026-04-15T09:00:00', 'SHIPMENT ARRIVED OPERATIONS'))); },
      (_scans: Scan[], whole: Reply) => { whole.Object.MobileShipmentTrackings = {} as unknown as Scan[]; },
      (_scans: Scan[], whole: Reply) => { whole.Object = null as unknown as Reply['Object']; },
      (_scans: Scan[], whole: Reply) => { delete (whole as Row).Code; },
      (_scans: Scan[], whole: Reply) => { whole.Code = { value: '200' }; },
    ]) expect(() => parseGigLogistics(changed(change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [null, [], 'reply']) expect(() => parseGigLogistics(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A numeric code reads as its digits.
    expect(parseGigLogistics(changed((_scans, whole) => { whole.Code = 200; }), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('keeps the newest hundred scans of a long history and says it cut the rest', () => {
    const result = parseGigLogistics(changed((scans) => {
      scans.splice(0, scans.length, ...Array.from({ length: 120 }, (_, index) => scan('ARO',
        `2026-04-10T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00`, 'SHIPMENT ARRIVED OPERATIONS')));
    }), DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update_local: '2026-04-10T01:59:00' });
  });

  it('keeps an unknown waybill, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup answers every waybill with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://giglogistics.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Attention Required! | Cloudflare</title></head></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!doctype html><html><head><title>GIG Logistics</title></head></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(JSON.stringify({ Code: '500', ShortDescription: 'Sample failure' }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('leaves references other than a waybill to providers, refuses what no tracker takes, and refuses pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['100000001', '10000000011', 'GIG0000001', 'SAMPLECODE']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    for (const number of ['', '1000000001/1', 'SAMPLE#CODE', `1${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGigLogisticsNumber('1000-000 001')).toBe(DELIVERED);
    // No rule names GIG Logistics, and the adapter declares no recognition.
    expect(carrier(fetcher).recognize).toBeUndefined();
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
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(512 * 1024 + 1)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('answers a lookup that names GIG Logistics and dates its wall clocks on Nigeria’s clock', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(GIG_LOGISTICS_API)
      ? reply(text('delivered')) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'gig-logistics' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'gig-logistics', source: 'gig-logistics', result: { current_stage: 'delivered' } });
    expect(answer.result.events[0]).toMatchObject({ local_time: '2026-04-16T09:39:12', time: '2026-04-16T09:39:12+01:00', time_zone: 'Africa/Lagos' });
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith(GIG_LOGISTICS_API)).map(([url]) => String(url)))
      .toEqual([`${GIG_LOGISTICS_API}${DELIVERED}`]);
  });
});

describe('GIG Logistics numbers', () => {
  it('leaves ten digits unclaimed', () => {
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('gig-logistics');
  });
});

describe('GIG Logistics status vocabulary', () => {
  it('maps every code and wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, 'sample status note'), entry.code).toBe(entry.stage);
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(gigLogisticsStage(entry.code, 'Sample Status Note'), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(gigLogisticsStage('ZZZ', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'gig-logistics', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'gig-logistics', providerCode: 'ZZZ', description: 'Sample Status Note' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', 'Sample Status Note']) expect(gigLogisticsStage('', wording), wording).toBeNull();
  });
});
