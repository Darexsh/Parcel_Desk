import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition, carrierRequirements, requirementSatisfied } from '../../core/catalog/index.js';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { InputRequiredError, InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, RELAYTECH_API, RelaytechTracker, relaytechShipmentUrl } from './adapter.js';
import { normalizeRelaytechNumber, normalizeRelaytechPostcode, parseRelaytech } from './parser.js';
import { relaytechStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'RELRSAMPLE01';
const IN_TRANSIT = 'RELRSAMPLE02';
const COLLECTION = 'RELRSAMPLE03';
const UNKNOWN = 'RELRSAMPLE00';
const POSTCODE = 'ZZ1 1ZZ';

type Row = Record<string, unknown>;
type Shipment = Row & { events: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Shipment;
const changed = (name: string, change: (shipment: Shipment) => void) => {
  const shipment = fixture(name);
  change(shipment);
  return shipment;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const failure = (pending: Promise<unknown>) => pending.then(() => undefined, (error: unknown) => error as Record<string, unknown>);

describe('Relay HTTP adapter', () => {
  it('asks the tracking app’s lookup once with the whole ID and the postcode, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RelaytechTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' relr-sample02 ', ' zz2  2zz ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${RELAYTECH_API}/${IN_TRANSIT}?postcode=ZZ2%202ZZ`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', Origin: 'https://track.relaytech.co', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'relaytech', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivery without the address, the safe place, the courier’s notes, the photo or the repeated scan', () => {
    const result = normalizeCarrierResult(parseRelaytech(fixture('delivered'), DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-31T13:42:10+01:00', expected_delivery: null,
      delivered_at: '2026-03-31T13:42:10+01:00' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-03-31T13:42:10+01:00', 'delivered', 'delivered'],
      ['2026-03-31T08:55:00+01:00', 'out_for_delivery', 'out_for_delivery'],
      ['2026-03-30T16:20:00+01:00', 'delivery_failed_will_reattempt', 'failed_attempt'],
      ['2026-03-30T09:05:00+01:00', 'out_for_delivery', 'out_for_delivery'],
      ['2026-03-29T05:30:00Z', 'scheduled', 'in_transit'],
      ['2026-03-28T22:15:40Z', 'received_from_shipper', 'in_transit'],
      ['2026-03-27T18:02:11Z', 'order_created', 'registered'],
    ]);
    // The drop-off shop of a parcel brought to the door is no pickup point.
    expect(result).not.toHaveProperty('pickup_point');
    expect(result).not.toHaveProperty('expected_delivery_from');
    const kept = JSON.stringify(result);
    for (const value of ['Example Street', 'Sampletown', 'ZZ1 1ZZ', 'card left', 'neighbour', 'example.invalid', 'Example Shop', 'Drop-off', '51.5']) {
      expect(kept, value).not.toContain(value);
    }
  });

  it('reads today’s window while the parcel is on its way, and stages a delay by the scan before it', () => {
    const result = parseRelaytech(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for delivery',
      expected_delivery_from: '2026-04-14T15:00:00+01:00', expected_delivery: '2026-04-14T17:00:00+01:00' });
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null])).toEqual([
      ['out_for_delivery', 'out_for_delivery'], ['scheduled', 'in_transit'], ['delayed', null], ['received_from_shipper', 'in_transit'],
      ['driver_collected_parcel_from_pitstop', 'in_transit'], ['received_at_pitstop', 'accepted'], ['awaiting_parcel_drop_off', 'registered'],
    ]);
    expect(result).not.toHaveProperty('pickup_point');
    expect(result).not.toHaveProperty('delivered_at');
    // A delayed parcel keeps the stage its previous scan gave it.
    const delayed = parseRelaytech(changed('in-transit', (shipment) => {
      shipment.delivery_status = 'delayed';
      shipment.events = shipment.events.slice(0, 5);
    }), IN_TRANSIT);
    expect(delayed).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Delayed' });
    expect(delayed).not.toHaveProperty('provider_code');
    // A window that has passed the newest scan says nothing; the courier's estimate stands in.
    expect(parseRelaytech(changed('in-transit', (shipment) => {
      shipment.estimated_arrival_window_end_at = '2026-04-14T09:00:00+01:00';
    }), IN_TRANSIT)).toMatchObject({ expected_delivery: '2026-04-14T15:25:00+01:00' });
    // A window without an offset is not given one.
    const naive = parseRelaytech(changed('in-transit', (shipment) => {
      shipment.estimated_arrival_window_start_at = '2026-04-14T15:00:00';
      shipment.first_delivery_eta = null;
    }), IN_TRANSIT);
    expect(naive).toMatchObject({ expected_delivery: null });
    expect(naive).not.toHaveProperty('expected_delivery_from');
  });

  it('gives a parcel sent for collection its shop', () => {
    const result = parseRelaytech(fixture('collection'), COLLECTION);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', expected_delivery: null,
      pickup_point: 'Example Collection Shop\n12 Sample Parade, Sampletown\nZZ8 8ZZ' });
    const collected = parseRelaytech(changed('collection', (shipment) => {
      shipment.delivery_status = 'collected_by_customer';
      shipment.parcel_delivered_at = null;
      shipment.events.push({ status: 'collected_by_customer', status_display_slug: 'Collected', timestamp: '2026-05-06T17:20:00+01:00' });
    }), COLLECTION);
    expect(collected).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-05-06T17:20:00+01:00',
      pickup_point: expect.stringMatching(/^Example Collection Shop\n/) });
  });

  it('keeps an offset-less clock as the wall clock it is, and words a slug', () => {
    const result = parseRelaytech(changed('collection', (shipment) => {
      shipment.events = [
        { status: 'order_created', status_display_slug: 'order-created', timestamp: '2026-05-02T08:00:00.123456' },
        { status: 'awaiting_customer_collection', timestamp: '2026-05-05 11:02' },
      ];
    }), COLLECTION);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-05-05T11:02:00', last_status_text: 'Awaiting customer collection' });
    expect(result.events!.map((event) => [event.local_time, event.time ?? null, event.description])).toEqual([
      ['2026-05-05T11:02:00', null, 'Awaiting customer collection'],
      ['2026-05-02T08:00:00', null, 'Order created'],
    ]);
  });

  it('reads a status without scans as a summary, and nothing at all as no history', () => {
    expect(parseRelaytech(changed('in-transit', (shipment) => { shipment.events = []; }), IN_TRANSIT)).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for delivery', provider_code: 'out_for_delivery',
      summary_only: true, events: [],
    });
    expect(() => parseRelaytech(changed('in-transit', (shipment) => {
      shipment.events = [];
      delete shipment.delivery_status;
    }), IN_TRANSIT)).toThrow(NoHistoryError);
  });

  it('counts a shipment only when it answers to the number asked', () => {
    expect(() => parseRelaytech(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Its label ID is the same parcel.
    expect(parseRelaytech(changed('delivered', (shipment) => { shipment.tracking_number = 'RELRSAMPLE99'; }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
    expect(() => parseRelaytech(changed('delivered', (shipment) => { delete shipment.tracking_number; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (shipment: Shipment) => { shipment.events = 'none' as never; },
      (shipment: Shipment) => { shipment.events = [null as never]; },
      (shipment: Shipment) => { shipment.events[0]!.timestamp = '27/03/2026 18:02'; },
      (shipment: Shipment) => { shipment.events[0]!.timestamp = '2026-02-30T10:00:00'; },
      (shipment: Shipment) => { delete shipment.events[0]!.timestamp; },
      (shipment: Shipment) => { shipment.events[0]!.status = 7; },
      (shipment: Shipment) => { shipment.events[0]!.status = 'Order Created!'; },
      (shipment: Shipment) => { shipment.events[0] = { timestamp: '2026-03-27T18:02:11+00:00' }; },
      (shipment: Shipment) => { shipment.delivery_status = { code: 'delivered' }; },
      (shipment: Shipment) => { shipment.events = Array.from({ length: 501 }, () => shipment.events[0]!); },
    ]) {
      expect(() => parseRelaytech(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseRelaytech(null, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the tracker’s 404 as inconclusive, since a wrong postcode gets it too, and keeps a moved route, a block and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => failure(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init)))
      .track({ number: UNKNOWN, postcode: POSTCODE }));
    expect(await lookup(fixture('not-found'), { status: 404 })).toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    expect(await lookup({ detail: 'Not Found' }, { status: 404 })).toMatchObject({ kind: 'transport' });
    expect(await lookup('404 page not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })).toMatchObject({ kind: 'transport' });
    expect(await lookup({ detail: 'Something else' }, { status: 404 })).toMatchObject({ kind: 'schema' });
    expect(await lookup('', { status: 302, headers: { Location: 'https://relaytech.co/' } })).toMatchObject({ kind: 'transport' });
    // A web page in place of the shipment is a block, whatever its status.
    expect(await lookup('<!DOCTYPE html><html><title>Just a moment...</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .toMatchObject({ kind: 'challenge' });
    expect(await lookup('<html><body>Relay</body></html>', { headers: { 'Content-Type': 'text/html' } })).toMatchObject({ kind: 'challenge' });
    expect(await lookup('<html><title>Attention Required!</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .toMatchObject({ kind: 'challenge' });
    expect(await lookup('{"tracking_number":')).toMatchObject({ kind: 'schema' });
    expect(await lookup('null')).toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance'], [422, 'transport']] as const)(
    'preserves HTTP %s as %s without the postcode in its details', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"detail":"synthetic"}', { status,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } }));
      const error = await failure(carrier(fetcher).track({ number: IN_TRANSIT, postcode: POSTCODE }));
      expect(error).toMatchObject({ kind, status });
      expect(error!.request).toBeUndefined();
      expect(error!.diagnostics).toBeUndefined();
      if (status === 429) expect(error).toMatchObject({ retryAfterMs: 30_000 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('keeps the postcode out of a failed connection and bounds the reply', async () => {
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const error = await failure(carrier(down).track({ number: IN_TRANSIT, postcode: POSTCODE }));
    expect(error).toMatchObject({ kind: 'transport' });
    expect(error!.request).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('ZZ1');
    const large = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: IN_TRANSIT, postcode: POSTCODE })).rejects.toThrow('unexpectedly large');
  });

  it('asks nothing without the postcode, for an ID Relay does not issue, or once the lookup is cancelled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    // Without a postcode other sources answer; nothing is asked of Relay.
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toBeInstanceOf(InputRequiredError);
    await expect(carrier(fetcher).track({ number: IN_TRANSIT, postcode: null })).rejects.toMatchObject({ kind: 'input_required' });
    await expect(carrier(fetcher).track({ number: IN_TRANSIT, postcode: '  ' })).rejects.toMatchObject({ kind: 'input_required' });
    await expect(carrier(fetcher).track({ number: IN_TRANSIT, postcode: 'ZZ1/1ZZ' })).rejects.toBeInstanceOf(InvalidInputError);
    for (const number of ['RELR0000000', 'RELR000000000', 'RET0000000000', 'SAMPLETRACKING', `RELR${'0'.repeat(80)}`]) {
      await expect(carrier(fetcher).track({ number, postcode: POSTCODE }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT, postcode: POSTCODE }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeRelaytechNumber('relr sample-02')).toBe(IN_TRANSIT);
    expect(normalizeRelaytechPostcode(' sw1a   1aa ')).toBe('SW1A 1AA');
    expect(relaytechShipmentUrl(IN_TRANSIT, 'sw1a1aa')).toBe(`${RELAYTECH_API}/${IN_TRANSIT}?postcode=SW1A1AA`);
    expect(carrier(fetcher).recognize).toBeUndefined();
  });

  it('ends a hanging read inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT, postcode: POSTCODE }, { budgetMs: 40 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a Relay number with its postcode to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, postcode: 'zz1 1zz' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'relaytech', source: 'relaytech', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${RELAYTECH_API}/${DELIVERED}?postcode=ZZ1%201ZZ`)).toBe(true);
  });

  it('takes a Relay number without its postcode and leaves it to other sources', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .rejects.toMatchObject({ attempts: [{ source: 'relaytech', kind: 'input_required' }] });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Relay numbers and postcode', () => {
  it('claims its tracking IDs and lets the form take a UK postcode beside them, or none', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'relaytech', confidence: 'high' });
    expect(carrierDefinition('relaytech').tracking).toMatchObject({ adapter: 'relaytech', localClocks: true });
    expect(carrierDefinition('relaytech').tracking).not.toHaveProperty('recognition');
    const [requirement] = carrierRequirements('relaytech', DELIVERED);
    expect(requirement).toMatchObject({ field: 'postcode', validator: 'internationalPostcode', autoComplete: 'postal-code' });
    expect(requirement).toMatchObject({ optional: true });
    expect(requirementSatisfied(requirement!, '  ')).toBe(true);
    for (const value of ['SW1A 1AA', 'sw1a1aa', 'M1 1AE', 'B33 8TH', 'DN55 1PT', 'GIR 0AA']) expect(requirementSatisfied(requirement!, value), value).toBe(true);
    for (const value of ['8000', '75001', 'SW1A 1AI', 'QA1 1AA', 'SW1A1']) expect(requirementSatisfied(requirement!, value), value).toBe(false);
    // Browsers compile the field's pattern with the `v` flag.
    expect(() => new RegExp(requirement!.pattern!, 'v')).not.toThrow();
    expect(normalizeCarrierInputs('relaytech', DELIVERED, '', '')).toEqual({ trackingUrl: null, postcode: null });
    expect(() => normalizeCarrierInputs('relaytech', DELIVERED, '', 'ZZ1/1ZZ')).toThrow('Relay requires a valid delivery postcode');
    expect(normalizeCarrierInputs('relaytech', DELIVERED, '', ' sw1a  1aa ')).toEqual({ trackingUrl: null, postcode: 'SW1A 1AA' });
  });
});

describe('Relay status vocabulary', () => {
  it('records every status the tracking app knows with the stage the map gives it', () => {
    for (const entry of statuses.entries as { code: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, 'synthetic wording'), entry.code).toBeUndefined();
        expect(relaytechStage(entry.code, 'Delivered'), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'relaytech', providerCode: entry.code, description: 'Delayed' }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, 'synthetic wording'), entry.code).toBe(entry.stage);
      expect(relaytechStage(entry.code, 'Synthetic wording'), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'relaytech', providerCode: 'out_for_delivery', description: 'Out for delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'relaytech', providerCode: 'toString', description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
    // A status the app does not know falls to the shared wording rules.
    expect(relaytechStage('parcel_handed_back', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(relaytechStage('synthetic_note', 'Synthetic note')).toBeNull();
  });
});
