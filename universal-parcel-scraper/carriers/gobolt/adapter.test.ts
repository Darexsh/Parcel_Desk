import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GOBOLT_API, goboltLookupUrl, GoboltTracker } from './adapter.js';
import { normalizeGoboltNumber, parseGobolt } from './parser.js';
import { goboltStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '123406789013';
const IN_TRANSIT = 'ABCDEF123456';
const UNKNOWN = '000000000000';

type Row = Record<string, unknown>;
type Reply = Row & { transit_steps: Row[]; transit_flow: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const EXPIRED = { type: 'error', message: 'Tracking number is expired', status: 404, ok: false, error_message: 'Tracking number is expired', errors: null };
// Cloudflare's managed challenge, as it stands in for a reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';

describe('GoBolt HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GoboltTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' abcdef 123-456 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${GOBOLT_API}?tracking_number=${IN_TRANSIT}`);
    expect(goboltLookupUrl('abcdef123456')).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gobolt', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each step as an instant and keeps a second run to the delivery, without an address or the repeated step', () => {
    const result = parseGobolt(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Package delivered', last_update: '2026-03-12T14:05:41-04:00', expected_delivery: null,
      delivered_at: '2026-03-12T14:05:41-04:00' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null, event.location ?? null, event.description]))
      .toEqual([
        ['2026-03-12T14:05:41-04:00', 'label_delivered', 'delivered', 'Sampleville, Ontario, Canada', 'Package delivered'],
        ['2026-03-12T08:31:10-04:00', 'label_out_for_delivery', 'out_for_delivery', 'Sampleville, Ontario, Canada', 'Package has left warehouse'],
        ['2026-03-11T19:02:00-04:00', 'label_returned_to_warehouse', 'in_transit', 'Sampleville, Ontario, Canada', 'Returned package to warehouse'],
        // The missed visit's place is an address, which is not kept.
        ['2026-03-11T16:45:12-04:00', 'label_failed', 'failed_attempt', null, 'Delivery attempted - customer not at home'],
        ['2026-03-11T08:15:00-04:00', 'label_out_for_delivery', 'out_for_delivery', 'Sampleville, Ontario, Canada', 'Package has left warehouse'],
        ['2026-03-10T22:40:05-04:00', 'label_received_at_destination', 'in_transit', 'Sampleville, Ontario, Canada', 'Package received in local facility'],
        ['2026-03-10T09:12:33-04:00', 'label_scanned', 'accepted', 'Exampleton, Québec, Canada', 'Package received in Exampleton'],
        ['2026-03-09T13:20:49-04:00', 'label_created', 'registered', null, 'Shipment created'],
      ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample Street|A0A|Processing Shipment|updated_at/);
    // Without the summary's delivery instant, the delivery step dates it.
    expect(parseGobolt(changed('delivered', (body) => { body.label_delivered_at = null; }), DELIVERED))
      .toMatchObject({ delivered_at: '2026-03-12T14:05:41-04:00' });
  });

  it('reads a parcel out for delivery with the day of its estimate', () => {
    const result = parseGobolt(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Package has left warehouse', last_update: '2026-05-20T08:02:03-04:00', expected_delivery: '2026-05-20' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['label_out_for_delivery', 'out_for_delivery'], ['label_scanned', 'accepted'], ['label_created', 'registered'],
    ]);
    expect(parseGobolt(changed('in-transit', (body) => { body.estimated_delivery_date = null; }), IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('orders steps by their instant whatever the reply’s order and offsets', () => {
    const result = parseGobolt(changed('in-transit', (body) => {
      // Oldest first, with other offsets for the same instants.
      body.transit_steps.reverse();
      body.transit_steps[0]!.created_at = '2026-05-19T09:17:49.225-07:00';
      body.transit_steps[2]!.created_at = '2026-05-20T12:02:03Z';
    }), IN_TRANSIT);
    expect(result.events!.map((event) => [event.provider_code, event.time])).toEqual([
      ['label_out_for_delivery', '2026-05-20T12:02:03Z'],
      ['label_scanned', '2026-05-20T08:01:39-04:00'],
      ['label_created', '2026-05-19T09:17:49-07:00'],
    ]);
    expect(result.last_update).toBe('2026-05-20T12:02:03Z');
  });

  it('reads a failed step by its reason, and a lost parcel as an exception', () => {
    const failed = (description: string) => parseGobolt(changed('in-transit', (body) => {
      body.transit_steps.unshift({ name: 'label_failed', description, location: 'Exampleton, Québec, Canada',
        created_at: '2026-05-20T16:00:00.000-04:00', updated_at: '2026-05-20T16:00:00.000-04:00' });
    }), IN_TRANSIT);
    expect(failed('Delivery Attempted - Refused By Customer')).toMatchObject({ status: 'exception', current_stage: 'failed_attempt',
      expected_delivery: '2026-05-20' });
    expect(failed('Delivery unsuccessful - issue on route')).toMatchObject({ current_stage: 'exception' });
    expect(failed('Delivery unsuccessful - lost package')).toMatchObject({ current_stage: 'exception' });
    expect(failed('Delivery unsuccessful - return to merchant')).toMatchObject({ current_stage: 'returned', expected_delivery: null });
    const lost = parseGobolt(changed('in-transit', (body) => {
      body.transit_steps.unshift({ name: 'label_lost', description: 'Lost on road', location: null, created_at: '2026-05-20T20:00:00.000-04:00' });
    }), IN_TRANSIT);
    expect(lost).toMatchObject({ current_stage: 'exception', last_status_text: 'Lost on road' });
  });

  it('reads a customer’s return, whose missed pickup moves nothing', () => {
    const result = parseGobolt(changed('in-transit', (body) => {
      body.transit_flow = [
        { name: 'label_created', description: 'Return Created', sequence: 1 },
        { name: 'label_return_scheduled', description: 'Pickup Scheduled', sequence: 2 },
        { name: 'label_return_out_for_pickup', description: 'Out for Pickup', sequence: 3 },
        { name: 'label_return_picked_up', description: 'Picked Up', sequence: 4 },
      ];
      body.transit_steps = [
        { name: 'label_failed', description: 'Pickup attempted - customer not at home', location: 'Exampleton, Québec, Canada',
          created_at: '2026-05-20T15:00:00.000-04:00' },
        { name: 'label_return_out_for_pickup', description: 'Driver on the way', location: 'Exampleton, Québec, Canada',
          created_at: '2026-05-20T08:00:00.000-04:00' },
        { name: 'label_created', description: 'Return created', location: null, created_at: '2026-05-18T10:00:00.000-04:00' },
      ];
    }), IN_TRANSIT);
    expect(result).toMatchObject({ current_stage: 'registered', last_status_text: 'Pickup attempted - customer not at home' });
    expect(result.events![0]).not.toHaveProperty('stage');
    const picked = parseGobolt(changed('in-transit', (body) => {
      body.transit_flow = [{ name: 'label_return_picked_up', description: 'Picked Up', sequence: 4 }];
      body.transit_steps = [{ name: 'label_return_picked_up', description: 'Package picked up', location: null,
        created_at: '2026-05-21T10:00:00.000-04:00' }];
    }), IN_TRANSIT);
    expect(picked).toMatchObject({ current_stage: 'accepted' });
  });

  it('reads an unknown number as not found, an expired one as inconclusive and a shipment without steps as no history', () => {
    expect(() => parseGobolt(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGobolt(EXPIRED, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'history_expired' }));
    expect(() => parseGobolt({ type: 'error', message: 'Something went wrong' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGobolt(changed('delivered', (body) => { body.transit_steps = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseGobolt(changed('delivered', (body) => { delete (body as Row).transit_steps; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseGobolt(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GoBolt answered for another shipment' }));
    expect(() => parseGobolt(changed('delivered', (body) => { body.tracking_number = '12340678901'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseGobolt(changed('in-transit', (body) => { body.tracking_number = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(3);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Row).tracking_number; },
      (body: Reply) => { body.tracking_number = 123406789013; },
      (body: Reply) => { body.transit_steps = 'steps' as never; },
      (body: Reply) => { body.transit_steps = Array.from({ length: 501 }, () => body.transit_steps[0]!); },
      (body: Reply) => { body.transit_steps[0] = 'step' as never; },
      (body: Reply) => { body.transit_flow = 'flow' as never; },
      (body: Reply) => { body.transit_flow[0] = 'step' as never; },
      (body: Reply) => { delete body.transit_steps[0]!.name; },
      (body: Reply) => { body.transit_steps[0]!.name = 'label out'; },
      (body: Reply) => { body.transit_steps[0]!.description = ''; },
      (body: Reply) => { body.transit_steps[0]!.description = ['Package has left warehouse']; },
      (body: Reply) => { body.transit_steps[0]!.location = { town: 'Exampleton' }; },
      (body: Reply) => { body.transit_steps[0]!.created_at = null; },
      (body: Reply) => { body.transit_steps[0]!.created_at = '2026-05-20 08:02:03'; },
      (body: Reply) => { body.transit_steps[0]!.created_at = '2026-05-20T08:02:03'; },
      (body: Reply) => { body.transit_steps[0]!.created_at = '2026-05-20T24:00:00.000-04:00'; },
      (body: Reply) => { body.transit_steps[0]!.created_at = '2026-02-30T08:02:03.000-04:00'; },
      (body: Reply) => { body.transit_steps[0]!.created_at = 1_779_278_523_000; },
      (body: Reply) => { body.estimated_delivery_date = '2026-05-20'; },
    ]) {
      expect(() => parseGobolt(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseGobolt('reply', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGobolt(changed('delivered', (body) => { body.label_delivered_at = 'today'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, an expired one, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(EXPIRED, { status: 404 })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
    // A 404 without the service's error reply is a moved route, and so is a redirect.
    await expect(lookup({ message: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://gobolt.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHALLENGE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>GoBolt - Tracking</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ tracking_number: null })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, leaves an expired one open, and asks nothing for a number GoBolt does not track', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }))
      .mockResolvedValueOnce(reply(EXPIRED, { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T18:05:41.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
    await expect(carrier(fetcher).recognize!('ABC123')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers GoBolt does not track and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12345678901', '1234567890123', 'ABCDEFGHIJKL', 'ABCDEF12345%', `ABCDEF${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGoboltNumber('abcdef 123-456')).toBe(IN_TRANSIT);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
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

  it('routes a number filed under GoBolt to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'gobolt' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'gobolt', source: 'gobolt', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === goboltLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('GoBolt numbers', () => {
  it('leaves its layouts unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('gobolt');
    }
  });
});

describe('GoBolt status vocabulary', () => {
  it('records every step name the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      // The French labels come from the page's label table, without a step name.
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(goboltStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'gobolt', providerCode: 'label_failed', description: 'Delivery attempted - unable to reach customer' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'gobolt', providerCode: 'label_synthetic', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage(null, 'package delivered')).toBeUndefined();
    // A step name the map does not know falls to the shared wording rules.
    expect(goboltStage('label_synthetic', 'Package delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(goboltStage('label_synthetic', 'Synthetic note')).toBeNull();
    expect(goboltStage('LABEL_DELIVERED', 'Package delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(goboltStage('label_returned_to_warehouse', 'Returning package to merchant')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(goboltStage('label_failed', 'Pickup attempted', true)).toBeNull();
  });
});
