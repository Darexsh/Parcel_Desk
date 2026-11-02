import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parcelTrackingLinks } from '../../core/catalog/parcel.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, QUIQUP_API, QuiqupTracker, quiqupLookupUrl } from './adapter.js';
import { normalizeQuiqupNumber, parseQuiqup } from './parser.js';
import { quiqupStage, quiqupWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '12345679';
const IN_TRANSIT = '1234567';
const UNKNOWN = '23456789';

type Row = Record<string, unknown>;
type Order = Row & { state_changes: Row[]; delivery_time: Row };
type Reply = Row & { order: Order };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (order: Order, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.order, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Quiqup HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole order number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new QuiqupTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 123 4567 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${QUIQUP_API}?order_id=${IN_TRANSIT}`);
    expect(quiqupLookupUrl(IN_TRANSIT)).toBe('https://ex-api.quiqup.com/order_management/tracking?order_id=1234567');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'quiqup', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each state change as an instant with its offset, newest first, without the repeated one', () => {
    const result = parseQuiqup(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery complete', last_update: '2026-05-12T14:33:20+04:00',
      delivered_at: '2026-05-12T14:33:20+04:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.stage])).toEqual([
      ['2026-05-12T14:33:20+04:00', 'delivery_complete', 'Delivery complete', 'delivered'],
      ['2026-05-12T10:01:15+04:00', 'out_for_delivery', 'Out for delivery', 'out_for_delivery'],
      ['2026-05-11T09:12:00+04:00', 'at_depot', 'At depot', 'in_transit'],
      ['2026-05-10T20:45:00+04:00', 'delivery_failed', 'Delivery failed', 'failed_attempt'],
      ['2026-05-10T17:05:30+04:00', 'out_for_delivery', 'Out for delivery', 'out_for_delivery'],
      ['2026-05-10T16:20:10+04:00', 'at_depot', 'At depot', 'in_transit'],
      ['2026-05-10T14:10:45+04:00', 'in_transit', 'In transit', 'in_transit'],
      ['2026-05-10T13:30:00+04:00', 'at_depot', 'At depot', 'in_transit'],
      // Two state changes in one second keep the reply's order, turned round.
      ['2026-05-10T12:40:05+04:00', 'out_for_collection', 'Out for collection', 'registered'],
      ['2026-05-10T12:40:05+04:00', 'collected', 'Collected', 'accepted'],
      ['2026-05-10T10:15:00+04:00', 'ready_for_collection', 'Ready for collection', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|partner_same_day/);
  });

  it('keeps the time an order on its way is due by, and a hold it came back from', () => {
    const result = parseQuiqup(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In transit',
      last_update: '2026-06-02T11:12:46+04:00', expected_delivery: '2026-06-03T22:00:00+04:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['in_transit', 'in_transit'], ['ready_for_collection', 'registered'], ['picking_started', 'registered'], ['on_hold', 'exception'],
    ]);
  });

  it('promises no time once the order is held, missed, cancelled, returned or a customer’s return', () => {
    for (const state of ['on_hold', 'delivery_failed', 'cancelled', 'return_to_origin', 'delivery_complete']) {
      expect(parseQuiqup(changed('in-transit', (order) => { order.state = state; }), IN_TRANSIT).expected_delivery, state).toBeNull();
    }
    expect(parseQuiqup(changed('in-transit', (order) => { order.service_kind = 'partner_return'; }), IN_TRANSIT).expected_delivery).toBeNull();
    for (const window of [null, {}, { delivery_before: '2026-06-03 22:00' }]) {
      expect(parseQuiqup(changed('in-transit', (order) => { order.delivery_time = window as Row; }), IN_TRANSIT).expected_delivery).toBeNull();
    }
  });

  it('takes the order’s current state over its newest state change', () => {
    const cancelled = parseQuiqup(changed('in-transit', (order) => { order.state = 'cancelled'; }), IN_TRANSIT);
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'In transit' });
    const returned = parseQuiqup(changed('delivered', (order) => {
      order.state = 'returned_to_origin';
      order.state_changes.push({ occurred_at: '2026-05-13T09:00:00.000+04:00', to_state: 'returned_to_origin' });
    }), DELIVERED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned to origin' });
    expect(returned).not.toHaveProperty('delivered_at');
    // Without a current state, the newest state change with a stage decides.
    const unnamed = parseQuiqup(changed('in-transit', (order) => { order.state = null; }), IN_TRANSIT);
    expect(unnamed).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    // A state the map leaves out on purpose has no stage, and the history gives one.
    const missed = parseQuiqup(changed('in-transit', (order) => {
      order.state = 'collection_failed';
      order.state_changes.push({ occurred_at: '2026-06-02T12:00:00.000+04:00', to_state: 'collection_failed' });
    }), IN_TRANSIT);
    expect(missed).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Collection failed' });
    expect(missed.events![0]).not.toHaveProperty('stage');
  });

  it('reads a history listed newest first as one listed oldest first', () => {
    const result = parseQuiqup(changed('delivered', (order) => { order.state_changes.reverse(); }), DELIVERED);
    expect(result).toMatchObject({ last_update: '2026-05-12T14:33:20+04:00', delivered_at: '2026-05-12T14:33:20+04:00' });
    expect(result.events).toEqual(parseQuiqup(fixture('delivered'), DELIVERED).events);
  });

  it('counts an order only when it is the one asked', () => {
    expect(() => parseQuiqup(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Quiqup answered for another order' }));
    expect(parseQuiqup(changed('in-transit', (order) => { order.id = IN_TRANSIT; }), IN_TRANSIT).events).toHaveLength(4);
    expect(() => parseQuiqup(changed('in-transit', (order) => { order.id = 2345678; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads an order without state changes as no history, and a reply sending the page elsewhere as inconclusive', () => {
    expect(() => parseQuiqup(changed('in-transit', (order) => { order.state_changes = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseQuiqup(changed('in-transit', (order) => { delete (order as Row).state_changes; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseQuiqup({ trackingUrl: 'https://tracking.example.com/0000000' }, IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_order: Order, body: Reply) => { delete (body as Row).order; },
      (_order: Order, body: Reply) => { body.order = 'order' as never; },
      (order: Order) => { delete (order as Row).id; },
      (order: Order) => { order.id = 'order'; },
      (order: Order) => { order.state = 7; },
      (order: Order) => { order.state = 'Delivered!'; },
      (order: Order) => { order.state_changes = 'changes' as never; },
      (order: Order) => { order.state_changes = Array.from({ length: 501 }, () => order.state_changes[0]!); },
      (order: Order) => { order.state_changes[0] = 'change' as never; },
      (order: Order) => { delete order.state_changes[0]!.to_state; },
      (order: Order) => { order.state_changes[0]!.to_state = 'On Hold'; },
      (order: Order) => { delete order.state_changes[0]!.occurred_at; },
      (order: Order) => { order.state_changes[0]!.occurred_at = '2026-05-28T19:04:58'; },
      (order: Order) => { order.state_changes[0]!.occurred_at = '2026-02-30T19:04:58.000+04:00'; },
    ]) {
      expect(() => parseQuiqup(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseQuiqup([], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 422 })).rejects.toMatchObject({ kind: 'not_found' });
    // A request the service refuses for another reason, such as a missing parameter.
    await expect(lookup({ errors: { order_id: ['is missing'] }, message: 'Unprocessable entity' }, { status: 422 }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>Quiqup</title></html>', { status: 422 })).rejects.toMatchObject({ kind: 'schema' });
    // The service reads a missing order from a 422 reply: a 404 or a redirect is a moved route.
    await expect(lookup({ code: 'unknown', message: 'Not found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.quiqup.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt = {}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Quiqup</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ order: null })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers Quiqup does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000', '01234567', '123456', '123456789', 'Q1234567', '00000000-0000-4000-8000-000000000000', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeQuiqupNumber(' 1234-5679 ')).toBe(DELIVERED);
  });

  it('ends a hanging read inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under Quiqup to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'quiqup' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'quiqup', source: 'quiqup', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === quiqupLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Quiqup numbers and links', () => {
  it('claims no bare digit run', () => {
    for (const number of [DELIVERED, IN_TRANSIT]) expect(detectCarrierMatch(number).carrier, number).not.toBe('quiqup');
  });

  it('reads the order number from the tracking page’s address, not an order key', () => {
    expect(parseTrackingInput(`https://track-parcel.quiqup.com/${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'quiqup', source: 'link' });
    expect(parseTrackingInput(`https://track-parcel.quiqup.com/${IN_TRANSIT}/`)).toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'quiqup' });
    expect(parseTrackingInput('https://track-parcel.quiqup.com/00000000-0000-4000-8000-000000000000')).not.toMatchObject({ carrier: 'quiqup' });
    expect(parcelTrackingLinks({ carrier: 'quiqup', trackingNumber: DELIVERED }, 'en')[0]?.url).toBe(`https://track-parcel.quiqup.com/${DELIVERED}`);
  });
});

describe('Quiqup status vocabulary', () => {
  it('records every state the map knows with the stage it gives, and the ones it leaves out', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      expect(quiqupWording(entry.code), entry.code).toBe(entry.wording);
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBeUndefined();
        expect(quiqupStage(entry.code), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'quiqup', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(quiqupStage(entry.code), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'quiqup', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // A state the map does not know falls to the shared wording rules.
    expect(quiqupStage('delivered_to_neighbour')).toMatchObject({ stage: 'delivered' });
    expect(quiqupStage('synthetic_state')).toBeNull();
    expect(statusMapAnswer({ carrier: 'quiqup', providerCode: 'synthetic_state', description: 'Synthetic state' })).toEqual({ kind: 'unknown' });
  });
});
