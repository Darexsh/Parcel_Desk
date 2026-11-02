import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LOGISTIQ_API, logistiqLookupUrl, LogistiqTracker } from './adapter.js';
import { logistiqWording, normalizeLogistiqNumber, parseLogistiq } from './parser.js';
import { logistiqStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ABCDEFG123456780';
const IN_TRANSIT = 'ABCDEFG000000000';
const UNKNOWN = 'ABCDEFGHI000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { scans: Row[]; current_status: Row | null };
type Reply = Row & { data: Shipment };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (data: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it stands in for a reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';

describe('Logistiq HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole waybill in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LogistiqTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' abcdefg 000-000-000 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LOGISTIQ_API}?alpha_awb=${IN_TRANSIT}`);
    expect(logistiqLookupUrl('abcdefg000000000')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'logistiq', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each scan as an instant and keeps the delivery once, without the sender’s address, the phone or the order', () => {
    const result = parseLogistiq(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Order Delivered', last_update: '2026-01-14T15:20:01Z', expected_delivery: null,
      delivered_at: '2026-01-14T15:20:01Z', destination_country: 'AE' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null, event.description]))
      .toEqual([
        ['2026-01-14T15:20:01Z', '112', 'delivered', 'LOGSMP', 'Order Delivered'],
        ['2026-01-14T05:00:00Z', '111', 'out_for_delivery', 'LOGSMP', 'Out For Delivery | Not available'],
        ['2026-01-13T14:30:00Z', '122', 'failed_attempt', 'LOGSMP', 'Order Delivery Failed | Future Date Delivery | 14th Jan \'26 | Not available'],
        ['2026-01-13T05:05:00Z', '111', 'out_for_delivery', 'LOGSMP', 'Out For Delivery'],
        ['2026-01-13T02:10:40Z', '110', 'in_transit', 'LOGSMP', 'Order In Transit'],
        ['2026-01-12T17:45:10Z', '110', 'in_transit', 'LOGSMQ', 'Order In Transit'],
        // The pickup scan names the sender's address, which is no hub.
        ['2026-01-12T06:30:00Z', '109', 'accepted', null, 'Order Picked Up'],
        ['2026-01-10T08:00:00Z', '101', 'registered', null, 'Booked'],
      ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Store|City|Town|Brand|Item)|Example Street|SAMPLE-|0500000000|Logistiqcp|COD/);
  });

  it('reads a parcel between hubs on its way to Saudi Arabia', () => {
    const result = parseLogistiq(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Order In Transit', last_update: '2026-02-03T21:15:00Z', expected_delivery: null, destination_country: 'SA' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.location ?? null])).toEqual([
      ['110', 'LOGSMR'], ['106', 'LOGSMQ'], ['109', null], ['101', null],
    ]);
  });

  it('adds a current status the scans do not have yet, and reads it alone', () => {
    const lagging = parseLogistiq(changed('in-transit', (data) => {
      data.current_status = { ...data.current_status, status_code: 111, status: 'OUT_FOR_DELIVERY', scan_time: '2026-02-04T06:00:00.000000Z',
        remarks: 'Out For Delivery', additional_remarks: null, status_sequence: 5 };
    }), IN_TRANSIT);
    expect(lagging).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: '2026-02-04T06:00:00Z' });
    expect(lagging.events).toHaveLength(5);
    const alone = parseLogistiq(changed('in-transit', (data) => { data.scans = []; }), IN_TRANSIT);
    expect(alone.events).toHaveLength(1);
    expect(alone).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Order In Transit' });
    expect(() => parseLogistiq(changed('in-transit', (data) => { data.scans = []; data.current_status = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('orders scans by their instant, then by their sequence, whatever order the reply has', () => {
    const result = parseLogistiq(changed('delivered', (data) => {
      data.scans.reverse();
      data.current_status = null;
      // Two scans at one instant keep the reply's sequence.
      Object.assign(data.scans[1]!, { scan_time: data.scans[0]!.scan_time });
    }), DELIVERED);
    expect(result.events!.slice(0, 2).map((event) => event.provider_code)).toEqual(['112', '111']);
    expect(result.events!.at(-1)).toMatchObject({ provider_code: '101' });
    // An instant with another offset keeps it and is the same moment as the hub scan, so the
    // sequence puts the transit first.
    const offset = parseLogistiq(changed('in-transit', (data) => {
      data.current_status = null;
      data.scans[3]!.scan_time = '2026-02-02T22:40:00+04:00';
    }), IN_TRANSIT);
    expect(offset.events!.slice(0, 2).map((event) => [event.provider_code, event.time])).toEqual([
      ['110', '2026-02-02T22:40:00+04:00'], ['106', '2026-02-02T18:40:00Z'],
    ]);
  });

  it('takes people, phone numbers, codes and links out of the wording', () => {
    expect(logistiqWording('Order Delivered', 'Delivered | Received by Sample Person', 'DELIVERED')).toBe('Order Delivered');
    expect(logistiqWording('Order Delivered', 'Collected by Sample Person', 'DELIVERED')).toBe('Order Delivered');
    expect(logistiqWording('Order Delivery Failed', 'Customer not reachable | +971 50 000 0000', 'FAILED_DELIVERY'))
      .toBe('Order Delivery Failed | Customer not reachable');
    expect(logistiqWording('Order Delivery Failed', 'Wrong address | sample@example.com', 'FAILED_DELIVERY'))
      .toBe('Order Delivery Failed | Wrong address');
    expect(logistiqWording('Out For Delivery', 'OTP 0000 | Delivery code: 000000 | https://example.com/pod', 'OUT_FOR_DELIVERY'))
      .toBe('Out For Delivery');
    // A date stays, and a part that repeats the remark is not doubled.
    expect(logistiqWording('Order Delivery Failed', 'Future Date Delivery | 2026-01-14 | Order Delivery Failed', 'FAILED_DELIVERY'))
      .toBe('Order Delivery Failed | Future Date Delivery | 2026-01-14');
    expect(logistiqWording('', 'Order In Hub', 'IN_HUB')).toBe('Order In Hub');
    expect(logistiqWording('', '', 'OUT_FOR_DELIVERY')).toBe('Out for delivery');
    expect(logistiqWording('', '', '')).toBe('');
  });

  it('reads an unknown waybill as not found, another refusal as inconclusive and a shipment without scans as no history', () => {
    expect(() => parseLogistiq(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLogistiq(fixture('not-found'), UNKNOWN.toLowerCase())).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLogistiq({ status: false, error_data: 'Something went wrong' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLogistiq({ status: false }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLogistiq(changed('delivered', (data) => { delete (data as Row).scans; data.current_status = null; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts an answer only when it names the waybill asked', () => {
    expect(() => parseLogistiq(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Logistiq answered for another shipment' }));
    expect(() => parseLogistiq(fixture('not-found'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Logistiq answered for another waybill' }));
    expect(parseLogistiq(changed('in-transit', (data) => { data.waybill = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(4);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_data: Shipment, body: Reply) => { delete (body as Row).status; },
      (_data: Shipment, body: Reply) => { body.status = 'ok'; },
      (_data: Shipment, body: Reply) => { body.data = 'shipment' as never; },
      (data: Shipment) => { delete data.waybill; },
      (data: Shipment) => { data.waybill = 0; },
      (data: Shipment) => { data.scans = 'scans' as never; },
      (data: Shipment) => { data.scans = Array.from({ length: 501 }, () => data.scans[0]!); },
      (data: Shipment) => { data.scans[0] = 'scan' as never; },
      (data: Shipment) => { data.current_status = 'INTRANSIT' as never; },
      (data: Shipment) => { data.scans[0]!.scan_time = '2026-02-01 10:00:00'; data.scans[0]!.time_stamp = null; },
      (data: Shipment) => { data.scans[0]!.scan_time = '01/02/2026 10:00'; },
      (data: Shipment) => { data.scans[0]!.scan_time = '2026-02-01T24:00:00Z'; },
      (data: Shipment) => { data.scans[0]!.scan_time = '2026-02-30T10:00:00Z'; },
      (data: Shipment) => { data.scans[0]!.scan_time = null; data.scans[0]!.time_stamp = null; },
      (data: Shipment) => { data.scans[0]!.scan_time = 1_769_940_000; },
      (data: Shipment) => { data.scans[0]!.status_code = '101'; },
      (data: Shipment) => { data.scans[0]!.status_code = -1; },
      (data: Shipment) => { data.scans[0]!.remarks = ['Booked']; },
      (data: Shipment) => { data.scans[0]!.status = null; },
    ]) {
      expect(() => parseLogistiq(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A missing scan time falls back to the record's own.
    expect(parseLogistiq(changed('in-transit', (data) => { data.scans[0]!.scan_time = null; }), IN_TRANSIT).events!.at(-1))
      .toMatchObject({ time: '2026-02-01T10:00:00Z' });
  });

  it('keeps an unknown waybill, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 400 })).rejects.toMatchObject({ kind: 'not_found' });
    // A 400 without the tracker's own answer is a changed reply.
    await expect(lookup({ message: 'Bad Request' }, { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>400 Bad Request</title></html>', { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    // The page reads an unknown waybill from a 400: a 404 or a redirect is a moved route.
    await expect(lookup({ message: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://logistiq.io/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHALLENGE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Logistiq</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ status: true, data: null })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known waybill and the unknown-waybill answer, and asks nothing for a number Logistiq does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 400 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-14T15:20:01.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ABC123')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Logistiq does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ABCDEF123456789', 'ABCDEFGHIJ123456789', 'ABCDEFG12345678', 'ABCDEFG1234567890', '123456789012345',
      'ABCDEFG12345678A', `ABCDEFG${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLogistiqNumber('abcdefghi 000-000-000')).toBe(UNKNOWN);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
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

  it('routes a waybill filed under Logistiq to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'logistiq' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'logistiq', source: 'logistiq', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === logistiqLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Logistiq numbers', () => {
  it('leaves its layout unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('logistiq');
    }
  });
});

describe('Logistiq status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(logistiqStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'logistiq', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(logistiqStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'logistiq', providerCode: '122', description: 'Order Delivery Failed' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'logistiq', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(logistiqStage('199', 'Order Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(logistiqStage('199', 'Synthetic note')).toBeNull();
    expect(logistiqStage('139', 'Order Delivered')).toBeNull();
  });
});
