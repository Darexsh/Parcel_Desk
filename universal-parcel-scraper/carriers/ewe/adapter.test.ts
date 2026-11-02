import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EWE_LOOKUP, EWE_TRACE, eweLookupUrl, EweTracker, eweTraceUrl } from './adapter.js';
import { eweWording, normalizeEweNumber, parseEweLookup, parseEweTrace } from './parser.js';
import { eweStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'AMZ0000000001';
const IN_TRANSIT = 'AMZ0000000002';
const EMETRO = 'EMC00000000001';
const UNKNOWN = 'AMZ0000000000';

type Row = Record<string, unknown>;
type Trace = Row & { data: Row & { orderRoutes: Row[] } };
type Lookup = Row & { Payload: (Row & { Details: Row[] })[] };

const fixture = <T = Row>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const trace = (name: string, change: (routes: Row[], body: Trace) => void = () => undefined) => {
  const body = fixture<Trace>(name);
  change(body.data?.orderRoutes ?? [], body);
  return body;
};
const lookup = (name: string, change: (entry: Lookup['Payload'][number], body: Lookup) => void = () => undefined) => {
  const body = fixture<Lookup>(name);
  change(body.Payload[0]!, body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
type Answer = Row | string | (() => Response | Promise<Response>);
const answer = (value: Answer) => (typeof value === 'function' ? value() : reply(value));
/** A transport that gives the trace tracker and the tracking page's lookup their own replies. */
const routed = (traced: Answer, looked: Answer) =>
  vi.fn<typeof fetch>(async (input) => answer(String(input).startsWith(EWE_TRACE) ? traced : looked));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const status = (code: number, body = '', headers: Record<string, string> = {}) => () => new Response(body, { status: code, headers });

describe('EWE HTTP adapter', () => {
  it('asks both trackers for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = routed(trace('trace-in-transit'), lookup('lookup-not-found'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EweTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' amz 0000-000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'accepted' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort())
      .toEqual([`${EWE_TRACE}?orderNo=${IN_TRANSIT}`, `${EWE_LOOKUP}${IN_TRANSIT}`]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ewe', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(eweLookupUrl('A/B')).toBe(`${EWE_LOOKUP}A%2FB`);
    expect(eweTraceUrl('A&B')).toBe(`${EWE_TRACE}?orderNo=A%26B`);
  });

  it('takes the trace tracker’s scans with their instants, codes and suburbs, and stops the other lookup', async () => {
    let lookupSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>((input, init) => String(input).startsWith(EWE_TRACE)
      ? Promise.resolve(reply(trace('trace-delivered')))
      : new Promise((_resolve, reject) => {
        lookupSignal = init?.signal ?? undefined;
        lookupSignal?.addEventListener('abort', () => reject(lookupSignal?.reason), { once: true });
      }));
    const result = await carrier(fetcher).track({ number: DELIVERED });
    expect(lookupSignal?.aborted).toBe(true);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your parcel has been delivered.', last_update: '2026-08-11T13:40:12+10:00', expected_delivery: null });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-08-11T13:40:12+10:00', 'sign_image', 'delivered', 'SAMPLE HILL, QLD'],
      ['2026-08-11T13:38:50+10:00', 'sign_in', 'delivered', 'SAMPLE HILL, QLD'],
      ['2026-08-11T08:05:31+10:00', 'out_warehorse_2', 'out_for_delivery', 'Sampleton, QLD'],
      ['2026-08-11T02:12:09+10:00', 'collect_order', 'accepted', 'Sampleton, QLD'],
      ['2026-08-10T22:30:44+10:00', 'create_order', 'registered', 'Sampleton, QLD'],
    ]);
    expect(result.events![2]!.description).toBe('Parcel has left warehouse BNEDC-1. Our driver will deliver your parcel to you.');
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample Driver|0000"|SAMPLE0|signPhoto|153\.0|-27\.0|EWEBAM/);
  });

  it('keeps each trace scan’s own offset', () => {
    const result = parseEweTrace(trace('trace-in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_update: '2026-10-13T02:20:05+11:00' });
    expect(result.events!.map((event) => event.time)).toEqual(['2026-10-13T02:20:05+11:00', '2026-10-12T20:02:17+11:00']);
    // An instant without an offset stays in UTC; a scan without a city keeps the place the reply names.
    const plain = parseEweTrace(trace('trace-in-transit', (routes) => {
      routes[0]!.timeZone = null;
      routes[0]!.operatorTime = null;
      routes[0]!.eventCity = null;
      routes[0]!.occurLocation = 'Sample Depot';
    }), IN_TRANSIT);
    expect(plain.events![0]).toMatchObject({ time: '2026-10-12T15:20:05Z', location: 'Sample Depot' });
  });

  it('reads an eMetro consignment from the tracking page’s lookup when the trace tracker does not know it', async () => {
    const fetcher = routed(trace('trace-not-found'), lookup('lookup-delivered'));
    const result = await carrier(fetcher).track({ number: EMETRO });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Fully Complete', last_update: null, last_update_local: '2026-09-04T00:12:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null, event.location])).toEqual([
      // eMetro closes the consignment after its delivery; that moves nothing.
      ['2026-09-04T00:12:00', null, 'Australia'],
      ['2026-09-03T15:47:00', 'delivered', 'Australia'],
      ['2026-09-03T11:05:00', 'out_for_delivery', 'Australia'],
      ['2026-09-03T10:31:00', 'in_transit', 'Australia'],
      ['2026-09-02T18:20:00', 'in_transit', 'Australia'],
      ['2026-09-01T14:02:00', 'in_transit', 'Sydney NSW Australia'],
      ['2026-09-01T12:44:00', 'accepted', 'Sydney NSW Australia'],
    ]);
    expect(result.events![5]!.description).toBe('Pick-up by eMetro.');
    expect(result.events!.every((event) => event.time === undefined && event.provider_code === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sampleton|SAMPLE PARK|EMA0|0000"/);
  });

  it('falls back to the scans the tracking page’s lookup relays when the trace tracker fails', async () => {
    for (const traced of [status(500), status(403), 'not json', trace('trace-delivered', (routes) => { routes[0]!.orderNo = IN_TRANSIT; }),
      trace('trace-delivered', (routes) => { routes[0]!.operatorTime = '2026-08-11 14:40:12'; })]) {
      const result = await carrier(routed(traced, lookup('lookup-relayed'))).track({ number: DELIVERED });
      expect(result).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map',
        last_status_text: 'Your parcel has been delivered.', last_update: null, last_update_local: '2026-08-11T13:40:00' });
      // Listed oldest first, turned round; the warehouse's name stays, the driver's goes.
      expect(result.events!.map((event) => [event.local_time, event.stage, event.description])).toEqual([
        ['2026-08-11T13:40:00', 'delivered', 'Your parcel has been delivered.'],
        ['2026-08-11T13:38:00', 'delivered', 'The parcel has been delivered. If not, please contact amazon.delivery@ewe.com.au and we will deal with it as soon as possible.'],
        ['2026-08-11T08:05:00', 'out_for_delivery', 'Parcel has left warehouse BNEDC-1. Our driver will deliver your parcel to you.'],
        ['2026-08-11T02:12:00', 'accepted', 'Parcel arrived at warehouse BNEDC-1.'],
        ['2026-08-10T22:30:00', 'registered', 'Order created by BNE1 to be collected'],
      ]);
      expect(result.events!.every((event) => event.location === undefined)).toBe(true);
    }
  });

  it('keeps scans of one clock in the order of a reply listed oldest first', () => {
    const result = parseEweLookup(lookup('lookup-relayed', (entry) => {
      entry.Details.splice(2, 0, { DateString: '2026-08-11 02:12', Place: '', Message: 'Parcel sorted at warehouse BNEDC-1.', PositionCode: 4 });
    }), DELIVERED);
    expect(result.events!.slice(2, 5).map((event) => event.description)).toEqual(['Parcel has left warehouse BNEDC-1. Our driver will deliver your parcel to you.',
      'Parcel sorted at warehouse BNEDC-1.', 'Parcel arrived at warehouse BNEDC-1.']);
  });

  it('reads the tracking page’s answer for an unknown number as not found, whatever the trace tracker says', async () => {
    for (const traced of [trace('trace-not-found'), status(500), status(429), 'not json']) {
      await expect(carrier(routed(traced, lookup('lookup-not-found'))).track({ number: UNKNOWN }))
        .rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(() => parseEweLookup(lookup('lookup-not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEweTrace(trace('trace-not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A consignment without scans that the reply does not call unknown.
    expect(() => parseEweLookup(lookup('lookup-not-found', (entry) => { entry.Status = 'Booked'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseEweLookup(lookup('lookup-not-found', (entry) => { entry.Details = null as never; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEweTrace(trace('trace-in-transit', (_routes, body) => { body.data.orderRoutes = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('keeps the tracking page lookup’s failure when the trace tracker does not know the number', async () => {
    const lookupFails = (looked: Answer) => carrier(routed(trace('trace-not-found'), looked)).track({ number: UNKNOWN });
    await expect(lookupFails(status(403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookupFails(status(429, '', { 'Retry-After': '30' }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookupFails(status(500))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookupFails(status(503))).rejects.toMatchObject({ kind: 'maintenance' });
    // A missing route or a redirect is a moved lookup, not a missing parcel.
    await expect(lookupFails(status(404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookupFails(status(302, '', { Location: 'https://www.ewe.com.au/' }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookupFails(() => new Response('<html><script src="https://sample.awswaf.com/challenge.js"></script></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookupFails(() => new Response('<html><title>EWE</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookupFails({ Payload: [], Total: 0, Status: 0, Message: '', Error: '' })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookupFails(lookup('lookup-not-found', (_entry, body) => { body.Error = 'Sample failure'; })))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    // The trace tracker's own failure code.
    expect(() => parseEweTrace({ code: 500, message: 'Sample failure', data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a consignment only when it is the number asked or lists it among its articles', () => {
    expect(() => parseEweLookup(lookup('lookup-delivered'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'EWE answered for another shipment' }));
    expect(parseEweLookup(lookup('lookup-delivered'), 'EMA0000000002')).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseEweLookup(lookup('lookup-delivered'), 'EMA000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseEweLookup(lookup('lookup-delivered', (entry) => { entry.ConsignmentNo = EMETRO.toLowerCase(); }), EMETRO).events).toHaveLength(7);
    expect(() => parseEweTrace(trace('trace-in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'EWE answered for another shipment' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_entry: Row, body: Row) => { delete body.Payload; },
      (_entry: Row, body: Row) => { body.Payload = ['consignment']; },
      (entry: Row) => { delete entry.ConsignmentNo; },
      (entry: Row) => { entry.Details = 'scans'; },
      (entry: Row & { Details: Row[] }) => { entry.Details = Array.from({ length: 501 }, () => entry.Details[0]!); },
      (entry: Row & { Details: Row[] }) => { entry.Details[0] = 'scan' as never; },
      (entry: Row & { Details: Row[] }) => { entry.Details[0]!.DateString = '04/09/2026 00:12'; },
      (entry: Row & { Details: Row[] }) => { entry.Details[0]!.DateString = '2026-02-30 00:12'; },
      (entry: Row & { Details: Row[] }) => { entry.Details[0]!.DateString = '2026-09-04 24:00'; },
      (entry: Row & { Details: Row[] }) => { entry.Details[0]!.Message = ['Delivered']; },
      (entry: Row & { Details: Row[] }) => { entry.Details[0]!.Message = ' '; },
    ]) {
      expect(() => parseEweLookup(lookup('lookup-delivered', change as never), EMETRO)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (_routes: Row[], body: Row) => { delete body.code; },
      (_routes: Row[], body: Row) => { body.data = null; },
      (_routes: Row[], body: Row & { data: Row }) => { body.data.orderRoutes = 'routes'; },
      (routes: Row[]) => { routes[0] = 'scan' as never; },
      (routes: Row[]) => { delete routes[0]!.orderNo; },
      (routes: Row[]) => { routes[0]!.utcOperatorTime = '2026-10-12T15:20:05Z'; },
      (routes: Row[]) => { routes[0]!.utcOperatorTime = '2026-02-30 15:20:05'; },
      (routes: Row[]) => { routes[0]!.timeZone = 'Australia/Melbourne'; },
      (routes: Row[]) => { routes[0]!.timeZone = 'UTC+15:00'; },
      (routes: Row[]) => { routes[0]!.operatorTime = '2026-10-13 01:20:05'; },
      (routes: Row[]) => { routes[0]!.routingDescription = null; },
      (routes: Row[]) => { routes[0]!.eventCity = 7; },
    ]) {
      expect(() => parseEweTrace(trace('trace-in-transit', change as never), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes drivers’ names and phone numbers out of the wording', () => {
    expect(eweWording('Parcel has left warehouse SYDDC-1. Our driver Sample will deliver your parcel to you.'))
      .toBe('Parcel has left warehouse SYDDC-1. Our driver will deliver your parcel to you.');
    expect(eweWording('Delivered by driver Sample Person.')).toBe('Delivered by driver.');
    expect(eweWording('Our driver will deliver your parcel to you.')).toBe('Our driver will deliver your parcel to you.');
    expect(eweWording('Please call 0000 000 000 or +00 0 0000 0000.')).toBe('Please call or.');
    expect(eweWording('Parcel arrived at warehouse BNEDC-1. ')).toBe('Parcel arrived at warehouse BNEDC-1.');
  });

  it('rejects numbers EWE does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['AMZ0000', 'SAMPLETRACKING', `AMZ${'0'.repeat(28)}`, 'AMZ0000000001,AMZ0000000002']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEweNumber('emc 0000 000 0001')).toBe(EMETRO);
  });

  it('ends hanging reads inside the budget and tries once more after a network failure', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(hanging).track({ number: DELIVERED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    let calls = 0;
    const flaky = vi.fn<typeof fetch>(async (input) => {
      calls += 1;
      if (calls <= 2) throw new TypeError('fetch failed');
      return reply(String(input).startsWith(EWE_TRACE) ? trace('trace-not-found') : lookup('lookup-delivered'));
    });
    await clock.settle(expect(carrier(flaky).track({ number: EMETRO }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' }));
    expect(flaky).toHaveBeenCalledTimes(4);
  });

  it('routes a number filed under EWE to the adapter', async () => {
    const fetcher = routed(trace('trace-delivered'), lookup('lookup-relayed'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'ewe' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ewe', source: 'ewe', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(EWE_TRACE))).toBe(true);
  });
});

describe('EWE numbers', () => {
  it('leaves its layouts to the carrier the user names', () => {
    for (const number of [DELIVERED, EMETRO, 'E000000000E']) expect(detectCarrierMatch(number).carrier, number).not.toBe('ewe');
  });
});

describe('EWE status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? '';
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(eweStage(code, entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'ewe', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(eweStage(code, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      // The tracking page's lookup relays the delivery system's wording without its code.
      if (entry.code) expect(eweStage('', eweWording(entry.wording))?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'ewe', providerCode: 'sign_in', description: 'Synthetic wording' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'ewe', providerCode: 'zz_sample', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code or wording the map does not know falls to the shared wording rules.
    expect(eweStage('zz_sample', 'Your parcel was returned to the sender')).toMatchObject({ source: expect.stringMatching(/^wording:/) });
    expect(eweStage('', 'Synthetic note')).toBeNull();
    expect(eweStage('SIGN_IN', 'Synthetic note')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
