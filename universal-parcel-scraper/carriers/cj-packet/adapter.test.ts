import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CJ_PACKET_API, CjPacketTracker } from './adapter.js';
import { cjPacketWording, normalizeCjPacketNumber, parseCjPacket } from './parser.js';
import { cjPacketStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = 'CJPZZA0000000001YQ';
const DELIVERED = 'CJPZZB0000000002YQ';
const UNKNOWN = 'CJPZZ0000000003YQ';

type Row = Record<string, unknown>;
type Shipment = Row & { trackEvent: Row[] };
type Reply = Row & { data: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The service's answer to a request it cannot read.
const FAILURE = { status: 'ERROR', errors: [{ code: 1002100, message: '未知错误:system error, traceId=00000000' }], code: 0, data: null,
  message: '未知错误:system error, traceId=00000000', success: false };

describe('CJ Packet HTTP adapter', () => {
  it('posts the whole number in capitals as the page’s one-number list, once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CjPacketTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cjpzza 0000000001 yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(CJ_PACKET_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual([IN_TRANSIT]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cj-packet', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history at each scan’s offset, with the courier and its number', () => {
    const result = parseCjPacket(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Package delivered',
      last_update: '2026-05-12T13:05:10-04:00', expected_delivery: null, delivered_at: '2026-05-12T13:05:10-04:00',
      service_name: 'CJPacket Ordinary B', destination_country: 'US',
      // A routing barcode gives its package identifier, without the recipient's ZIP code.
      delivery_carrier: 'usps', delivery_tracking_number: '9400111000001234567804' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-05-12T13:05:10-04:00', 'delivered', 'SAMPLE CITY,US'],
      ['2026-05-12T07:31:40-04:00', 'out_for_delivery', 'SAMPLE CITY,US'],
      ['2026-05-12T07:02:15-04:00', 'in_transit', 'SAMPLE CITY,US'],
      // The repeated scan is kept once; a line's own place stands in for a missing location.
      ['2026-05-11T22:48:03-04:00', 'in_transit', 'US,SAMPLE DISTRIBUTION CENTER'],
      ['2026-05-10T09:15:00-04:00', 'in_transit', null],
      ['2026-05-09T18:20:00-04:00', 'in_transit', null],
      ['2026-05-08T23:40:00+08:00', 'in_transit', null],
      ['2026-05-07T06:12:44+08:00', 'in_transit', null],
      ['2026-05-05T21:03:17+08:00', 'in_transit', null],
      ['2026-05-05T21:03:16+08:00', 'in_transit', null],
      ['2026-05-02T16:30:05+08:00', 'registered', null],
      // CJ's own line has no timestamp: its wall clock stays.
      ['2026-05-02T08:30:06', 'registered', null],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).not.toHaveProperty('time');
    expect(result.events!.slice(0, 3).map((event) => event.description)).toEqual(['Package delivered', 'Out for delivery', 'Arrived at local delivery center']);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Shop|Person)|SAMPLE2|DP0000|LP0000|000-000-0000|42000000/);
  });

  it('lets the scans say whether customs still holds a parcel at the destination, in the reply’s order', () => {
    const result = parseCjPacket(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'wording:language',
      last_status_text: 'Inbound to customs temporary warehouse', last_update: '2026-09-22T16:48:00+01:00', service_name: 'CJPacket Ordinary I',
      destination_country: 'ES', delivery_carrier: 'ctt-express', delivery_tracking_number: '0099990000000000000001' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description, event.stage ?? null])).toEqual([
      ['2026-09-22T16:48:00+01:00', 'Inbound to customs temporary warehouse', 'customs'],
      ['2026-09-21T21:47:00+01:00', 'NOA-Notification of arrival from GHA', 'in_transit'],
      ['2026-09-21T10:22:00+01:00', 'Item Flight landing', 'in_transit'],
      ['2026-09-21T05:20:00+08:00', 'Item Flight departure', 'in_transit'],
      ['2026-09-20T21:30:00+08:00', 'Released From Export Customs', 'in_transit'],
      ['2026-09-20T07:36:55+08:00', 'Item departed from origin.', 'in_transit'],
      ['2026-09-18T21:29:14+08:00', 'Item outbound in sorting center.', 'in_transit'],
      ['2026-09-18T18:33:49+08:00', 'Item has been collected', 'accepted'],
      // The courier's notice is later than the pickup, but the page lists it by its wall clock.
      ['2026-09-18T12:44:15+02:00', 'Pendiente de recepción en CTT Express', 'registered'],
      ['2026-09-14T17:08:20+08:00', 'Electronic notification of order creation received.', 'registered'],
      ['2026-09-14T09:08:22', 'Label created. Warehouse is processing this order. Please wait in patience.', 'registered'],
    ]);
    expect(result.events![5]).toMatchObject({ location: 'CHINA, SAMPLE TRANSIT CENTER' });
  });

  it('takes the summary’s word for a delivery problem, a pickup or a parcel out for delivery, and an earlier scan never undoes it', () => {
    const stage = (status: unknown, change: (shipment: Shipment) => void = () => {}) => parseCjPacket(changed('in-transit', (shipment) => {
      shipment.status = status;
      change(shipment);
    }), IN_TRANSIT);
    expect(stage(6)).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    expect(stage(5)).toMatchObject({ current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map' });
    expect(stage(4)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(stage(7)).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    // Dispatched stays accepted under the forwarder's notice of the order.
    expect(stage(1, (shipment) => { shipment.trackEvent = shipment.trackEvent.slice(-2); }))
      .toMatchObject({ current_stage: 'accepted', current_stage_source: 'carrier_map' });
    expect(stage(2)).toMatchObject({ current_stage: 'customs' });
    // A summary it does not know, or none, leaves the stage to the scans.
    expect(stage(9)).toMatchObject({ current_stage: 'customs' });
    expect(stage(null)).toMatchObject({ current_stage: 'customs' });
  });

  it('dates a delivery only from a delivered scan that has an offset', () => {
    // The delivered scan's wall clock alone gives no moment.
    const walled = parseCjPacket(changed('delivered', (shipment) => { shipment.trackEvent[0]!.eventTimestamp = null; }), DELIVERED);
    expect(walled).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-05-12T13:05:10' });
    expect(walled).not.toHaveProperty('delivered_at');
    // A delivery the summary gives over scans that do not say it has none either.
    const summarized = parseCjPacket(changed('in-transit', (shipment) => { shipment.status = 7; }), IN_TRANSIT);
    expect(summarized).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(summarized).not.toHaveProperty('delivered_at');
    const bare = parseCjPacket(changed('in-transit', (shipment) => { shipment.trackEvent = []; shipment.status = 7; }), IN_TRANSIT);
    expect(bare).toMatchObject({ current_stage: 'delivered', summary_only: true });
    expect(bare).not.toHaveProperty('delivered_at');
  });

  it('keeps a shipment the tracker lists without scans as a summary', () => {
    const summary = parseCjPacket(changed('in-transit', (shipment) => {
      shipment.trackEvent = [];
      shipment.status = 0;
      shipment.statusDescription = 'Processing';
    }), IN_TRANSIT);
    expect(summary).toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Processing', provider_code: '0', summary_only: true, events: [], service_name: 'CJPacket Ordinary I' });
    expect(() => parseCjPacket(changed('in-transit', (shipment) => { shipment.trackEvent = []; shipment.status = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseCjPacket(changed('in-transit', (shipment) => { delete (shipment as Row).trackEvent; shipment.status = 9; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('keeps the wall clock when the scan’s two clocks do not differ by an offset', () => {
    const result = parseCjPacket(changed('in-transit', (shipment) => {
      shipment.trackEvent[0]!.eventTimestamp = String(Date.parse('2026-09-22T15:48:07Z'));
      shipment.trackEvent[1]!.eventTimestamp = Date.parse('2026-09-21T20:47:00Z');
      shipment.trackEvent[2]!.eventTimestamp = '';
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-09-22T16:48:00' });
    expect(result.events!.slice(0, 3).map((event) => event.time ?? event.local_time))
      .toEqual(['2026-09-22T16:48:00', '2026-09-21T21:47:00+01:00', '2026-09-21T10:22:00']);
  });

  it('takes the courier’s support contact, phone numbers, addresses and the person who signed out of the wording', () => {
    expect(cjPacketWording('Delivered, At the door/Yard，For Delivery Issues & Tracking Support, Contact Sample Courier at +1 000 000-0000 or help@sample.example'))
      .toBe('Delivered, At the door/Yard');
    expect(cjPacketWording('Arrived at the station, call 000-000-0000')).toBe('Arrived at the station, call');
    expect(cjPacketWording('Notice sent to sample@sample.example on 2026-05-20')).toBe('Notice sent to on 2026-05-20');
    const result = parseCjPacket(changed('delivered', (shipment) => {
      shipment.trackEvent[0]!.activity = '<b>[US,SAMPLE CITY,ST]</b> Package delivered, received by Sample Person';
      shipment.trackEvent[1]!.activity = 'Out for delivery, signed by nobody yet';
    }), DELIVERED);
    expect(result.events!.slice(0, 2).map((event) => event.description)).toEqual(['Package delivered', 'Out for delivery, signed by nobody yet']);
    // A line left empty says nothing and is skipped.
    const empty = parseCjPacket(changed('delivered', (shipment) => { shipment.trackEvent[1]!.activity = '<br>'; }), DELIVERED);
    expect(empty.events).toHaveLength(11);
  });

  it('names the courier only when the reply does and the number fits it', () => {
    const handoff = (change: (shipment: Shipment) => void) => {
      const result = parseCjPacket(changed('in-transit', change), IN_TRANSIT);
      return [result.delivery_carrier ?? null, result.delivery_tracking_number ?? null];
    };
    expect(handoff((shipment) => { shipment.providerEnName = null; shipment.providerUrl = null; })).toEqual([null, '0099990000000000000001']);
    expect(handoff((shipment) => { shipment.providerEnName = 'Sample Courier'; shipment.providerUrl = 'https://courier.sample.example/'; }))
      .toEqual([null, '0099990000000000000001']);
    expect(handoff((shipment) => { shipment.lastTrackNumber = 'SMP000000001'; })).toEqual([null, 'SMP000000001']);
    expect(handoff((shipment) => { shipment.lastTrackNumber = null; })).toEqual([null, null]);
    expect(handoff((shipment) => { shipment.lastTrackNumber = IN_TRANSIT; })).toEqual([null, null]);
    expect(handoff((shipment) => { shipment.lastTrackNumber = 'S-0'; })).toEqual([null, null]);
  });

  it('reads an unknown number as not found and a failed lookup as inconclusive', () => {
    expect(() => parseCjPacket(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCjPacket(FAILURE, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a shipment only when its own number is the one asked', () => {
    // The tracker also finds a shipment by its forwarder's or courier's number.
    expect(() => parseCjPacket(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CJ Packet answered for another shipment' }));
    const both = fixture('delivered');
    both.data.push(...fixture('in-transit').data);
    expect(parseCjPacket(both, IN_TRANSIT)).toMatchObject({ current_stage: 'customs' });
    both.data.push(fixture('in-transit').data[0]!);
    expect(() => parseCjPacket(both, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseCjPacket(changed('in-transit', (shipment) => { shipment.cjTrackNumber = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(11);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).success; },
      (_shipment: Shipment, body: Reply) => { body.success = 'true'; },
      (_shipment: Shipment, body: Reply) => { body.data = null as never; },
      (_shipment: Shipment, body: Reply) => { body.data = { shipment: true } as never; },
      (_shipment: Shipment, body: Reply) => { body.data = Array.from({ length: 51 }, () => body.data[0]!); },
      (_shipment: Shipment, body: Reply) => { body.data[0] = 'shipment' as never; },
      (shipment: Shipment) => { delete shipment.cjTrackNumber; },
      (shipment: Shipment) => { shipment.cjTrackNumber = 7; },
      (shipment: Shipment) => { shipment.trackEvent = 'scans' as never; },
      (shipment: Shipment) => { shipment.trackEvent = Array.from({ length: 501 }, () => shipment.trackEvent[0]!); },
      (shipment: Shipment) => { shipment.trackEvent[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.trackEvent[0]!.activity = ['Delivered']; },
      (shipment: Shipment) => { shipment.trackEvent[0]!.location = 7; },
      (shipment: Shipment) => { shipment.trackEvent[0]!.eventTime = '22/09/2026 16:48'; },
      (shipment: Shipment) => { shipment.trackEvent[0]!.eventTime = '2026-09-22 24:00:00'; },
      (shipment: Shipment) => { shipment.trackEvent[0]!.eventTime = '2026-02-30 10:00:00'; },
      (shipment: Shipment) => { delete shipment.trackEvent[0]!.eventTime; },
      (shipment: Shipment) => { shipment.trackEvent[0]!.eventTimestamp = 'yesterday'; },
      (shipment: Shipment) => { shipment.trackEvent[0]!.eventTimestamp = -1; },
      (shipment: Shipment) => { shipment.trackEvent[0]!.eventTimestamp = 1.5; },
      (shipment: Shipment) => { shipment.status = '3'; },
      (shipment: Shipment) => { shipment.status = 3.5; },
      (shipment: Shipment) => { shipment.logisticsName = { name: 'CJPacket' }; },
      (shipment: Shipment) => { shipment.lastTrackNumber = 7; },
    ]) {
      expect(() => parseCjPacket(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check, a failure and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers an unknown number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.cjpacket.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>CJPacket for Small Packages Tracking</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(FAILURE)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number CJ Packet does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-12T17:05:10.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('LP00000000000002CN')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers CJ Packet does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // The forwarder's and the courier's numbers stay with their carriers.
    for (const number of ['LP00000000000002CN', 'YT0000000000000001', 'CJPZ0000000001YQ', 'CJPZZZZ0000000001YQ', 'CJPZZ000000001YQ', 'CJPZZ0000000001', `CJPZZ${'0'.repeat(60)}YQ`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCjPacketNumber('cjpzzb 0000-0000-02 yq')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'customs' });
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

  it('routes a number filed under CJ Packet, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'cj-packet' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'cj-packet', source: 'cj-packet', result: { current_stage: 'customs' } });
    await expect(tracker.track({ number: IN_TRANSIT }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'cj-packet', source: 'cj-packet' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === CJ_PACKET_API)).toBe(true);
  });
});

describe('CJ Packet numbers', () => {
  it('claims its own layout and the fixtures’ partner numbers stay with their carriers', () => {
    for (const number of [IN_TRANSIT, DELIVERED, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'cj-packet', confidence: 'high' });
    }
    expect(detectCarrierMatch('9400111000001234567804').candidates).toContain('usps');
    expect(detectCarrierMatch('0099990000000000000001').candidates).toContain('ctt-express');
  });
});

describe('CJ Packet status vocabulary', () => {
  it('records every summary status and wording with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.code) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
        continue;
      }
      if (entry.unmapped) {
        expect(cjPacketStage(entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'cj-packet', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(cjPacketStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'cj-packet', providerCode: null, description: 'Item has been collected' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'cj-packet', providerCode: '6', description: 'Unsuccessful Delivery' }))
      .toEqual({ kind: 'mapped', stage: 'exception' });
    expect(cjPacketStage('Synthetic note')).toBeNull();
  });
});
