import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, VALMO_API, ValmoTracker } from './adapter.js';
import { normalizeValmoNumber, parseValmo } from './parser.js';
import { statusMap, valmoStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'VL0000000000001';
const IN_TRANSIT = 'VL0000000000002';
const RETURNED = 'VL0000000000003';
const UNKNOWN = 'VL0000000000000';

type Row = Record<string, unknown>;
type Step = Row & { sub_status_list: Row[] };
type Reply = Row & { tracking: Step[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Valmo HTTP adapter', () => {
  it('asks the track page’s lookup for the whole tracking ID in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ValmoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' vl 0000-0000-00002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    const sent = new URL(String(url));
    expect(`${sent.origin}${sent.pathname}`).toBe(VALMO_API);
    expect([...sent.searchParams.keys()]).toEqual(['request_id', 'tracking_id']);
    expect(sent.searchParams.get('request_id')).toMatch(/^\d{13}$/);
    expect(sent.searchParams.get('tracking_id')).toBe(IN_TRANSIT);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'valmo', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads every step and hub scan as an instant in India, newest first, without the repeated scan', () => {
    const result = parseValmo(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-09T13:47:50+05:30', delivered_at: '2026-05-09T13:47:50+05:30',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-05-09T13:47:50+05:30', 'ORDER_DELIVERED', 'delivered', null],
      ['2026-05-09T10:05:27+05:30', 'ORDER_OUT_FOR_DELIVERY', 'out_for_delivery', null],
      ['2026-05-08T18:12:03+05:30', 'ORDER_DELIVERY_ATTEMPT_FAILED', 'failed_attempt', null],
      ['2026-05-08T09:30:44+05:30', 'ORDER_OUT_FOR_DELIVERY', 'out_for_delivery', null],
      ['2026-05-07T14:02:18+05:30', 'ORDER_REACHED_HUB', 'in_transit', 'Demopur city'],
      ['2026-05-07T06:20:31+05:30', 'ORDER_LEFT_HUB', 'in_transit', 'Example west'],
      ['2026-05-06T23:10:55+05:30', 'ORDER_REACHED_HUB', 'in_transit', 'Example west'],
      ['2026-05-05T19:44:09+05:30', 'ORDER_LEFT_HUB', 'in_transit', 'Sampleton'],
      ['2026-05-05T18:05:12+05:30', 'ORDER_REACHED_HUB', 'in_transit', 'Sampleton'],
      ['2026-05-05T16:30:00+05:30', 'ORDER_SHIPPED', 'accepted', null],
      ['2026-05-05T08:12:30+05:30', 'ORDER_READY_FOR_PICKUP', 'registered', null],
      // An order confirmed again is kept at each time.
      ['2026-05-04T21:40:05+05:30', 'ORDER_CONFIRMED', 'registered', null],
      ['2026-05-04T10:02:41+05:30', 'ORDER_READY_FOR_PICKUP', 'registered', null],
      // The milliseconds go.
      ['2026-05-04T09:15:20+05:30', 'ORDER_CONFIRMED', 'registered', null],
    ]);
    expect(result.events![6]).toMatchObject({ description: 'Reached Example west hub', stage_source: 'carrier_map' });
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
  });

  it('skips the steps not reached yet', () => {
    const result = parseValmo(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Reached Demopur city hub',
      last_update: '2026-06-12T07:55:41+05:30' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.provider_code)).toEqual(['ORDER_REACHED_HUB', 'ORDER_LEFT_HUB', 'ORDER_REACHED_HUB',
      'ORDER_SHIPPED', 'ORDER_READY_FOR_PICKUP', 'ORDER_CONFIRMED']);
  });

  it('follows a failed delivery back to the seller, past a summary that still shows the failure', () => {
    const result = parseValmo(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned to Seller',
      last_update: '2026-03-13T19:21:02+05:30' });
    expect(result.events!.slice(0, 2).map((event) => [event.provider_code, event.stage, event.time])).toEqual([
      ['ORDER_RETURNED_TO_SELLER', 'returned', '2026-03-13T19:21:02+05:30'],
      ['ORDER_DELIVERY_FAILED', 'exception', '2026-03-07T23:22:05+05:30'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('orders scans by their instants, and two on one second as listed', () => {
    const result = parseValmo(changed('in-transit', (body) => {
      body.tracking[1]!.sub_status_list[2]!.date = body.tracking[1]!.sub_status_list[1]!.date;
      body.tracking.reverse();
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 2).map((event) => [event.provider_code, event.time])).toEqual([
      ['ORDER_REACHED_HUB', '2026-06-11T04:30:12+05:30'],
      ['ORDER_LEFT_HUB', '2026-06-11T04:30:12+05:30'],
    ]);
  });

  it('stages a step it does not know by its wording, and leaves one no rule reads without a stage', () => {
    const result = parseValmo(changed('in-transit', (body) => {
      body.tracking.push({ status: 'ORDER_SYNTHETIC', date: Date.parse('2026-06-12T09:00:00+05:30'), movement_type: 'forward',
        display_name: 'Synthetic note', is_complete: true, is_current: true, sub_status_list: [] });
    }), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ provider_code: 'ORDER_SYNTHETIC', description: 'Synthetic note' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note' });
  });

  it('reads the tracker’s unknown-ID answer as not found, another refusal as inconclusive and a parcel without scans as no history', () => {
    expect(() => parseValmo(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseValmo({ ...fixture('not-found'), remarks: 'Something Went Wrong' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseValmo(changed('delivered', (body) => { body.tracking = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseValmo(changed('delivered', (body) => { delete (body as Row).tracking; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a reply only when it names the tracking ID asked', () => {
    expect(() => parseValmo(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Valmo answered for another tracking ID' }));
    expect(() => parseValmo(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).success; },
      (body: Reply) => { delete (body as Row).tracking_id; },
      (body: Reply) => { body.tracking = 'steps' as never; },
      (body: Reply) => { body.tracking = Array.from({ length: 101 }, () => body.tracking[0]!); },
      (body: Reply) => { body.tracking[1]!.sub_status_list = Array.from({ length: 501 }, () => body.tracking[1]!.sub_status_list[0]!); },
      (body: Reply) => { body.tracking[0] = 'step' as never; },
      (body: Reply) => { body.tracking[1]!.sub_status_list = 'scans' as never; },
      (body: Reply) => { body.tracking[1]!.sub_status_list[0] = 'scan' as never; },
      (body: Reply) => { body.tracking[0]!.date = '2026-06-10'; },
      (body: Reply) => { body.tracking[0]!.date = 1780000000; },
      (body: Reply) => { body.tracking[0]!.date = null; },
      (body: Reply) => { delete body.tracking[1]!.sub_status_list[0]!.date; },
      (body: Reply) => { body.tracking[0]!.status = ''; },
      (body: Reply) => { body.tracking[0]!.display_name = ['Order Confirmed']; },
    ]) {
      expect(() => parseValmo(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown ID, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers an unknown ID with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.valmo.in/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><head><title>Access Denied</title></head><body>Reference #0.0</body></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Valmo</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    // The service's answer to a request without its request ID.
    await expect(lookup({ status: 400, data: { error: 'Bad Request' }, message: 'Request failed with status code 400' }, { status: 400 }))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects IDs Valmo does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['VL000000000000', 'VL00000000000000', 'VX0000000000001', '0000000000001', `VL${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeValmoNumber('vl 0000.0000.00001')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
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

  it('routes an ID filed under Valmo, or detected as one of its IDs, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'valmo' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'valmo', source: 'valmo', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'valmo', source: 'valmo' });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${VALMO_API}?`))).toBe(true);
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'valmo', confidence: 'high' });
  });
});

describe('Valmo status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording?: string; stage: string }[]) {
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, (entry.wording ?? '').toLowerCase()), entry.code).toBe(entry.stage);
      expect(valmoStage(entry.code, entry.wording ?? '')?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'valmo', providerCode: 'ORDER_DELIVERY_FAILED', description: 'Delivery Failed' }))
      .toEqual({ kind: 'mapped', stage: 'exception' });
    expect(statusMapAnswer({ carrier: 'valmo', providerCode: 'ORDER_SYNTHETIC', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(valmoStage('ORDER_SYNTHETIC', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(valmoStage('order_delivered', 'Delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
