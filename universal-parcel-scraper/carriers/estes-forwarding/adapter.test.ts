import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ESTES_FORWARDING_API, estesForwardingLookupBody, EstesForwardingTracker } from './adapter.js';
import { normalizeEstesForwardingNumber, parseEstesForwarding } from './parser.js';
import { estesForwardingStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1234568';
const IN_TRANSIT = '7654321';
const UNKNOWN = '0000000';

type Row = Record<string, unknown>;
type Shipment = Row & { events: Row[]; freight: Row[]; scheduledDelivery: Row };
type Reply = { metadata: Row; payload: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, body: Reply) => void) => {
  const body = fixture(name);
  change(body.payload[0]!, body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it would stand in for a reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
// The servlet container's page for a path it does not serve.
const MOVED = '<html><head><title>Apache Tomcat - Error report</title></head><body><h1>HTTP Status 404</h1></body></html>';

describe('Estes Forwarding Worldwide HTTP adapter', () => {
  it('posts the whole housebill as the tracking page does, without a ZIP code, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new EstesForwardingTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 765-4321 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(ESTES_FORWARDING_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `TrackNo=${IN_TRANSIT}&ConZip=NONE`,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(estesForwardingLookupBody('7654321')).toBe(init!.body);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'estes-forwarding', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each event as an instant, without the appointment, the repeated event or the recipient’s details', () => {
    const result = parseEstesForwarding(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2025-12-08T19:48:00Z', expected_delivery: null, delivered_at: '2025-12-08T19:48:00Z',
      service_name: 'HomeNow: To the Door', weight_kg: 56.926 });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.description])).toEqual([
      ['2025-12-08T19:48:00Z', 'DEL', 'delivered', 'Delivered'],
      ['2025-12-08T13:05:00Z', 'OFD', 'out_for_delivery', 'Out For Delivery'],
      ['2025-12-05T07:30:00Z', 'OHD', 'in_transit', 'Arrived at Destination City'],
      ['2025-12-04T06:12:00Z', 'INT', 'in_transit', 'In Transit'],
      ['2025-12-03T06:05:00Z', 'OHO', 'in_transit', 'Arrived at Origin City'],
      ['2025-12-02T15:42:00Z', 'PUP', 'accepted', 'Picked Up'],
      ['2025-12-01T22:10:00Z', 'PUR', 'registered', 'Shipment Created'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.location === undefined && event.stage_source === 'carrier_map'))
      .toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SIGNER|SOFA|EXAMPLEVILLE|SAMPLETON|8005550100|example\.com|00000000-0000|Appointment/);
  });

  it('reads a parcel in transit in time order, with the day of its scheduled delivery', () => {
    const result = parseEstesForwarding(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In Transit', last_update: '2026-05-14T05:02:00Z', expected_delivery: '2026-05-18', service_name: 'Economy',
      weight_kg: 23.587 });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.provider_code)).toEqual(['INT', 'OHO', 'PUP', 'PUR']);
  });

  it('reads the estimate’s day in Eastern time, from the scheduled delivery the page shows or else the estimate event', () => {
    const due = (change: (shipment: Shipment) => void) => parseEstesForwarding(changed('in-transit', change), IN_TRANSIT).expected_delivery;
    // 9:30 PM on the 18th in Eastern time, after midnight GMT.
    expect(due((shipment) => { shipment.scheduledDelivery.fromGMT = '05/19/26 01:30'; })).toBe('2026-05-18');
    const etdOnly = (shipment: Shipment) => { shipment.events[1]!.datetimeGMT = '05/20/26 21:00'; };
    expect(due((shipment) => { etdOnly(shipment); shipment.scheduledDelivery = { fromGMT: null, toGMT: null, scheduledDeliveryType: 'By' }; }))
      .toBe('2026-05-20');
    expect(due((shipment) => { etdOnly(shipment); shipment.scheduledDelivery.toGMT = ''; })).toBe('2026-05-20');
    // A shipment waiting for the recipient to book, an international one and a pickup have no scheduled delivery of their own.
    expect(due((shipment) => { etdOnly(shipment); shipment.scheduledDELactive = true; })).toBe('2026-05-20');
    expect(due((shipment) => { etdOnly(shipment); shipment.shipmenttype = 'international'; })).toBe('2026-05-20');
    expect(due((shipment) => { etdOnly(shipment); shipment.servicelevelcode = 'RT'; })).toBe('2026-05-20');
    expect(due((shipment) => { shipment.scheduledDelivery = { fromGMT: '', toGMT: '' }; shipment.events.splice(1, 1); })).toBeNull();
  });

  it('reads a closed or cancelled shipment as an exception without an estimate, keeping the reply’s order at one instant', () => {
    const result = parseEstesForwarding(changed('in-transit', (shipment) => {
      shipment.events.push({ code: 'CLS', description: 'Closed - Not Delivered', datetimeGMT: '06/21/26 02:15' },
        { code: 'CXL', description: 'Customer Cancelled Order', datetimeGMT: '06/21/26 02:15' });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Customer Cancelled Order',
      last_update: '2026-06-21T02:15:00Z', expected_delivery: null });
    expect(result.events!.slice(0, 2).map((event) => event.provider_code)).toEqual(['CXL', 'CLS']);
  });

  it('stages a code it does not map by its wording, and keeps an unread one without a stage', () => {
    const result = parseEstesForwarding(changed('in-transit', (shipment) => {
      shipment.events.push({ code: 'ZZZ', description: 'Synthetic note', datetimeGMT: '05/15/26 10:00' });
    }), IN_TRANSIT);
    expect(result.events![0]).toEqual({ time: '2026-05-15T10:00:00Z', description: 'Synthetic note', provider_code: 'ZZZ' });
    expect(result.current_stage).toBe('in_transit');
  });

  it('reads an unknown number as not found, a ZIP code request as input required and an empty answer as inconclusive', () => {
    expect(() => parseEstesForwarding(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEstesForwarding(fixture('zip-needed'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'input_required', field: 'the delivery ZIP code' }));
    expect(() => parseEstesForwarding({ metadata: { messages: ['Success'] }, payload: [] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEstesForwarding({ metadata: { messages: ['Something went wrong'] } }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEstesForwarding(changed('delivered', (shipment) => { shipment.events = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // Only the appointment and the estimate: nothing has moved.
    expect(() => parseEstesForwarding(changed('in-transit', (shipment) => { shipment.events = shipment.events.slice(1, 3); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked, and only one', () => {
    expect(() => parseEstesForwarding(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'EFW answered for another shipment' }));
    expect(() => parseEstesForwarding(changed('delivered', (shipment) => { shipment.trackingnumber = '12345678'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = changed('delivered', (shipment, body) => { body.payload.push(structuredClone(shipment)); });
    expect(() => parseEstesForwarding(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    // Another shipment beside the one asked is left out.
    const beside = changed('delivered', (_shipment, body) => { body.payload.unshift(fixture('in-transit').payload[0]!); });
    expect(parseEstesForwarding(beside, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (shipment: Shipment) => { delete shipment.trackingnumber; },
      (shipment: Shipment) => { shipment.trackingnumber = 7654321; },
      (shipment: Shipment) => { shipment.events = 'events' as never; },
      (shipment: Shipment) => { shipment.events = Array.from({ length: 501 }, () => shipment.events[0]!); },
      (shipment: Shipment) => { shipment.events[0] = 'event' as never; },
      (shipment: Shipment) => { delete shipment.events[0]!.code; },
      (shipment: Shipment) => { shipment.events[0]!.code = 'P U R'; },
      (shipment: Shipment) => { shipment.events[0]!.description = ''; },
      (shipment: Shipment) => { shipment.events[0]!.description = ['Shipment Created']; },
      (shipment: Shipment) => { shipment.events[0]!.datetimeGMT = null; },
      (shipment: Shipment) => { shipment.events[0]!.datetimeGMT = '2026-05-11T14:20:00Z'; },
      (shipment: Shipment) => { shipment.events[0]!.datetimeGMT = '05/11/26 24:00'; },
      (shipment: Shipment) => { shipment.events[0]!.datetimeGMT = '02/30/26 14:20'; },
      (shipment: Shipment) => { shipment.events[0]!.datetimeGMT = 1_778_509_200_000; },
      (shipment: Shipment) => { shipment.scheduledDelivery.fromGMT = 'Tomorrow'; },
      (shipment: Shipment) => { shipment.servicelevel = { name: 'Economy' }; },
      (shipment: Shipment) => { shipment.freight = 'freight' as never; },
      (shipment: Shipment) => { shipment.freight[0] = 'line' as never; },
      (_shipment: Shipment, body: Reply) => { body.payload = 'shipments' as never; },
      (_shipment: Shipment, body: Reply) => { body.payload[0] = 'shipment' as never; },
      (_shipment: Shipment, body: Reply) => { body.metadata.messages = 'Success'; },
      (_shipment: Shipment, body: Reply) => { delete (body as Partial<Reply>).metadata; },
    ]) {
      expect(() => parseEstesForwarding(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseEstesForwarding('reply', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A weight it cannot read leaves the weight out, not the history.
    expect(parseEstesForwarding(changed('in-transit', (shipment) => { shipment.freight[0]!.weight = 'heavy'; }), IN_TRANSIT))
      .not.toHaveProperty('weight_kg');
  });

  it('keeps an unknown number, a ZIP code request, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('zip-needed'))).rejects.toMatchObject({ kind: 'input_required' });
    // A 404 without the service's reply is a moved route, and so is a redirect.
    await expect(lookup(MOVED, { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ error: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://efwtrack.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHALLENGE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!doctype html><html><head><title>EFWTrack</title></head><body><div id="app"></div></body></html>'))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ payload: [] })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number EFW does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2025-12-08T19:48:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('12345678')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers EFW does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123456', '12345678', '1234567890123', 'A123456', '1234568%', `1234568${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeEstesForwardingNumber('765 4321')).toBe(IN_TRANSIT);
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(recovered.fetcher).toHaveBeenCalledTimes(2);
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

  it('routes a number filed under Estes Forwarding Worldwide to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'estes-forwarding' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'estes-forwarding', source: 'estes-forwarding', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === ESTES_FORWARDING_API && init?.body === `TrackNo=${DELIVERED}&ConZip=NONE`))
      .toBe(true);
  });
});

describe('Estes Forwarding Worldwide numbers', () => {
  it('leaves its housebills unclaimed', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('estes-forwarding');
    }
  });
});

describe('Estes Forwarding Worldwide status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.code || !entry.stage) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(estesForwardingStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'estes-forwarding', providerCode: 'OFD', description: 'Out For Delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'estes-forwarding', providerCode: 'APP', description: 'Appointment Created' }))
      .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    expect(statusMapAnswer({ carrier: 'estes-forwarding', providerCode: 'ZZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(estesForwardingStage('zzz', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(estesForwardingStage('del', 'Delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});
