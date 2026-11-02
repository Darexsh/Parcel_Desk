import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BJS_MINI_TRACK, BjsHomeDeliveryTracker, bjsLookupUrl } from './adapter.js';
import { normalizeBjsNumber, parseBjs, printedBjsNumber } from './parser.js';
import { bjsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

// Synthetic BJS consignment numbers, as detection and the adapter read them.
const DELIVERED = 'B00000000001';
const TRANSIT = 'B00000000002';
const UNKNOWN = 'B00000000000';
// Midday in the UK on the day of the synthetic lookups.
const NOW = Date.UTC(2026, 9, 18, 11);

type Row = Record<string, unknown>;
type Reply = Row & { result: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (rows: Row[], body: Reply) => void) => {
  const body = fixture(name);
  change(body.result, body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A block page a firewall in front of the API could serve with HTTP 200.
const BLOCK = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('BJS Home Delivery HTTP adapter', () => {
  it('asks the mini tracker\'s lookup for the printed number once, with the page\'s key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BjsHomeDeliveryTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' b0000000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'accepted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BJS_MINI_TRACK}?OrderReference=B0000000-0002`);
    expect(String(url)).toBe(bjsLookupUrl(TRANSIT));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', Key: expect.stringMatching(/^[0-9A-F]{29}$/), OrderReference: 'B0000000-0002', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bjs-home-delivery', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivered order\'s status with its day, as a summary', () => {
    expect(parseBjs(fixture('delivered'), DELIVERED, NOW)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-06-23', expected_delivery: null, summary_only: true,
      events: [{ local_time: '2026-06-23', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' }],
    });
  });

  it('reads only the row of the consignment asked among an order\'s consignments', () => {
    const result = parseBjs(fixture('in-transit'), TRANSIT, NOW);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Received',
      last_update_local: '2026-10-14', summary_only: true });
    expect(result.events).toEqual([{ local_time: '2026-10-14', description: 'Received', stage: 'accepted', stage_source: 'carrier_map' }]);
    // The order's other consignment is booked for a later day, which is no status's day.
    expect(parseBjs(fixture('in-transit'), 'B00000000003', NOW)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Scheduled',
      last_update: null, expected_delivery: null, summary_only: true, events: [],
    });
  });

  it('keeps a day up to today in the UK, and a status without a day', () => {
    const scheduled = (timestamp: unknown) => changed('delivered', (rows) => Object.assign(rows[0]!, { status: 'Scheduled', timestamp }));
    // 23:30 UTC on 23 June is already the 24th in the UK.
    const lateEvening = Date.UTC(2026, 5, 23, 23, 30);
    expect(parseBjs(scheduled('24/06/2026'), DELIVERED, lateEvening).events).toEqual([
      { local_time: '2026-06-24', description: 'Scheduled', stage: 'in_transit', stage_source: 'carrier_map' }]);
    expect(parseBjs(scheduled('25/06/2026'), DELIVERED, lateEvening).events).toEqual([]);
    for (const timestamp of ['', null, undefined]) {
      const result = parseBjs(scheduled(timestamp), DELIVERED, NOW);
      expect(result).toMatchObject({ current_stage: 'in_transit', events: [] });
      expect(result).not.toHaveProperty('last_update_local');
    }
  });

  it('leaves a status the map does not know to the shared wording rules', () => {
    const status = (wording: string) => parseBjs(changed('delivered', (rows) => { rows[0]!.status = wording; }), DELIVERED, NOW);
    expect(status('Sub-Contracted')).toMatchObject({ status: 'unknown', last_status_text: 'Sub-Contracted',
      events: [{ local_time: '2026-06-23', description: 'Sub-Contracted' }] });
    expect(status('Sub-Contracted')).not.toHaveProperty('current_stage');
    expect(status('Sub-Contracted').events![0]).not.toHaveProperty('stage');
    expect(status('Returned to retailer')).toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:returned' });
    expect(status('  en   ROUTE ')).toMatchObject({ status: 'out_for_delivery', last_status_text: 'en ROUTE' });
  });

  it('reads an unknown reference as not found, and another refusal as inconclusive', () => {
    expect(() => parseBjs(fixture('not-found'), UNKNOWN, NOW)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBjs({ message: 'Bad request. Something went wrong', result: {}, success: false }, UNKNOWN, NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBjs({ result: {}, success: false }, UNKNOWN, NOW)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts an order only when it is the whole consignment asked', () => {
    expect(() => parseBjs(fixture('delivered'), TRANSIT, NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'BJS answered for another consignment' }));
    expect(() => parseBjs(changed('delivered', (rows) => { rows[0]!.consignment = 'B0000000-00011'; }), DELIVERED, NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBjs(changed('delivered', (rows) => { rows[0]!.consignment = `B0000000-0001${' '.repeat(60)}9`; }), DELIVERED, NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBjs(changed('delivered', (rows) => { rows.length = 0; }), DELIVERED, NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'BJS returned no order' }));
    expect(() => parseBjs(changed('delivered', (rows) => { rows.push({ ...rows[0]!, status: 'Failed' }); }), DELIVERED, NOW))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'BJS returned several orders for the consignment' }));
    // The same row twice is one order; the number echoed back is not read.
    expect(parseBjs(changed('delivered', (rows) => { rows.push({ ...rows[0]!, tracking_number: 'b00000000001' }); }), DELIVERED, NOW).events)
      .toHaveLength(1);
    expect(parseBjs(changed('delivered', (rows) => { rows[0]!.consignment = 'b00000000001'; }), DELIVERED, NOW))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_rows: Row[], body: Reply) => { delete body.success; },
      (_rows: Row[], body: Reply) => { body.success = 'true'; },
      (_rows: Row[], body: Reply) => { body.result = {} as never; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 50 }, () => rows[0]!)); },
      (rows: Row[]) => { rows[0] = 'order' as never; },
      (rows: Row[]) => { delete rows[0]!.consignment; },
      (rows: Row[]) => { rows[0]!.consignment = 1; },
      (rows: Row[]) => { rows[0]!.status = ''; },
      (rows: Row[]) => { rows[0]!.status = ['Delivered']; },
      (rows: Row[]) => { rows[0]!.timestamp = '2026-06-23'; },
      (rows: Row[]) => { rows[0]!.timestamp = '23/06/2026 10:15'; },
      (rows: Row[]) => { rows[0]!.timestamp = '31/02/2026'; },
      (rows: Row[]) => { rows[0]!.timestamp = 1782172800; },
    ]) {
      expect(() => parseBjs(changed('delivered', change), DELIVERED, NOW)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBjs(null, DELIVERED, NOW)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown reference, a refused key, a moved route, a block page, a rate limit and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 400 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('refused-key'), { status: 401 })).rejects.toMatchObject({ kind: 'challenge', message: 'BJS refused the tracker\'s key' });
    // A found order comes with HTTP 200.
    await expect(lookup(fixture('delivered'), { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://track.bjshomedelivery.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(BLOCK, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(BLOCK, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
    await expect(lookup('<html><title>BJS</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>BJS</title></html>', { status: 400, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes any order of the consignment and an unknown reference, and asks nothing for a number BJS does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(changed('delivered', (rows) => { rows[0]!.status = 'Sub-Contracted'; })))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 400 }));
    // A UK calendar day cannot date the last activity.
    await expect(carrier(fetcher).recognize!('B0000000-0001')).resolves.toEqual({ known: true, lastActivityAt: null });
    // An order whose status the map does not know is still one BJS holds.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('B0000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('tries once more after a failure to reach BJS, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BjsHomeDeliveryTracker({ fetcher, recorder }).fetch(TRANSIT, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'accepted' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bjs-home-delivery', step: 'retry', outcome: 'ok' }));
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
    await clock.settle(expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects numbers BJS does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['B0000000000', 'B000000000001', 'C00000000001', 'BB0000000001', '000000000001', `B${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBjsNumber(' b0000000-0002 ')).toBe(TRANSIT);
    expect(printedBjsNumber(TRANSIT)).toBe('B0000000-0002');
  });

  it('routes a number filed under BJS, or one BJS recognizes, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(BJS_MINI_TRACK)
      ? reply(fixture('delivered')) : new Response('', { status: 404 })));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'bjs-home-delivery' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'bjs-home-delivery', source: 'bjs-home-delivery', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: 'B0000000-0001' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'bjs-home-delivery', source: 'bjs-home-delivery' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === bjsLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('BJS Home Delivery numbers', () => {
  it('suggests BJS for B and eleven digits, beside Colis Privé\'s generic rule', () => {
    for (const number of [DELIVERED, 'B0000000-0001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toEqual(expect.arrayContaining(['bjs-home-delivery', 'colis-prive']));
    }
    expect(detectCarrierMatch('B0000000000').candidates ?? []).not.toContain('bjs-home-delivery');
  });
});

describe('BJS Home Delivery status vocabulary', () => {
  it('records every status the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(bjsStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'bjs-home-delivery', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('X', 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'bjs-home-delivery', providerCode: null, description: 'Sub-Contracted' })).toEqual({ kind: 'unknown' });
    expect(bjsStage('Sub-Contracted')).toBeNull();
  });
});
