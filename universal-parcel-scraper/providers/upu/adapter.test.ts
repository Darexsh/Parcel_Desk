import { describe, expect, it, vi } from 'vitest';
import { adapter, parseUpuResponse } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { DEFAULT_USER_AGENT } from '../../core/transport/index.js';

const number = 'EB000000005CN';
const scan = (EventCd = 'EMA', EventNm = 'Posting/Collection', EventDT = '/Date(1789202880000+0200)/') =>
  ({ EventCd, EventNm, EventDT, EventLocation: 'Sorting office', Signature: 'PRIVATE PERSON' });
const payload = (Events = [scan()]) => [{ ID: number, Events, State: 3, DestinationCountryCd: 'IN' }];
const create = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null, env: {} });

describe('UPU postal tracking', () => {
  it('binds identity and preserves uncertain wall time without trusting numeric State or retaining signatures', () => {
    const value = parseUpuResponse(payload(), number);
    expect(value).toMatchObject({ tracking_provider: 'UPU', current_stage: 'accepted', status: 'in_transit', last_update: null,
      last_update_local: '2026-09-12T10:48:00', events: [{ local_time: '2026-09-12T10:48:00', stage: 'accepted', provider_code: 'EMA' }] });
    expect(value.events?.[0]).not.toHaveProperty('time');
    expect(value).not.toHaveProperty('discovered_carrier');
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
  });

  it('excludes predictions from history, status, estimates and freshness', () => {
    const value = parseUpuResponse(payload([scan(), scan('DLV', 'Estimated delivery', '2026-09-30T00:00:00Z')]), number);
    expect(value.events).toHaveLength(1);
    expect(value.current_stage).toBe('accepted');
    expect(value.expected_delivery).toBeNull();
    expect(value.last_update).toBeNull();
    expect(() => parseUpuResponse(payload([scan('DLV', 'Estimated delivery')]), number)).toThrow('no actual tracking scans');
  });

  it('maps actual delivery, customs and release; deduplicates and sorts within the feed', () => {
    const customs = scan('EXB', 'Item held by export Customs/Security', '2026-09-13T10:00:00Z');
    const delivered = scan('EMI', 'Final delivery', '2026-09-14T12:00:00+02:00');
    const value = parseUpuResponse(payload([scan(), customs, delivered, delivered]), number);
    expect(value.current_stage).toBe('delivered');
    expect(value.events?.map((event) => event.stage)).toEqual(['delivered', 'customs', 'accepted']);
    expect(value.events?.[0]!.description).toBe('Delivered');
    expect(parseUpuResponse(payload([scan('EDC', 'Item returned from Customs (import)')]), number).current_stage).toBe('in_transit');
  });

  it('keeps scans of one wall time in the feed’s order, reversed as it lists them oldest first', () => {
    const departed = '/Date(1789210080000+0200)/';
    const value = parseUpuResponse(payload([scan(), scan('EMB', 'Arrival at outward office of exchange', departed),
      scan('EMC', 'Departure from outward office of exchange', departed)]), number);
    expect(value.events?.map((event) => event.provider_code)).toEqual(['EMC', 'EMB', 'EMA']);
  });

  it('distinguishes known postal codes from wording and unresolved codes', () => {
    const value = parseUpuResponse(payload([
      scan('EDC', 'Item held by Customs', '2026-01-01T10:00:00'),
      scan('ZZ1', 'Sorted in regional hub', '2026-01-01T11:00:00'),
      scan('ZZ2', 'Unrecognized carrier message', '2026-01-01T12:00:00'),
    ]), number);
    expect(value.events?.map((event) => [event.stage, event.stage_source])).toEqual([
      ['pending', 'none'], ['in_transit', 'wording:language'], ['in_transit', 'carrier_map'],
    ]);
    expect(value.current_stage_source).toBe('wording:language');
  });

  it('merges the records an item was reported under for each origin and destination pair', () => {
    const exported = { ID: number, Events: [scan('EXA', 'Item presented to export Customs/Security', '/Date(1789206480000+0200)/'), scan()],
      State: 1, DestinationCountryCd: 'CN' };
    const value = parseUpuResponse([...payload([scan(), scan('EMB', 'Arrival at outward office of exchange', '/Date(1789210080000+0200)/')]), exported], number);
    expect(value.events?.map((event) => event.provider_code)).toEqual(['EMB', 'EXA', 'EMA']);
    expect(value.current_stage).toBe('in_transit');
    expect(() => parseUpuResponse([...payload(Array.from({ length: 600 }, () => scan())), { ...exported,
      Events: Array.from({ length: 401 }, () => scan()) }], number)).toThrow('no matching shipment history');
  });

  it('handles a negative WCF offset as wall time, not a verified instant', () => {
    expect(parseUpuResponse(payload([scan('EMA', 'Posting/Collection', '/Date(1789202880000-0300)/')]), number).events?.[0])
      .toMatchObject({ local_time: '2026-09-12T05:48:00' });
  });

  it('dates a scan at an office of a country on the route that keeps one clock, and keeps every wall clock', () => {
    const at = (EventLocation: string, EventDT: string, EventCd = 'EMC') => ({ ...scan(EventCd, 'Departure from outward office of exchange', EventDT), EventLocation });
    const route = (Events: unknown[]) => [{ ID: number, Events, State: 3, OriginCountryCd: 'GB', DestinationCountryCd: 'HR' }];
    const summer = parseUpuResponse(route([scan(), at('GBLALA', '2026-10-17T03:36:00')]), number);
    expect(summer.events?.[0]).toMatchObject({ time: '2026-10-17T03:36:00+01:00', local_time: '2026-10-17T03:36:00', location: 'GBLALA' });
    expect(summer).toMatchObject({ last_update: '2026-10-17T03:36:00+01:00', last_update_local: '2026-10-17T03:36:00' });
    expect(summer.events?.[1]).not.toHaveProperty('time');
    expect(parseUpuResponse(route([at('GBLALA', '2026-01-08T06:22:00')]), number).events?.[0]?.time).toBe('2026-01-08T06:22:00+00:00');
    expect(parseUpuResponse(route([at('HRZAGA', '2026-10-18T09:00:00', 'EMD')]), number).events?.[0]?.time).toBe('2026-10-18T09:00:00+02:00');
    // An office in a country with several clocks, off the route, a name and a wall clock the zone skips keep only the wall clock.
    for (const [location, wall] of [['AUSYDB', '2026-10-08T05:46:00'], ['DEFRAA', '2026-10-17T03:36:00'], ['SYDNEY', '2026-10-17T03:36:00'],
      ['GBLALA', '2026-03-29T01:30:00']]) {
      const value = parseUpuResponse(route([at(location!, wall!)]), number);
      expect(value.events?.[0], location).toMatchObject({ local_time: wall });
      expect(value.events?.[0], location).not.toHaveProperty('time');
      expect(value.last_update, location).toBeNull();
    }
    expect(parseUpuResponse(payload([at('GBLALA', '2026-10-17T03:36:00')]), number).events?.[0]).not.toHaveProperty('time');
  });

  it('keeps separate locations and codes when labels and wall times coincide', () => {
    const value = parseUpuResponse(payload([scan(), { ...scan(), EventLocation: 'Other office' },
      { ...scan(), EventCd: 'EMB' }, scan()]), number);
    expect(value.events).toHaveLength(3);
  });

  it.each([
    null, {}, [{ ID: 'EB000000014CN', Events: [scan()] }], [...payload(), { ID: 'EB000000014CN', Events: [scan()] }],
    [...payload(), { ID: number }], Array.from({ length: 11 }, () => payload()[0]),
    payload([scan('EMA', 'Posting/Collection', '/Date(1789202880000+2500)/')]),
    payload([scan('EMA', 'Posting/Collection', '2026-02-31T10:00:00Z')]),
    payload(Array.from({ length: 1001 }, () => scan())),
    [{ ID: number, Events: [null] }],
  ])('rejects invalid identity, dates or schema: %j', (value) => {
    expect(() => parseUpuResponse(value, number)).toThrow();
  });

  it('uses one bounded anonymous GET with no browser, cookie or postcode', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload()));
    const tracker = create(fetcher);
    await expect(tracker.track({ number: 'eb 000000005 cn', postcode: 'PRIVATE' }, { budgetMs: 1000 }))
      .resolves.toMatchObject({ tracking_provider: 'UPU' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe(`https://globaltracktrace.ptc.post/gtt.api/service.svc/rest/ItemTTWithTrans/${number}/EN`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal) });
    expect(fetcher.mock.calls[0]![1]?.headers).toEqual({ 'User-Agent': DEFAULT_USER_AGENT });
    expect(fetcher.mock.calls[0]![1]?.body).toBeUndefined();
  });

  it.each(['', '[]'])('classifies an empty lookup as parcel-specific, not a provider outage', async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(create(fetcher).track({ number })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('preserves HTTP rate limits without a retry or CAPTCHA fallback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(create(fetcher).track({ number })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120000 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects ineligible numbers, oversized responses and HTML', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const value of ['1234567890', 'EB000000006CN', 'https://private.invalid']) {
      await expect(create(fetcher).track({ number: value })).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response('oversize', { headers: { 'Content-Length': '2000001' } }))
      .mockResolvedValueOnce(new Response('<html>Maintenance</html>'));
    await expect(create(fetcher).track({ number })).rejects.toThrow('large response');
    await expect(create(fetcher).track({ number })).rejects.toThrow('invalid tracking response');
  });

  it('propagates cancellation and the whole-request deadline to the network', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = create(fetcher).track({ number }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'transport' });
    await expect(create(fetcher).track({ number }, { budgetMs: 20 })).rejects.toMatchObject({ kind: 'transport' });
  });
});
