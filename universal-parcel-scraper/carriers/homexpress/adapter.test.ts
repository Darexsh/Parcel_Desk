import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HOMEXPRESS_TRACE, HomexpressTracker, homexpressTraceUrl } from './adapter.js';
import { SECTIGO_DV_R36 } from './certificate.js';
import { normalizeHomexpressNumber, parseHomexpressTrace } from './parser.js';
import { homexpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'TMS00000000001';
const IN_TRANSIT = 'TMS00000000002';
const UNKNOWN = 'TMS00000000000';

const trusting = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('../../core/transport/https.js', () => ({ fetchTrusting: vi.fn(() => trusting) }));

type Row = Record<string, unknown>;
type Trace = Row & { data: Row & { orderRoutes: Row[] } };

const trace = (name: string, change: (routes: Row[], body: Trace) => void = () => undefined) => {
  const body = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Trace;
  change(body.data?.orderRoutes ?? [], body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const answering = (body: unknown) => vi.fn<typeof fetch>(async () => reply(body));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const status = (code: number, body = '', headers: Record<string, string> = {}) =>
  vi.fn<typeof fetch>(async () => new Response(body, { status: code, headers }));

describe('HOMEXPRESS HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = answering(trace('trace-in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HomexpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' tms 0000-0000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'accepted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${HOMEXPRESS_TRACE}?orderNo=${IN_TRANSIT}`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'homexpress', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(homexpressTraceUrl('A&B')).toBe(`${HOMEXPRESS_TRACE}?orderNo=A%26B`);
  });

  it('reads the tracker over the global fetch trusting the intermediate it leaves out, and a host’s own fetcher as given', async () => {
    trusting.mockImplementation(async () => reply(trace('trace-delivered')));
    await expect(new HomexpressTracker().fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    await expect(createTracker({ providers: [], env: {} }).track({ number: DELIVERED, carrier: 'homexpress' }))
      .resolves.toMatchObject({ source: 'homexpress' });
    expect(trusting).toHaveBeenCalledTimes(2);
    expect(fetchTrusting).toHaveBeenCalledWith([SECTIGO_DV_R36]);
    const own = answering(trace('trace-delivered'));
    await expect(createTracker({ fetcher: own, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'homexpress' }))
      .resolves.toMatchObject({ source: 'homexpress' });
    expect(own).toHaveBeenCalledTimes(1);
    expect(trusting).toHaveBeenCalledTimes(2);
  });

  it('reads a delivered history with its instants, codes and suburbs, without the driver, photos or coordinates', async () => {
    const result = await carrier(answering(trace('trace-delivered'))).track({ number: DELIVERED });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your parcel has been delivered.', last_update: '2026-10-14T14:40:12+11:00', expected_delivery: null });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-10-14T14:40:12+11:00', 'sign_image', 'delivered', 'SAMPLE HILL, NSW'],
      ['2026-10-14T14:38:50+11:00', 'sign_in', 'delivered', 'SAMPLE HILL, NSW'],
      ['2026-10-14T08:05:31+11:00', 'out_warehorse_2', 'out_for_delivery', 'Sampleton, NSW'],
      ['2026-10-14T02:12:09+11:00', 'collect_order', 'accepted', 'Sampleton, NSW'],
      ['2026-10-13T22:30:44+11:00', 'create_order', 'registered', 'Sampleton, NSW'],
    ]);
    expect(result.events![2]!.description).toBe('Parcel has left warehouse SYDDC-1. Our driver will deliver your parcel to you.');
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample Driver|0000"|SAMPLE0|signPhoto|151\.0|-33\.0|SAMPLECH/);
  });

  it('keeps each scan’s own offset and orders the scans by instant', () => {
    const result = parseHomexpressTrace(trace('trace-in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_update: '2026-10-15T15:20:05+08:00' });
    expect(result.events!.map((event) => event.time)).toEqual(['2026-10-15T15:20:05+08:00', '2026-10-15T09:02:17+08:00']);
    // Listed oldest first, turned round; an instant without an offset stays in UTC and a scan
    // without a city keeps the place the reply names.
    const plain = parseHomexpressTrace(trace('trace-in-transit', (routes) => {
      routes.reverse();
      routes[1]!.timeZone = null;
      routes[1]!.operatorTime = null;
      routes[1]!.eventCity = null;
      routes[1]!.occurLocation = 'Sample Depot';
    }), IN_TRANSIT);
    expect(plain.events!.map((event) => [event.time, event.location])).toEqual([
      ['2026-10-15T07:20:05Z', 'Sample Depot'],
      ['2026-10-15T09:02:17+08:00', 'Sampleville, WA'],
    ]);
  });

  it('reads the tracker’s unknown-number answer as not found, and a reply without scans as no history', async () => {
    await expect(carrier(answering(trace('trace-not-found'))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseHomexpressTrace(trace('trace-not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const routes of [[], null]) {
      expect(() => parseHomexpressTrace(trace('trace-in-transit', (_routes, body) => { body.data.orderRoutes = routes as never; }), IN_TRANSIT))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('keeps refusals, rate limits, failures and moved routes apart from a missing parcel', async () => {
    const track = (fetcher: typeof fetch) => carrier(fetcher).track({ number: UNKNOWN });
    await expect(track(status(403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(status(429, '', { 'Retry-After': '30' }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(track(status(500))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(track(status(503))).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(track(status(404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(track(status(302, '', { Location: 'https://www.homexpress.com.au/' }))).rejects.toMatchObject({ kind: 'transport' });
    // A bot check or another page in place of the reply, even with HTTP 200.
    await expect(track(answering('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(answering('<html><title>HOMEXPRESS</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    // The tracker's own failure code.
    await expect(track(answering({ code: 500, message: 'Sample failure', data: null }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('counts a reply only when every scan names the number asked', async () => {
    await expect(carrier(answering(trace('trace-in-transit'))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'HOMEXPRESS answered for another shipment' });
    expect(() => parseHomexpressTrace(trace('trace-delivered', (routes) => { routes[3]!.orderNo = `${DELIVERED}1`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseHomexpressTrace(trace('trace-delivered', (routes) => { routes[0]!.orderNo = DELIVERED.toLowerCase(); }), DELIVERED).events)
      .toHaveLength(5);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_routes: Row[], body: Row) => { delete body.code; },
      (_routes: Row[], body: Row) => { body.code = '200'; },
      (_routes: Row[], body: Row) => { body.data = null; },
      (_routes: Row[], body: Row & { data: Row }) => { body.data.orderRoutes = 'routes'; },
      (routes: Row[]) => { routes.push(...Array.from({ length: 500 }, () => routes[0]!)); },
      (routes: Row[]) => { routes[0] = 'scan' as never; },
      (routes: Row[]) => { delete routes[0]!.orderNo; },
      (routes: Row[]) => { routes[0]!.utcOperatorTime = '2026-10-15T07:20:05Z'; },
      (routes: Row[]) => { routes[0]!.utcOperatorTime = '2026-02-30 07:20:05'; },
      (routes: Row[]) => { routes[0]!.timeZone = 'Australia/Perth'; },
      (routes: Row[]) => { routes[0]!.timeZone = 'UTC+15:00'; },
      (routes: Row[]) => { routes[0]!.operatorTime = '2026-10-15 16:20:05'; },
      (routes: Row[]) => { routes[0]!.routingDescription = null; },
      (routes: Row[]) => { routes[0]!.eventCity = 7; },
    ]) {
      expect(() => parseHomexpressTrace(trace('trace-in-transit', change as never), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects what is not four to forty letters and digits, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TMS', `TMS${'0'.repeat(38)}`, 'TMS00000000001,TMS00000000002', 'TMS/000000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeHomexpressNumber('tms 000.0000-0001')).toBe(DELIVERED);
    expect(normalizeHomexpressNumber('SAMPLE')).toBe('SAMPLE');
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
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    let calls = 0;
    const flaky = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return reply(trace('trace-delivered'));
    });
    await clock.settle(expect(carrier(flaky).track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' }));
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under HOMEXPRESS to the adapter', async () => {
    const fetcher = answering(trace('trace-delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'homexpress' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'homexpress', source: 'homexpress', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(HOMEXPRESS_TRACE))).toBe(true);
  });
});

describe('HOMEXPRESS numbers', () => {
  it('leaves numbers to the carrier the user names', () => {
    for (const number of [DELIVERED, UNKNOWN]) expect(detectCarrierMatch(number).carrier, number).not.toBe('homexpress');
  });
});

describe('HOMEXPRESS status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(homexpressStage(entry.code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'homexpress', providerCode: 'sign_in', description: 'Synthetic wording' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'homexpress', providerCode: 'zz_sample', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(homexpressStage('zz_sample', 'Your parcel was returned to the sender')).toMatchObject({ source: expect.stringMatching(/^wording:/) });
    expect(homexpressStage('zz_sample', 'Synthetic note')).toBeNull();
    expect(homexpressStage('SIGN_IN', 'Synthetic note')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
