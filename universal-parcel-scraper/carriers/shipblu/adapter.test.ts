import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SHIPBLU_API, ShipbluTracker } from './adapter.js';
import { normalizeShipbluNumber, parseShipblu, shipbluOrderType } from './parser.js';
import { shipbluStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1234560890124';
const IN_TRANSIT = '3100000000000';
const RETURN = '2123456789012';
const UNKNOWN = '1000000000000';

type Row = Record<string, unknown>;
type Reply = Row & { tracking_events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ShipBlu HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in English once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ShipbluTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1234 5608 90124 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SHIPBLU_API}delivery-order/${DELIVERED}/?pin=`);
    expect(String(url)).toBe('https://api.shipblu.com/api/v1/delivery-order/1234560890124/?pin=');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shipblu', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('looks each number up in the list the page routes it to', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('not-found'), { status: 404 }));
    for (const number of [DELIVERED, IN_TRANSIT, RETURN, '3200000000000']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'not_found' });
    }
    expect(fetcher.mock.calls.map(([url]) => String(url).slice(SHIPBLU_API.length))).toEqual([
      `delivery-order/${DELIVERED}/?pin=`, `delivery-order/${IN_TRANSIT}/?pin=`, `return/${RETURN}/?pin=`, 'return/3200000000000/?pin=',
    ]);
    expect([DELIVERED, IN_TRANSIT, RETURN, '3200000000000'].map(shipbluOrderType)).toEqual(['delivery-order', 'delivery-order', 'return', 'return']);
  });

  it('reads a delivered history newest first at the reply’s instants and stages each scan by its status', () => {
    const result = parseShipblu(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-12T16:32:19.270+03:00', expected_delivery: null,
      delivered_at: '2026-05-12T13:32:19.270Z' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-05-12T16:32:19.270+03:00', 'delivered', 'delivered'],
      ['2026-05-12T09:15:30+03:00', 'out_for_delivery', 'out_for_delivery'],
      // The repeated warehouse scan is kept once.
      ['2026-05-11T20:02:41.500+03:00', 'in_transit', 'in_transit'],
      ['2026-05-11T15:10:00+03:00', 'delivery_attempted', 'failed_attempt'],
      ['2026-05-11T09:44:56.798+03:00', 'out_for_delivery', 'out_for_delivery'],
      ['2026-05-11T01:35:00.147+03:00', 'in_transit', 'in_transit'],
      ['2026-05-10T18:20:43.895+03:00', 'en_route', 'in_transit'],
      ['2026-05-10T15:33:13.746+03:00', 'in_transit', 'in_transit'],
      ['2026-05-10T14:05:07.827+03:00', 'picked_up', 'accepted'],
      ['2026-05-10T12:26:05.216+03:00', 'out_for_pickup', 'registered'],
      ['2026-05-09T11:00:04.064+03:00', 'pickup_requested', 'registered'],
      ['2026-05-09T11:00:01.990+03:00', 'created', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.location === undefined
      && event.local_time === undefined)).toBe(true);
    expect(result.events!.map((event) => event.description)).toContain('En route');
    // A missed visit keeps the courier's reason without the phone number; other comments are not read.
    expect(result.events![3]!.description).toBe('Delivery attempted: Customer not answering, call');
    expect(result.events![0]!.description).toBe('Delivered');
    expect(JSON.stringify(result)).not.toMatch(/Synthetic Shop|Sample|Recipient|Example|0100|EX-L1|100\.0/);
    expect(result).not.toHaveProperty('summary_only');
    // The delivery's own scan dates it when the reply leaves the field out.
    expect(parseShipblu(changed('delivered', (body) => { body.delivered_date = null; }), DELIVERED).delivered_at)
      .toBe('2026-05-12T16:32:19.270+03:00');
  });

  it('keeps a delivery order filed under 31 in transit after a missed visit, with the day the customer chose, in winter time', () => {
    const result = parseShipblu(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'En route', last_update: '2026-01-20T22:40:00+02:00', expected_delivery: '2026-01-22' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.provider_code)).toEqual([
      'en_route', 'in_transit', 'delivery_attempted', 'out_for_delivery', 'in_transit', 'picked_up', 'pickup_requested', 'created',
    ]);
    expect(result.events![2]!.description).toBe('Delivery attempted: Customer rescheduled');
    // The order the reply lists the scans in does not matter.
    expect(parseShipblu(changed('in-transit', (body) => { body.tracking_events.reverse(); }), IN_TRANSIT)).toEqual(result);
  });

  it('keeps scans of one instant in the carrier\'s order, whichever way it lists them', () => {
    const tied = (body: Reply) => { body.tracking_events[3]!.created = body.tracking_events[2]!.created; };
    const result = parseShipblu(changed('in-transit', tied), IN_TRANSIT);
    expect(result.events!.slice(-4, -2).map((event) => event.provider_code)).toEqual(['in_transit', 'picked_up']);
    expect(parseShipblu(changed('in-transit', (body) => { tied(body); body.tracking_events.reverse(); }), IN_TRANSIT)).toEqual(result);
  });

  it('promises the day the page does: none before pickup or at the end, the chosen day, and a return’s estimate', () => {
    const estimate = (change: (body: Reply) => void, number = IN_TRANSIT) =>
      parseShipblu(changed('in-transit', (body) => { body.tracking_number = number; change(body); }), number).expected_delivery;
    expect(estimate(() => {})).toBe('2026-01-22');
    // A delivery order's estimate comes from another lookup of the page, which the adapter does not make.
    expect(estimate((body) => { body.preferred_date = null; })).toBeNull();
    expect(estimate((body) => { body.preferred_date = null; }, RETURN)).toBe('2026-01-20');
    expect(estimate((body) => { body.preferred_date = '22/01/2026'; body.estimated_date = '2026-02-30'; }, RETURN)).toBeNull();
    expect(estimate((body) => { body.status = 'pickup_requested'; })).toBeNull();
    expect(estimate((body) => { body.status = 'cancelled'; })).toBeNull();
    expect(estimate((body) => { body.status = 'return_to_origin'; })).toBeNull();
  });

  it('reads a return order to the merchant and its arrival there as returned', () => {
    const result = parseShipblu(changed('in-transit', (body) => {
      body.tracking_number = RETURN;
      body.status = 'returned';
      body.tracking_events = [
        { status: 'return_requested', created: '2026-01-18T10:00:01.000000+02:00', comment: null },
        { status: 'out_for_pickup', created: '2026-01-19T09:00:00.000000+02:00', comment: null },
        { status: 'return_attempted', created: '2026-01-19T12:00:00.000000+02:00', comment: 'Customer not available' },
        { status: 'picked_up', created: '2026-01-20T12:00:00.000000+02:00', comment: null },
        { status: 'in_transit', created: '2026-01-20T15:00:00.000000+02:00', comment: null },
        { status: 'out_for_return', created: '2026-01-21T09:00:00.000000+02:00', comment: null },
        { status: 'returned', created: '2026-01-21T13:00:00.000000+02:00', comment: null },
      ];
    }), RETURN);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Returned', expected_delivery: null });
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null])).toEqual([
      ['returned', 'returned'], ['out_for_return', 'returned'], ['in_transit', 'in_transit'], ['picked_up', 'accepted'],
      ['return_attempted', null], ['out_for_pickup', 'registered'], ['return_requested', 'registered'],
    ]);
    expect(result.events![4]!.description).toBe('Return attempted: Customer not available');
  });

  it('shows an order held for the merchant as the page does, on the step it waits at', () => {
    const held = (status: string) => parseShipblu(changed('in-transit', (body) => { body.on_hold = { id: 1 }; body.status = status; }), IN_TRANSIT);
    expect(held('en_route')).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'On hold', expected_delivery: null });
    expect(held('en_route').events![0]).toMatchObject({ description: 'En route', stage: 'in_transit' });
    expect(held('out_for_delivery')).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'En route' });
    expect(held('delivered')).toMatchObject({ current_stage: 'delivered' });
  });

  it('takes the order’s current status over its newest scan, and the newest staged scan for a status the map does not know', () => {
    expect(parseShipblu(changed('in-transit', (body) => { body.status = 'out_for_delivery'; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'En route' });
    expect(parseShipblu(changed('in-transit', (body) => { body.status = 'synthetic_status'; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    // A status the map does not know goes to the shared wording rules, and an unknown one keeps no stage.
    const unknown = parseShipblu(changed('in-transit', (body) => {
      body.status = 'synthetic_status';
      body.tracking_events.push({ status: 'SYNTHETIC_STATUS', created: '2026-01-21T08:00:00+02:00', comment: 'Note 0100 000 0000' });
    }), IN_TRANSIT);
    expect(unknown.events![0]).toEqual({ time: '2026-01-21T08:00:00+02:00', description: 'Synthetic status', provider_code: 'synthetic_status' });
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic status' });
  });

  it('keeps an order without scans as a summary of its current status', () => {
    const summary = (change: (body: Reply) => void) => parseShipblu(changed('delivered', (body) => {
      delete (body as Row).tracking_events;
      change(body);
    }), DELIVERED);
    expect(summary(() => {})).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      provider_code: 'delivered', last_update: '2026-05-12T13:32:19.270Z', expected_delivery: null,
      delivered_at: '2026-05-12T13:32:19.270Z', summary_only: true, events: [],
    });
    expect(summary((body) => { body.status = 'picked_up'; body.delivered_date = null; }))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_update: null, expected_delivery: null, summary_only: true });
    expect(() => summary((body) => { body.status = 'synthetic_status'; }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a reply only when it names the number asked', () => {
    expect(() => parseShipblu(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'ShipBlu answered for another order' }));
    expect(() => parseShipblu(changed('delivered', (body) => { body.tracking_number = `${DELIVERED}0`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseShipblu(changed('delivered', (body) => { body.tracking_number = DELIVERED.slice(1); }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.tracking_number; },
      (body: Reply) => { body.tracking_number = Number(DELIVERED); },
      (body: Reply) => { delete body.status; },
      (body: Reply) => { body.status = ['delivered']; },
      (body: Reply) => { body.status = 'delivered!'; },
      (body: Reply) => { body.tracking_events = 'scans' as never; },
      (body: Reply) => { body.tracking_events = Array.from({ length: 501 }, () => body.tracking_events[0]!); },
      (body: Reply) => { body.tracking_events[0] = 'scan' as never; },
      (body: Reply) => { body.tracking_events[0]!.status = null; },
      (body: Reply) => { delete body.tracking_events[0]!.created; },
      (body: Reply) => { body.tracking_events[0]!.created = '2026-05-09 11:00:01'; },
      (body: Reply) => { body.tracking_events[0]!.created = '2026-05-09T11:00:01.990969'; },
      (body: Reply) => { body.tracking_events[0]!.created = '2026-02-30T11:00:01+02:00'; },
      (body: Reply) => { body.tracking_events[0]!.created = 1000000000; },
      (body: Reply) => { body.tracking_events[8]!.comment = ['Customer not answering']; },
    ]) {
      expect(() => parseShipblu(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseShipblu([], DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // The API answers a number it does not know with HTTP 404 and its own message.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // A route the API does not have is Django's HTML page.
    await expect(lookup('<!doctype html><html lang="en"><head><title>Not Found</title></head><body><h1>Not Found</h1></body></html>',
      { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ detail: 'Synthetic' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://shipblu.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Attention Required! | Cloudflare</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>ShipBlu Tracking</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    // A not-found message on HTTP 200 is not the API's answer for an unknown number.
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ detail: 'Synthetic' }, { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('reads the API’s throttle as a rate limit with its wait', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ detail: 'Request was throttled. Expected available in 60 seconds.' },
      { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number ShipBlu does not issue for a parcel', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-12T13:32:19.270Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('4000000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers ShipBlu does not issue for a parcel and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // Too short, a leading digit the site refuses, a cash collection, a 3 the page routes nowhere, letters and an oversized input.
    for (const number of ['123456', '5123456789012', '0123456789012', '4000000000000', '3300000000000', '30000000',
      'SB1234567890123', '123456789012A', `1${'0'.repeat(40)}`, `1${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeShipbluNumber('1234-5608-90124')).toBe(DELIVERED);
    expect(normalizeShipbluNumber('1234567')).toBe('1234567');
    expect(normalizeShipbluNumber(`1${'0'.repeat(39)}`)).toHaveLength(40);
    expect(() => normalizeShipbluNumber('4000000000000')).toThrow(/cash collections|1, 2, 31 or 32/);
  });

  it('sends a read that failed to reach the service once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under ShipBlu to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'shipblu' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'shipblu', source: 'shipblu', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(SHIPBLU_API))).toBe(true);
  });
});

describe('ShipBlu numbers', () => {
  it('leaves its bare digit runs to no rule', () => {
    for (const number of [DELIVERED, IN_TRANSIT, RETURN, '1234567']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('shipblu');
    }
  });
});

describe('ShipBlu status vocabulary', () => {
  it('records every status code with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (!entry.code) continue;
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(shipbluStage(entry.code), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'shipblu', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(shipbluStage(entry.code), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'shipblu', providerCode: 'delivery_attempted', description: 'Delivery attempted: Customer rescheduled' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'shipblu', providerCode: 'synthetic_status', description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
    // A status the map does not know falls to the shared wording rules.
    expect(shipbluStage('synthetic_delivered')?.stage).toBe('delivered');
    expect(shipbluStage('synthetic_status')).toBeNull();
  });
});
