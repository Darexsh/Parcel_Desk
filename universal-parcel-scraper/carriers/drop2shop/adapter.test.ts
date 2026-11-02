import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DROP2SHOP_API, Drop2ShopTracker } from './adapter.js';
import { normalizeDrop2ShopNumber, parseDrop2Shop } from './parser.js';
import { drop2shopStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'GLB9000000000001';
const IN_TRANSIT = 'GLB9000000000002';
const UNKNOWN = 'GLB9000000000003';

type Row = Record<string, unknown>;
type Reply = { data: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (rows: Row[], reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const urlOf = (number: string) => DROP2SHOP_API.replace('{number}', number);

describe('Drop2Shop HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new Drop2ShopTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' glb 9000-0000-00002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.drop2shop.ie/api-ship/tracking/${IN_TRANSIT}/scan`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'drop2shop', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates COLL-8’s records in UTC and the partner’s scans on Irish time, newest first', () => {
    const result = parseDrop2Shop(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your parcel has been delivered', last_update: '2026-07-14T13:42:00+01:00',
      delivered_at: '2026-07-14T13:42:00+01:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-07-14T13:42:00+01:00', 'D2MD001', 'delivered'],
      ['2026-07-14T09:01:17+01:00', 'D2MS004', 'out_for_delivery'],
      ['2026-07-13T21:10:02+01:00', 'D2MS002', 'in_transit'],
      ['2026-07-13T12:05:44Z', 'CUSM015', 'customs'],
      // The sender's data and the parcel's creation are one moment on two clocks.
      ['2026-07-06T11:20:35+01:00', 'D2MS001', 'registered'],
      ['2026-07-06T10:20:31Z', 'DAT', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.local_time && !event.location)).toBe(true);
  });

  it('names DPD Ireland and its consignment number as the delivery partner, and proposes the hand-off', () => {
    const result = parseDrop2Shop(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ delivery_carrier: 'dpd-ie', delivery_tracking_number: '800000001' });
    expect(deliveryHandoff('drop2shop', DELIVERED, result)).toEqual({ carrier: 'dpd-ie', number: '800000001', basis: 'partner' });
    // The newest scan's partner decides, as on the page; only a whole number DPD Ireland's rule takes is kept.
    for (const [partner, reference] of [['Coll-8', '800000001'], ['AnPost', '800000001'], ['DPD', '80000000'], ['DPD', '80000000A'],
      ['DPD', ''], ['DPD', null]] as const) {
      const other = parseDrop2Shop(changed('delivered', (rows) => {
        rows[5]!.odaCarrier = partner;
        rows[5]!.odaTrackingNumber = reference;
      }), DELIVERED);
      expect(other, `${partner} ${reference}`).not.toHaveProperty('delivery_carrier');
      expect(other).not.toHaveProperty('delivery_tracking_number');
    }
    expect(parseDrop2Shop(changed('delivered', (rows) => { rows[5]!.odaCarrier = 'dpd'; rows[5]!.odaTrackingNumber = '8000000010'; }), DELIVERED))
      .toMatchObject({ delivery_carrier: 'dpd-ie', delivery_tracking_number: '8000000010' });
  });

  it('keeps a scan repeated by each package of a shipment once', () => {
    const result = parseDrop2Shop(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'C8 Customs - Inbound Package',
      last_update: '2026-11-09T11:54:14Z', delivery_carrier: 'dpd-ie', delivery_tracking_number: '800000002' });
    expect(result).not.toHaveProperty('delivered_at');
    // In winter Irish time is UTC, and the two clocks agree.
    expect(result.events!.map((event) => [event.time, event.provider_code])).toEqual([
      ['2026-11-09T11:54:14Z', 'CUSM015'],
      ['2026-11-09T11:54:12Z', 'CUSM015'],
      ['2026-11-02T15:42:25+00:00', 'D2MS001'],
      ['2026-11-02T15:42:22Z', 'DAT'],
    ]);
  });

  it('keeps scans of one instant in the carrier\'s order', () => {
    const result = parseDrop2Shop(changed('delivered', (rows) => {
      rows.splice(5, 0, { ...rows[4]!, eventCode: 'D2MS005', description: 'Your parcel is with the driver' });
    }), DELIVERED);
    expect(result.events!.slice(0, 3).map((event) => event.provider_code)).toEqual(['D2MD001', 'D2MS005', 'D2MS004']);
  });

  it('reads an archived clock’s fraction of a second, a stated offset, and the repeated hour as its first occurrence', () => {
    const result = parseDrop2Shop(changed('delivered', (rows) => {
      rows[0]!.eventDateTime = '2026-07-06T10:20:31.52';
      rows[3]!.eventDateTime = '2026-07-13T21:10:02.007';
      rows[2]!.eventDateTime = '2026-07-06T10:20:35Z';
      rows[5]!.eventDateTime = '2026-10-25T01:30:00';
    }), DELIVERED);
    expect(result.events!.find((event) => event.provider_code === 'DAT')!.time).toBe('2026-07-06T10:20:31Z');
    expect(result.events!.find((event) => event.provider_code === 'D2MS002')!.time).toBe('2026-07-13T21:10:02+01:00');
    expect(result.events!.find((event) => event.provider_code === 'D2MS001')!.time).toBe('2026-07-06T10:20:35Z');
    expect(result.delivered_at).toBe('2026-10-25T01:30:00+01:00');
  });

  it('stages a code it does not know by its wording, or not at all', () => {
    const result = parseDrop2Shop(changed('in-transit', (rows) => {
      rows.push({ ...rows[4]!, eventCode: 'D2MX009', eventDateTime: '2026-11-10T09:00:00', description: 'Synthetic note' });
      rows.push({ ...rows[4]!, eventCode: 'D2MS005', eventDateTime: '2026-11-10T08:00:00', description: 'Out for delivery' });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'wording:language',
      last_status_text: 'Synthetic note' });
    expect(result.events![0]).not.toHaveProperty('stage');
  });

  it('reads the empty answer as not found', () => {
    expect(() => parseDrop2Shop(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('counts a scan only when it belongs to a package of the number asked', () => {
    expect(() => parseDrop2Shop(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Drop2Shop answered for another shipment' }));
    for (const parcel of [DELIVERED, `${DELIVERED}001`, `${IN_TRANSIT}0001`, `${IN_TRANSIT}00A`, `${IN_TRANSIT.slice(0, -1)}`]) {
      expect(() => parseDrop2Shop(changed('in-transit', (rows) => { rows[5]!.packageTrackingNumber = parcel; }), IN_TRANSIT), parcel)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseDrop2Shop(changed('in-transit', (rows) => {
      for (const row of rows) row.packageTrackingNumber = String(row.packageTrackingNumber).toLowerCase();
    }), IN_TRANSIT).events).toHaveLength(4);
    // A scan filed under the shipment's own number is the shipment's.
    expect(parseDrop2Shop(changed('in-transit', (rows) => { rows[5]!.packageTrackingNumber = IN_TRANSIT; }), IN_TRANSIT).events)
      .toHaveLength(4);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_rows: Row[], body: Reply) => { delete (body as Row).data; },
      (_rows: Row[], body: Reply) => { (body as Row).data = null; },
      (_rows: Row[], body: Reply) => { (body as Row).data = { events: [] }; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 500 }, () => rows[0]!)); },
      (rows: Row[]) => { rows[0] = 'scan' as never; },
      (rows: Row[]) => { delete rows[0]!.packageTrackingNumber; },
      (rows: Row[]) => { rows[0]!.packageTrackingNumber = { number: IN_TRANSIT }; },
      (rows: Row[]) => { rows[0]!.description = ''; },
      (rows: Row[]) => { rows[0]!.description = ['Package Created']; },
      (rows: Row[]) => { delete rows[0]!.eventDateTime; },
      (rows: Row[]) => { rows[0]!.eventDateTime = '02/11/2026 15:42'; },
      (rows: Row[]) => { rows[0]!.eventDateTime = '2026-11-02T24:00:00'; },
      (rows: Row[]) => { rows[0]!.eventDateTime = '2026-02-30T10:00:00'; },
      (rows: Row[]) => { rows[0]!.eventDateTime = '2026-11-02T15:42'; },
      (rows: Row[]) => { rows[0]!.eventCode = { code: 'DAT' }; },
    ]) {
      expect(() => parseDrop2Shop(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.drop2shop.ie/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt = {}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>The request is blocked.</body></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    // The page's own shell in place of the reply is no answer about the parcel.
    await expect(lookup('<!doctype html><html><head><title>Drop2Shop</title></head><body><app-root></app-root></body></html>'))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number COLL-8 does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-07-14T12:42:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('GLB900000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers COLL-8 does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['GLB900000000000', 'GLB90000000000011', `${DELIVERED}001`, 'GLX9000000000001', '9000000000001', `GLB${'0'.repeat(62)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDrop2ShopNumber('glb 9000.0000.00001')).toBe(DELIVERED);
  });

  it('sends a read that fails to reach the tracker once more, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url) === urlOf(DELIVERED))).toBe(true);
  });

  it('routes a number filed under Drop2Shop, or one its recognition knows, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === urlOf(DELIVERED)
      ? reply(fixture('delivered')) : new Response('', { status: 404 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'drop2shop' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'drop2shop', source: 'drop2shop', result: { current_stage: 'delivered' } });
    // Recognition counts a parcel with recent activity.
    vi.useFakeTimers({ now: new Date('2026-07-20T12:00:00Z'), toFake: ['Date'] });
    try {
      await expect(tracker.track({ number: DELIVERED.toLowerCase() }, { budgetMs: 3000 }))
        .resolves.toMatchObject({ carrier: 'drop2shop', source: 'drop2shop' });
    } finally {
      vi.useRealTimers();
    }
    expect(fetcher.mock.calls.some(([url]) => String(url) === urlOf(DELIVERED))).toBe(true);
  });
});

describe('Drop2Shop numbers', () => {
  it('suggests Drop2Shop for GLB and thirteen digits, in either case', () => {
    for (const number of [DELIVERED, IN_TRANSIT.toLowerCase()]) {
      expect(detectCarrierMatch(number).candidates, number).toContain('drop2shop');
    }
  });
});

describe('Drop2Shop status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(drop2shopStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'drop2shop', providerCode: 'D2MD001', description: 'Your parcel has been delivered' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'drop2shop', providerCode: 'ZZ9', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(drop2shopStage('d2ms004', 'Synthetic')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(drop2shopStage('ZZ9', 'Synthetic note')).toBeNull();
  });
});
