import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ANSERX_API, AnserxTracker } from './adapter.js';
import { normalizeAnserxNumber, parseAnserx } from './parser.js';
import { anserxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'BTYCN0000012345YQ';
const IN_TRANSIT = 'BTYCN0000067890YQ';
const UNKNOWN = 'BTYCN0000000000YQ';
const USPS = '9200190000000000001235';

type Row = Record<string, unknown>;
type Shipment = Row & { tksTrackingDetailDTOList: Row[] };
type Reply = { code: unknown; msg?: unknown; data: { normalCount: number; list: Shipment[]; abnormalCount: number } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data.list[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('AnserX HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AnserxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' btycn-0000-0678-90yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ANSERX_API}?nos=${IN_TRANSIT}&internalFlag=0`);
    expect(String(url)).toBe('https://oms.anserx.com/client/cs/anserxWebsite/tracking/getTrackInfo?nos=BTYCN0000067890YQ&internalFlag=0');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'anserx', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel as wall clocks, newest first, with towns but no postcodes or the customer’s references', () => {
    const result = normalizeCarrierResult(parseAnserx(fixture('delivered'), DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has been delivered', last_update: null, last_update_local: '2026-09-21T12:40:15',
      expected_delivery: null, destination_country: 'MX' });
    expect(result.events!.map((event) => [event.local_time, event.location, event.provider_code, event.stage])).toEqual([
      ['2026-09-21T12:40:15', 'Puebla', 'BTY_LASTMILE_DELIVERED', 'delivered'],
      ['2026-09-21T08:02:44', 'Puebla', 'BTY_LASTMILE_DELIVERING', 'out_for_delivery'],
      ['2026-09-18T15:20:01', 'MX', 'BTY_LASTMILE_TRANSIT', 'in_transit'],
      ['2026-09-16T11:11:11', 'MX', 'BTY_LASTMILE_TRANSIT', 'in_transit'],
      ['2026-09-14T09:45:30', 'MX', 'BTY_LASTMILE_TRANSIT', 'in_transit'],
      ['2026-09-12T13:05:00', 'MX', 'BTY_EXCC_COMPLETED', 'in_transit'],
      ['2026-09-10T06:30:00', 'MX', 'BTY_LINE_ARRIVED', 'in_transit'],
      ['2026-09-08T23:15:00', 'CN', 'BTY_LINE_HANDOVER', 'in_transit'],
      ['2026-09-07T10:20:00', 'CN', 'BTY_LINE_HANDOVER', 'in_transit'],
      ['2026-09-05T18:40:00', 'CN', 'BTY_WAREHOUSE_OUTBOUND', 'in_transit'],
      ['2026-09-04T11:00:00', 'CN', 'BTY_WAREHOUSE_INBOUND', 'accepted'],
      ['2026-09-03T20:10:05', 'CN', 'BTY_ORDER_CREATED', 'registered'],
    ]);
    expect(result.events![3]!.description).toBe('Leaving transportation partner facilities, waiting for items');
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(JSON.stringify(result)).not.toMatch(/72000|C000X000|SAMPLE-ORDER|1800000000000000001/);
  });

  it('reads a parcel with the delivery carrier and hands its delivery number on', () => {
    const result = parseAnserx(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-10-02T07:25:00',
      last_status_text: 'arrival at transportation partner facilities, waiting for items',
      delivery_tracking_number: USPS, destination_country: 'US' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events).toHaveLength(7);
    // No carrier is named: the delivery number's own rules propose the one confirmation lookup.
    expect(deliveryHandoff('anserx', IN_TRANSIT, normalizeCarrierResult(result))).toEqual({ carrier: 'usps', number: USPS, basis: 'reference' });
  });

  it('keeps the delivery carrier’s number without a routing ZIP, else takes the one its scans carry', () => {
    const routed = parseAnserx(changed('in-transit', (shipment) => { shipment.deliveryNo = `42000000${USPS}`; }), IN_TRANSIT);
    expect(routed.delivery_tracking_number).toBe(USPS);
    const scanned = parseAnserx(changed('in-transit', (shipment) => {
      shipment.deliveryNo = null;
      shipment.tksTrackingDetailDTOList[0]!.deliveryNo = 'SYN0000000001';
    }), IN_TRANSIT);
    expect(scanned.delivery_tracking_number).toBe('SYN0000000001');
    const split = parseAnserx(changed('in-transit', (shipment) => {
      shipment.deliveryNo = null;
      shipment.tksTrackingDetailDTOList[0]!.deliveryNo = 'SYN0000000001';
      shipment.tksTrackingDetailDTOList[1]!.deliveryNo = 'SYN0000000002';
    }), IN_TRANSIT);
    expect(split).not.toHaveProperty('delivery_tracking_number');
    for (const own of [IN_TRANSIT, '', 'X']) {
      expect(parseAnserx(changed('in-transit', (shipment) => { shipment.deliveryNo = own; }), IN_TRANSIT)).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('turns an oldest-first reply round, drops a repeated scan and falls back to the Chinese wording', () => {
    const result = parseAnserx(changed('delivered', (shipment) => {
      const rows = shipment.tksTrackingDetailDTOList;
      rows.reverse();
      rows.push({ ...rows.at(-1)! });
      rows[0]!.trackingContentEn = '';
    }), DELIVERED);
    expect(result.events).toHaveLength(12);
    expect(result.events!.map((event) => event.provider_code).slice(0, 2)).toEqual(['BTY_LASTMILE_DELIVERED', 'BTY_LASTMILE_DELIVERING']);
    expect(result.events!.at(-1)).toMatchObject({ description: '订单信息已收到', stage: 'registered' });
  });

  it('reads a code it does not know by its wording, and a scan without a code or place', () => {
    const result = parseAnserx(changed('in-transit', (shipment) => {
      shipment.tksTrackingDetailDTOList.unshift(
        { trackingCode: null, trackingContentEn: 'Synthetic note', trackingLocation: null, trackingTime: '2026-10-05 10:00:00' },
        { waybillNo: IN_TRANSIT, trackingCode: 'BTY_SYNTHETIC_STEP', trackingContentEn: 'Delivered to the recipient', trackingLocation: 'Springfield, 00000',
          trackingTime: '2026-10-04 10:00:00' },
      );
    }), IN_TRANSIT);
    expect(result.events![0]).toEqual({ local_time: '2026-10-05T10:00:00', description: 'Synthetic note' });
    expect(result.events![1]).toMatchObject({ location: 'Springfield', provider_code: 'BTY_SYNTHETIC_STEP', stage: 'delivered',
      stage_source: expect.stringMatching(/^wording/) });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Synthetic note' });
  });

  it('reads a known parcel without scans as no history', () => {
    for (const rows of [[], null]) {
      expect(() => parseAnserx(changed('in-transit', (shipment) => { shipment.tksTrackingDetailDTOList = rows as never; }), IN_TRANSIT))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('rejects an answer for another shipment', () => {
    const lookups = [
      changed('in-transit', (shipment) => { shipment.waybillNo = 'BTYCN0000067891YQ'; }),
      changed('in-transit', (shipment) => { shipment.tksTrackingDetailDTOList[2]!.waybillNo = 'BTYCN0000067891YQ'; }),
    ];
    for (const lookup of lookups) expect(() => parseAnserx(lookup, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker matches numbers in any case.
    expect(parseAnserx(changed('in-transit', (shipment) => { shipment.waybillNo = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(7);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Partial<Reply>).code; },
      (_shipment: Shipment, body: Reply) => { body.data = null as never; },
      (_shipment: Shipment, body: Reply) => { body.data.list = 'shipments' as never; },
      (_shipment: Shipment, body: Reply) => { delete (body.data as Partial<Reply['data']>).abnormalCount; },
      (_shipment: Shipment, body: Reply) => { body.data = { normalCount: 1, list: [], abnormalCount: 0 }; },
      (_shipment: Shipment, body: Reply) => { body.data.list = Array.from({ length: 11 }, () => body.data.list[0]!); },
      (_shipment: Shipment, body: Reply) => { body.data.list.push('shipment' as never); },
      (shipment: Shipment) => { delete shipment.waybillNo; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList = 'scans' as never; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList = Array.from({ length: 301 }, () => shipment.tksTrackingDetailDTOList[0]!); },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList[0]!.trackingCode = 'Arrived'; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList[0]!.trackingCode = 7; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList[0]!.trackingContentEn = null; shipment.tksTrackingDetailDTOList[0]!.trackingContentCn = ''; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList[0]!.trackingContentEn = { en: 'Arrived' }; },
      (shipment: Shipment) => { delete shipment.tksTrackingDetailDTOList[0]!.trackingTime; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList[0]!.trackingTime = 1790000000; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList[0]!.trackingTime = '2026-10-02T07:25:00+08:00'; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList[0]!.trackingTime = '2026-10-02 07:25'; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList[0]!.trackingTime = '2026-09-31 07:25:00'; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList[0]!.trackingTime = '2026-10-02 24:00:00'; },
      (shipment: Shipment) => { shipment.tksTrackingDetailDTOList[0]!.trackingLocation = 5; },
    ]) {
      expect(() => parseAnserx(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseAnserx('reply', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the tracker’s empty list as not found, and recognizes by the same lookup', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // A local clock dates the last activity without an instant.
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-21T12:40:15' });
  });

  it('keeps a failed lookup, a refusal, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    // The service's own error envelope is no answer about the parcel.
    await expect(lookup(reply({ code: 500, msg: 'Synthetic failure', data: null }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply({ code: 500, msg: 'Synthetic failure', data: null }))).recognize!(UNKNOWN))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(reply({ timestamp: '2026-10-01 12:00:00', status: 404, error: 'Not Found', path: '/client/cs/anserxWebsite/tracking/getTrackInfo' },
      { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply({ code: 403, msg: 'Forbidden' }, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // A browser check, even with HTTP 200 or 404, is never a missing parcel.
    await expect(lookup(new Response(CHECK, { status: 200, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response(CHECK, { status: 404, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<!DOCTYPE html><html><head><title>OMS</title></head><body><div id=app></div></body></html>', { status: 200 })))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('refuses a redirect, which would answer for another request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://oms.anserx.com/login' } }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      // An HTTP status is never sent again.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a lookup that does not reach the service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new AnserxTracker({ fetcher, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses numbers AnserX does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['BTYCN000006789YQ', 'BTYCN00000678900YQ', 'BTYUS0000067890YQ', 'BTYCN0000067890YX', 'CN0000067890YQ',
      `${IN_TRANSIT},${DELIVERED}`, 'BTYCN0000067890YQ/../1', USPS, `BTYCN${'0'.repeat(70)}YQ`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAnserxNumber(' btycn 0000.0678.90 yq ')).toBe(IN_TRANSIT);
  });

  it('routes a number filed under AnserX to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).startsWith(ANSERX_API)
      ? reply(fixture('in-transit')) : new Response('', { status: 503 }));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: IN_TRANSIT, carrier: 'anserx' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'anserx', source: 'anserx', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(`${ANSERX_API}?nos=${IN_TRANSIT}`))).toBe(true);
  });
});

describe('AnserX status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    const entries = statuses.entries as { code: string; wording: string; stage?: string }[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(anserxStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'anserx', providerCode: 'BTY_LASTMILE_DELIVERING', description: 'Parcel currently being delivered' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'anserx', providerCode: 'BTY_SYNTHETIC_STEP', description: 'Synthetic' })).toEqual({ kind: 'unknown' });
  });
});
