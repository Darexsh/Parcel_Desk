import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SFC_API, SfcTracker } from './adapter.js';
import { normalizeSfcNumber, parseSfc, sfcWording } from './parser.js';
import { sfcMappedStage, sfcStage, sfcSummaryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'SFCAA0000000001YQ';
const IN_TRANSIT = 'SFC3WX0000000000002';
const UNKNOWN = 'SFC1ZZ0000000000003';

type Row = Record<string, unknown>;
type Reply = Row & { orderInfo: Row; trackingList: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
// The lookup answers JSON as text/html.
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'text/html;charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SFC HTTP adapter', () => {
  it('posts the whole number in capitals to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SfcTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' sfc3wx 0000-0000-00002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SFC_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe(`tracknumber=${IN_TRANSIT}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sfc', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the delivery’s wall clocks and SFC’s wording, without the estimate or the repeated scan', () => {
    const result = parseSfc(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-18T19:05:41', expected_delivery: null,
      destination_country: 'MX', delivery_tracking_number: 'JMX000000000001' });
    // J&T's name is the Chinese network's and its website J&T Mexico's home page: the
    // tracker leaves the partner to the number's own detection.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events).toHaveLength(21);
    expect(result.events!.every((event) => event.time === undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(result.events!.map((event) => [event.stage, event.description])).toEqual([
      ['delivered', 'Delivered'],
      ['out_for_delivery', 'Item out for delivery'],
      ['in_transit', 'Processing at facility'],
      ['in_transit', 'In transit'],
      ['in_transit', 'Processing at facility'],
      ['in_transit', 'Local courier warehouse, received and ready for processing'],
      ['in_transit', 'Shipment handed over to local ground transport for delivery hub transfer'],
      ['in_transit', 'Released by customs'],
      ['in_transit', 'Shipment ready for onward transportation to local delivery hub'],
      ['in_transit', 'Collected from airport terminal'],
      ['customs', 'Start import customs clearance'],
      ['in_transit', 'Arrived at Destination Airport'],
      ['in_transit', 'Flight departure from international airport to abroad'],
      ['in_transit', 'Arrive at international airport'],
      ['in_transit', 'Cargo have been handed over to line-haul'],
      ['in_transit', 'In transit to the international airport to abroad'],
      ['in_transit', 'Last mile courier=>J&T. Tracking No.: JMX000000000001 Tracking website: https://www.jtexpress.mx/'],
      ['in_transit', 'Departured from SFC warehouse'],
      ['accepted', 'Arrived at SFC warehouse'],
      ['accepted', 'SFC driver pick-up'],
      ['registered', 'Shipment information sent to SFC'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events!.slice(0, 3).map((event) => event.location)).toEqual(['SMP-Sample Point.pdv', 'SMP-Sample Point.pdv', 'SMP-Sample Point.pdv']);
    expect(result.events![7]).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Recipient|Driver)|Sampletown|(?<!JMX)0{10}(?!1)|000 000 0000|MON-FRI|LP0000|sample\.invalid|SMPLEXP|WX0000|Estimated/);
  });

  it('counts a delivery notice SFC writes again within a minute once, at the earlier clock', () => {
    const notices = (...dates: string[]) => parseSfc(changed('in-transit', (body) => {
      body.trackingList.splice(4, 0, ...dates.map((date) => ({ date, location: ' ', statu: 'Delivery notice' })));
    }), IN_TRANSIT).events!.filter((event) => event.description === 'Delivery notice').map((event) => event.local_time);
    expect(notices('2026-05-09 04:34:32', '2026-05-09 04:34:31')).toEqual(['2026-05-09T04:34:31']);
    expect(notices('2026-05-09 04:35:32', '2026-05-09 04:34:31')).toEqual(['2026-05-09T04:35:32', '2026-05-09T04:34:31']);
  });

  it('keeps an SFC number’s history at customs, with the partner’s number but no partner it cannot name', () => {
    const result = parseSfc(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Start import customs clearance', last_update_local: '2026-05-12T10:24:54',
      destination_country_name: 'Sampleland', delivery_tracking_number: 'SC0000000002' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('destination_country');
    expect(result.events!.find((event) => event.description!.startsWith('Last mile')))
      .toMatchObject({ description: 'Last mile courier=>Sample Courier. Tracking No.: SC0000000002 Tracking website: https://courier.example/' });
  });

  it('names the partner when the hand-over scan points to one catalog carrier whose rules take the number', () => {
    const handedTo = (statu: string, listed = '0000000001') => parseSfc(changed('in-transit', (body) => {
      body.orderInfo.tracking_number = listed;
      body.trackingList[4]!.statu = statu;
    }), IN_TRANSIT);
    const estafeta = 'Last mile courier=>Estafeta. Tracking No.: 0000000001 Tel: 000 000 0000 Tracking website: https://www.estafeta.com/';
    // A numeric partner number survives the phone numbers going.
    expect(handedTo(estafeta)).toMatchObject({ delivery_carrier: 'estafeta', delivery_tracking_number: '0000000001' });
    expect(handedTo(estafeta).events![4]!.description).toBe('Last mile courier=>Estafeta. Tracking No.: 0000000001 Tracking website: https://www.estafeta.com/');
    // The order's own partner number must agree with the scan.
    const conflicting = handedTo(estafeta, '0000000009');
    expect(conflicting).not.toHaveProperty('delivery_tracking_number');
    expect(conflicting).not.toHaveProperty('delivery_carrier');
    expect(handedTo(estafeta, '')).toMatchObject({ delivery_carrier: 'estafeta', delivery_tracking_number: '0000000001' });
    // A name whose rules do not take the number names no partner.
    expect(handedTo('Last mile courier=>Estafeta. Tracking No.: SC0000000002', 'SC0000000002')).not.toHaveProperty('delivery_carrier');
    // The scan naming the number asked is no hand-over.
    expect(handedTo(`Last mile courier=>SFC. Tracking No.: ${IN_TRANSIT}`, IN_TRANSIT)).not.toHaveProperty('delivery_tracking_number');
  });

  it('takes the order’s word for an end or a wait for collection over the scans', () => {
    expect(parseSfc(changed('in-transit', (body) => { body.track_status = 4; }), IN_TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map' });
    expect(parseSfc(changed('in-transit', (body) => { body.track_status = 5; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map' });
    for (const code of [1, 2, 6, 7, 99, '3', null]) {
      expect(parseSfc(changed('in-transit', (body) => { body.track_status = code; }), IN_TRANSIT), String(code))
        .toMatchObject({ current_stage: 'customs' });
    }
    expect(sfcSummaryStage(3)).toBe('delivered');
  });

  it('reads a history listed oldest first, or keyed by position as the page reads it, newest first', () => {
    const reversed = parseSfc(changed('in-transit', (body) => { body.trackingList.reverse(); }), IN_TRANSIT);
    expect(reversed).toMatchObject({ last_update_local: '2026-05-12T10:24:54', current_stage: 'customs', delivery_tracking_number: 'SC0000000002' });
    expect(reversed.events!.at(-1)).toMatchObject({ description: 'Shipment information sent to SFC' });
    const keyed = parseSfc(changed('in-transit', (body) => {
      body.trackingList = Object.assign(Object.fromEntries(body.trackingList.map((row, index) => [String(index), row])), { track_status: 1 }) as never;
    }), IN_TRANSIT);
    expect(keyed.events!.map((event) => event.description)).toEqual(parseSfc(fixture('in-transit'), IN_TRANSIT).events!.map((event) => event.description));
    // The month came first in older replies.
    const older = parseSfc(changed('in-transit', (body) => { body.trackingList[0]!.date = '05/12/2026 10:24:54'; }), IN_TRANSIT);
    expect(older.events![0]).toMatchObject({ local_time: '2026-05-12T10:24:54' });
  });

  it('keeps SFC’s wording without the partner’s text, people or phone numbers', () => {
    expect(sfcWording('Delivered(¡Envío entregado! La persona que recibió el envío【Sample Person】, tel 000 000 0000)')).toEqual({ description: 'Delivered' });
    expect(sfcWording('Released by customs（Released by customs）').description).toBe('Released by customs');
    // Brackets inside SFC's own wording stay.
    expect(sfcWording('Arrive at Sample Post (SP) facility').description).toBe('Arrive at Sample Post (SP) facility');
    expect(sfcWording('Contact the courier Tel: +00 000 000 0000').description).toBe('Contact the courier');
    expect(sfcWording('Call 000-000-0000 for help').description).toBe('Call for help');
    expect(sfcWording('Last mile courier=>Sample Post. Tracking No.: sp-000000001 Tel: 0000000000')).toEqual({
      description: 'Last mile courier=>Sample Post. Tracking No.: SP000000001',
      handover: { name: 'Sample Post', number: 'SP000000001', website: '' },
    });
    // A date stays.
    expect(sfcWording('Held until 2026-05-20').description).toBe('Held until 2026-05-20');
  });

  it('reads an unknown number as not found, an order without scans as no history, and several orders as inconclusive', () => {
    expect(() => parseSfc(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSfc(changed('in-transit', (body) => { body.trackingList = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseSfc(changed('in-transit', (body) => { delete (body as Row).trackingList; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // The estimate alone is no scan.
    expect(() => parseSfc(changed('delivered', (body) => { body.trackingList = body.trackingList.slice(15, 16); }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseSfc(changed('delivered', (body) => {
      body.trackingList = [{ date: '2026-03-12 21:19:00', location: 'Example Airport, NL', statu: 'Estimated Time of International Flight Arrival' }];
    }), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseSfc(changed('in-transit', (body) => { body.count = 2; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SFC found several orders for the number' }));
  });

  it('counts an order only when its own code, its AliExpress number or its partner number is the number asked', () => {
    expect(() => parseSfc(fixture('not-found'), 'SFC1ZZ0000000000004'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SFC answered for another number' }));
    expect(() => parseSfc(changed('in-transit', (body) => { body.order_code = DELIVERED; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SFC answered for another shipment' }));
    expect(() => parseSfc(changed('in-transit', (body) => { body.orderInfo.order_code = 'WX0000000000009'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SFC answered for another shipment' }));
    expect(() => parseSfc(changed('delivered', (body) => { body.orderInfo.order_code_ae = 'SFCAA0000000009YQ'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SFC answered for another shipment' }));
    // The tracker reads the digit after SFC loosely; the order code is the identity.
    const otherDigit = 'SFC1WX0000000000002';
    expect(parseSfc(changed('in-transit', (body) => { body.order_code = otherDigit; }), otherDigit).events).toHaveLength(8);
    expect(parseSfc(changed('in-transit', (body) => { body.order_code = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(8);
    // A partner's number of digits counts when the order lists it as its tracking number.
    const partner = '000000000012';
    expect(parseSfc(changed('in-transit', (body) => { body.order_code = partner; body.orderInfo.tracking_number = partner; }), partner).events)
      .toHaveLength(8);
    expect(() => parseSfc(changed('in-transit', (body) => { body.order_code = partner; }), partner))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SFC answered for another shipment' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).count; },
      (body: Reply) => { body.count = '1'; },
      (body: Reply) => { body.count = 1.5; },
      (body: Reply) => { delete (body as Row).order_code; },
      (body: Reply) => { body.order_code = { code: IN_TRANSIT }; },
      (body: Reply) => { body.orderInfo = 'order' as never; },
      (body: Reply) => { body.orderInfo.order_code = ['WX0000000000002']; },
      (body: Reply) => { body.trackingList = 'scans' as never; },
      (body: Reply) => { body.trackingList = Array.from({ length: 501 }, () => body.trackingList[0]!); },
      (body: Reply) => { body.trackingList[0] = 'scan' as never; },
      (body: Reply) => { body.trackingList[0]!.date = '2026-05-12T10:24:54Z'; },
      (body: Reply) => { body.trackingList[0]!.date = '2026-02-30 10:24:54'; },
      (body: Reply) => { body.trackingList[0]!.date = '2026-05-12 24:00:00'; },
      (body: Reply) => { delete body.trackingList[0]!.date; },
      (body: Reply) => { body.trackingList[0]!.statu = ['Delivered']; },
      (body: Reply) => { body.trackingList[0]!.statu = ' '; },
      (body: Reply) => { body.trackingList[0]!.location = { city: 'Sample' }; },
    ]) {
      expect(() => parseSfc(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSfc(null, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The lookup answers every number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.sendfromchina.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // Aliyun's firewall refuses a client with 405 and its block page, or puts its check in the reply.
    await expect(lookup('<html><body>potential threats to the server’s security</body></html>', { status: 405 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script>var arg1=\'00\';document.cookie="acw_sc__v2="+x;</script></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>SFC</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('﻿{"count":0,"order_code":"SFC1ZZ0000000000003"}')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number SFC does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-18T19:05:41' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('WX0000000000002')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers SFC does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['WX0000000000002', 'SFCWX0000000000002', 'SFC3WX000000000000', 'SFC3WX000000000000002', 'SFCAA000000001YQ',
      'JMX000000000001', '000000001', '0'.repeat(31), `SFC3WX${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSfcNumber('sfcaa 0000-0000-01 yq')).toBe(DELIVERED);
    expect(normalizeSfcNumber('SFC2WI00000000000000')).toBe('SFC2WI00000000000000');
    expect(normalizeSfcNumber('0000 0000 0012')).toBe('000000000012');
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
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

  it('routes a number filed under SFC, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'sfc' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'sfc', source: 'sfc', result: { current_stage: 'delivered', delivery_tracking_number: 'JMX000000000001' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'sfc', source: 'sfc' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === SFC_API)).toBe(true);
  });
});

describe('SFC numbers', () => {
  it('claims SFC numbers and the numbers SFC gives AliExpress orders', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN, 'SFC2WI00000000000000', 'SFCZZ9999999999YQ']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'sfc', confidence: 'high' });
    }
    for (const number of ['WX0000000000002', 'SFCAA00000000001YQ', 'SFCA0000000001YQ', 'SFC3WX000000000000']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('sfc');
    }
  });
});

describe('SFC status vocabulary', () => {
  it('records every wording and order status the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.code) {
        // The order's status codes stage the order, never a scan.
        const summary = sfcSummaryStage(Number(entry.code));
        if (summary) expect(summary, entry.wording).toBe(entry.stage);
        continue;
      }
      const wording = entry.wording.replace('[courier]', 'Sample Courier').replace('[number]', 'SC0000000002');
      if (entry.unmapped) {
        expect(statusMap.stage(null, wording.toLowerCase()), wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'sfc', providerCode: null, description: wording }), wording).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(null, wording.toLowerCase()), wording).toBe(entry.stage);
      expect(sfcStage(wording), wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'sfc', providerCode: null, description: 'Item out for delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'sfc', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Wording the map does not know falls to the shared rules.
    expect(sfcMappedStage('Arrived at the sorting centre')).toBeUndefined();
    expect(sfcStage('Arrived at the sorting centre')).toMatchObject({ stage: 'in_transit' });
    expect(sfcStage('Synthetic note')).toBeNull();
  });
});
