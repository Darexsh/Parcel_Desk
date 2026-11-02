import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TRACKON_API, TrackonTracker } from './adapter.js';
import { normalizeTrackonNumber, parseTrackon, trackonWording } from './parser.js';
import { statusMap, trackonStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000000011';
const IN_TRANSIT = '300000000022';
const RETURNED = '500000000033';
const PLACEHOLDER = '700000000044';
const UNKNOWN = '900000000055';
const OLDER = '1100000066';

type Row = Record<string, unknown>;
interface Reply { summaryTrack: Record<string, unknown> | null; lstDetails: Row[] | null; ResponseStatus: Record<string, unknown> }

const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const edited = (name: string, edit: (reply: Reply) => void) => {
  const reply = fixture(name);
  edit(reply);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookupUrl = (number: string) => `${TRACKON_API}?AWBNo=${number}&AppKey=3656&RequestType=AWBNo`;

describe('Trackon HTTP adapter', () => {
  it('looks the whole AWB number up as the Android app does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TrackonTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 0000 0011 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(lookupUrl(DELIVERED));
    expect(url).toBe('https://api.trackon.in/MobileAPP/AndroidApi/t1/CustDetailTracking?AWBNo=100000000011&AppKey=3656&RequestType=AWBNo');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'trackon', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads Indian wall clocks at UTC+5:30 and stages each scan by its code, newest first', () => {
    const result = parseTrackon(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED WITH MOBILE APP UPDATE', last_update: '2026-09-14T10:48:00Z', delivered_at: '2026-09-14T10:48:00Z',
      expected_delivery: null, timezone: 'Asia/Kolkata' });
    expect(result.events!.map((event) => [event.time, event.location, event.provider_code, event.stage, event.description])).toEqual([
      ['2026-09-14T10:48:00Z', 'SOUTHGANJ (MARKET ROAD), SAMPLE STATE', 'DDUF', 'delivered', 'DELIVERED WITH MOBILE APP UPDATE'],
      // The repeated manifest scan is kept once.
      ['2026-09-14T04:22:00Z', 'SOUTHGANJ (MARKET ROAD), SAMPLE STATE', 'DRBG', 'out_for_delivery', 'DELIVERY MANIFEST PREPARED FOR SOUTHGANJ (MARKET ROAD)'],
      ['2026-09-11T15:23:00Z', 'NORTHPUR BRANCH, SAMPLE STATE', 'BOKN', 'accepted', 'S/MENT BOOKED'],
      ['2026-09-11T13:29:00Z', 'NORTHPUR PICKUP', 'FMDT', 'accepted', 'S/MENT PICKED UP'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.local_time)).toBe(true);
    expect(result).not.toHaveProperty('history_truncated');
  });

  it('keeps no receiver, phone number, reference, postcode, weight, booking detail or proof of delivery link', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT], ['returned', RETURNED]] as const) {
      const text = JSON.stringify(parseTrackon(fixture(name), number));
      expect(text, name).not.toMatch(/ASHA|SAMPLE ?REF|98765|43210|100001|200002|300003|0\.5500|3\.0000|STNDS|AIR"|SURFACE|pod\.example|S10001|NRTH-|EST01|MDVL-|WSTB-|NULL/);
    }
    expect(trackonWording('DELIVERED WITH MOBILE APP UPDATE - NULL', 'delivered')).toBe('DELIVERED WITH MOBILE APP UPDATE');
    expect(trackonWording('RTO DELIVERED TO CUSTOMER / BRANCH - R SAMPLE', 'returned')).toBe('RTO DELIVERED TO CUSTOMER / BRANCH');
    expect(trackonWording('UNDELIVERED - DOOR LOCKED, CALL +91 98765-43210', 'failed_attempt')).toBe('UNDELIVERED - DOOR LOCKED, CALL');
  });

  it('reads a consignment on its way, with scans staged by their wording when they come without a code', () => {
    const result = parseTrackon(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_status_text: 'S/MENT ARRIVED AT EASTMOOR BRANCH', last_update: '2026-10-15T16:00:00Z', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.provider_code ?? null, event.stage, event.description])).toEqual([
      ['2026-10-15T16:00:00Z', null, 'in_transit', 'S/MENT ARRIVED AT EASTMOOR BRANCH'],
      ['2026-10-15T11:35:00Z', null, 'failed_attempt', 'UNDELIVERED - CONSIGNEE NOT AVAILABLE, CALLED'],
      ['2026-10-15T04:50:00Z', 'DRBG', 'out_for_delivery', 'DELIVERY MANIFEST PREPARED FOR EASTMOOR'],
      ['2026-10-14T18:10:00Z', null, 'in_transit', 'S/MENT ARRIVED AT EASTMOOR BRANCH'],
      ['2026-10-12T13:45:00Z', 'BOKN', 'accepted', 'S/MENT BOOKED'],
    ]);
  });

  it('reads a return to the sender as returned, and one under way as an exception', () => {
    expect(parseTrackon(fixture('returned'), RETURNED)).toMatchObject({ status: 'exception', current_stage: 'returned',
      current_stage_source: 'carrier_map', last_status_text: 'RTO DELIVERED TO CUSTOMER / BRANCH', last_update: '2026-08-21T06:13:00Z' });
    expect(parseTrackon(fixture('returned'), RETURNED)).not.toHaveProperty('delivered_at');
    const underWay = parseTrackon(edited('returned', (reply) => { reply.lstDetails!.shift(); }), RETURNED);
    expect(underWay).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'RTO HANDOVER PREPARED FOR WESTBROOK' });
    // A return code not seen yet is staged by its wording, not as a delivery.
    expect(trackonStage('ZRTD', 'RTO DELIVERED TO SHIPPER')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(trackonStage('ZRTO', 'RTO IN TRANSIT')).toEqual({ stage: 'exception', source: 'carrier_map' });
  });

  it('keeps an unknown code without a stage, sorts a history listed oldest first and caps a long one', () => {
    const unknown = parseTrackon(edited('in-transit', (reply) => {
      reply.lstDetails![0]!.TRACKING_CODE = 'ZZZZ';
      reply.lstDetails![0]!.CURRENT_STATUS = 'SAMPLE NOTE';
    }), IN_TRANSIT);
    expect(unknown.events![0]).toMatchObject({ provider_code: 'ZZZZ', description: 'SAMPLE NOTE' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    expect(unknown).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'SAMPLE NOTE' });
    expect(trackonStage('ZZZZ', 'SAMPLE NOTE')).toBeNull();
    const reversed = parseTrackon(edited('delivered', (reply) => { reply.lstDetails!.reverse(); }), DELIVERED);
    expect(reversed.events![0]).toMatchObject({ provider_code: 'DDUF' });
    expect(reversed.events!.at(-1)).toMatchObject({ provider_code: 'FMDT' });
    const long = parseTrackon(edited('in-transit', (reply) => {
      reply.lstDetails = Array.from({ length: 120 }, (_, index) => ({ ...reply.lstDetails![3]!,
        EVENTTIME: `${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00` }));
    }), IN_TRANSIT);
    expect(long).toMatchObject({ history_truncated: true, last_update: '2026-10-13T20:29:00Z' });
    expect(long.events).toHaveLength(100);
  });

  it('keeps scans of one second in the reply’s order, reversed when it lists them oldest first', () => {
    const codes = (reverse: boolean) => parseTrackon(edited('delivered', (reply) => {
      reply.lstDetails![0]!.EVENTTIME = '09:52:00';
      if (reverse) reply.lstDetails!.reverse();
    }), DELIVERED).events!.map((event) => event.provider_code);
    expect(codes(false)).toEqual(['DDUF', 'DRBG', 'BOKN', 'FMDT']);
    expect(codes(true)).toEqual(['DDUF', 'DRBG', 'BOKN', 'FMDT']);
  });

  it('reads the service’s own answers: not found, a number outside Trackon’s series, a placeholder and an unfinished lookup', () => {
    expect(() => parseTrackon(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTrackon(fixture('not-trackon'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseTrackon(fixture('placeholder'), PLACEHOLDER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseTrackon(edited('in-transit', (reply) => { reply.lstDetails = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    for (const message of ['S/ment can not be empty...!', 'Request Failed due to reason, Old Shipment, prior to 90 days', 'ERROR']) {
      expect(() => parseTrackon(edited('not-found', (reply) => { reply.ResponseStatus.Message = message; }), UNKNOWN), message)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('counts a consignment only when the reply names the whole number asked', () => {
    expect(() => parseTrackon(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Trackon answered for another consignment' }));
    for (const awb of ['30000000002', '3000000000221', '300000000023', ' 300000000022 x']) {
      expect(() => parseTrackon(edited('in-transit', (reply) => { reply.summaryTrack!.AWBNO = awb; }), IN_TRANSIT), awb)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // A customer reference lookup can answer without the AWB number.
    for (const awb of [null, 300000000022, { value: IN_TRANSIT }]) {
      expect(() => parseTrackon(edited('in-transit', (reply) => { reply.summaryTrack!.AWBNO = awb; }), IN_TRANSIT), String(awb))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTrackon(edited('in-transit', (reply) => { reply.summaryTrack = null; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed reply', () => {
    for (const reply of [
      null, [], 'SUCCESS', { Message: 'SUCCESS' }, { ResponseStatus: { Status: true } }, { ResponseStatus: { Message: 1 } },
      edited('in-transit', (reply) => { reply.lstDetails = {} as never; }),
      edited('in-transit', (reply) => { reply.lstDetails![0] = 'scan' as never; }),
      edited('in-transit', (reply) => { reply.lstDetails![0]!.CURRENT_STATUS = ''; reply.lstDetails![0]!.TRACKING_CODE = 'DRBG'; }),
      edited('in-transit', (reply) => { reply.lstDetails![0]!.CURRENT_STATUS = { text: 'SAMPLE' }; }),
      edited('in-transit', (reply) => { reply.lstDetails![0]!.CURRENT_CITY = 7; }),
      edited('in-transit', (reply) => { reply.lstDetails![0]!.EVENTTIME = '24:00:00'; }),
      edited('in-transit', (reply) => { reply.lstDetails![0]!.EVENTTIME = '21:30'; }),
      edited('in-transit', (reply) => { reply.lstDetails![0]!.EVENTDATE = '31/09/2026'; }),
      edited('in-transit', (reply) => { reply.lstDetails![0]!.EVENTDATE = '15-Oct-2026'; }),
      edited('in-transit', (reply) => { reply.lstDetails![0]!.EVENTDATE = null; }),
      edited('in-transit', (reply) => { reply.lstDetails = Array.from({ length: 501 }, () => reply.lstDetails![0]!); }),
    ]) {
      expect(() => parseTrackon(reply, IN_TRANSIT), JSON.stringify(reply)?.slice(0, 160)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a refused number, a moved route, a block page and a broken reply apart', async () => {
    const lookup = (reply: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValueOnce(reply)).track({ number: UNKNOWN });
    await expect(lookup(json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(json(fixture('not-trackon')))).rejects.toMatchObject({ kind: 'invalid_input' });
    // The service answers a request without its parameters with HTTP 404.
    await expect(lookup(json({ Message: 'No HTTP resource was found that matches the request URI.' }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('', { status: 302, headers: { Location: 'https://www.trackon.in/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>Request Rejected</title><body>The requested URL was rejected.</body></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<html><title>Trackon</title></html>', { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(json('{"summaryTrack":'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind, status });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
    });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes a known consignment with its last scan and the not-found answer, and asks nothing for a number Trackon does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('delivered'))).mockResolvedValueOnce(json(fixture('not-found')))
      .mockResolvedValueOnce(json(fixture('not-trackon')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-14T10:48:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('10000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Trackon does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '1234567', '12345678', '100000001', '10000000001', '1000000000111', 'A00000000011', '100000000011,300000000022',
      '1000000000%', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTrackonNumber('1000-0000-0011')).toBe(DELIVERED);
    expect(normalizeTrackonNumber(' 1100 000 066 ')).toBe(OLDER);
  });

  it('ends a hanging lookup inside the caller’s budget', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('routes a number filed under Trackon to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: '1000 0000 0011', carrier: 'trackon' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'trackon', source: 'trackon', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === lookupUrl(DELIVERED))).toBe(true);
  });

  it('leaves AWB numbers to the caller: no rule claims ten or twelve digits', () => {
    for (const number of [DELIVERED, IN_TRANSIT, OLDER]) expect(detectCarrierMatch(number).carrier, number).not.toBe('trackon');
  });
});

describe('Trackon status vocabulary', () => {
  it('records every code and return wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      const wording = normalizeStatusWording(entry.wording);
      if (entry.code) {
        expect(statusMap.stage(entry.code, wording), entry.code).toBe(entry.stage);
        expect(trackonStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
      } else if (entry.stage) {
        expect(trackonStage('', entry.wording)?.stage, entry.wording).toBe(entry.stage);
      }
    }
    expect(statusMapAnswer({ carrier: 'trackon', providerCode: 'DRBG', description: 'DELIVERY MANIFEST PREPARED FOR SAMPLEPUR' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'trackon', providerCode: null, description: 'RTO DELIVERED TO CUSTOMER / BRANCH' }))
      .toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'trackon', providerCode: 'ZZZZ', description: 'SAMPLE NOTE' })).toEqual({ kind: 'unknown' });
  });
});
