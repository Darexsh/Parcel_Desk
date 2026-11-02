import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarrierResult } from '../../core/result/index.js';
import { UpstreamHttpError } from '../../core/transport/index.js';
import { IndeterminateError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import * as trackingBrowser from '../../core/transport/browser.js';
import { stageFor } from './status.js';
import {
  DHLEcommerceSessionError, DHLEcommerceTracker, dhlEcommerceTrackingUrl,
  normalizeDHLEcommerceNumber, parseDHLEcommerceResponse, parseDHLEcommerceWebtrackResponse,
} from './adapter.js';

const NUMBER = '33870000000000001';
const EMPTY_WEBTRACK = { total: 0, limit: 10, offset: 0, packages: [] };

it('uses browser recognition only for recoverable HTTP failures and retains the history', async () => {
  const result: CarrierResult = { status: 'in_transit', events: [{ time: '2026-09-09T08:00:00Z', description: 'Sorted' }] };
  const page = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockResolvedValue(result);
  const tracker = new DHLEcommerceTracker();
  for (const error of [new RateLimitedError('DHL eCommerce'), new SchemaError('DHL eCommerce')]) {
    await expect(tracker.recognizeWithBrowser(NUMBER, {}, error)).rejects.toBe(error);
  }
  expect(page).not.toHaveBeenCalled();
  await expect(tracker.recognizeWithBrowser(NUMBER, { budgetMs: 1_000 },
    new IndeterminateError('DHL eCommerce', 'Regional miss', { reason: 'webtrack_not_found' })))
    .resolves.toMatchObject({ known: true, lastActivityAt: '2026-09-09T08:00:00.000Z', result });
  expect(page).toHaveBeenCalledOnce();
  page.mockRestore();
});
function webtrack() {
  return {
    total: 1, limit: 10, offset: 0,
    packages: [{
      trackedValue: NUMBER, tmiUid: 'synthetic-package-id', trackingId: 'GM1234567890123456',
      packageId: 'SYNTHETICPACKAGE123', status: 'En Route', estimatedDeliveryDate: '2026-09-14',
      sender: { name: 'Synthetic Webshop', postalCode: 'PRIVATE POSTCODE' },
      recipient: { name: 'PRIVATE RECIPIENT', address: 'PRIVATE ADDRESS' },
      events: [
        { primaryEventDescription: 'EN ROUTE', date: '2026-09-09', time: '05:40:17', timeZone: 'LT', location: 'FR' },
        { primaryEventDescription: 'PACKAGE RECEIVED AT DHL ECOMMERCE DISTRIBUTION CENTER', date: '2026-09-02', time: '05:04:26', timeZone: 'CT', location: 'Melrose Park, IL, US' },
        { primaryEventDescription: 'LABEL CREATED', date: '2026-08-31', time: '03:11:58', timeZone: 'ET', location: 'Hebron, KY, US' },
      ],
    }],
  };
}
function handedToUsps() {
  const payload = webtrack();
  Object.assign(payload.packages[0]!, { productName: 'DHL Parcel Ground', weight: { value: 1.5, unitOfMeasure: 'LB' },
    dspName: 'USPS', deliveryConfirmationNumber: '9261 2999 9999 9999 9999 99' });
  payload.packages[0]!.events.unshift({ primaryEventDescription: 'TENDERED TO DELIVERY SERVICE PROVIDER',
    date: '2026-09-10', time: '07:00:00', timeZone: 'CT', location: 'Sampleton, IL, US' });
  return payload;
}
function reply(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

interface Scan { description: string; statusCode: string; timestamp: string; location: { address: Record<string, unknown> } }
interface Payload {
  shipments: ({ id: string; service: string; status: Scan; events: Scan[]; estimatedTimeOfDelivery?: string; returnFlag?: boolean } & Record<string, unknown>)[];
}

function json<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as T;
}

function event(description = 'EN ROUTE', statusCode = 'transit', timestamp = '2026-09-09T05:40:17', address: Record<string, string> = { addressLocality: 'FR' }): Scan {
  return { description, statusCode, timestamp, location: { address } };
}
function shipment(): Payload {
  return json<Payload>('./fixtures/in-transit.json');
}

afterEach(() => vi.restoreAllMocks());

describe('DHL eCommerce normalization', () => {
  it('reads a cleared customs line, in either word order, and the hand-over to a partner as transit', () => {
    expect(stageFor({ description: 'CLEARED CUSTOMS' })).toBe('in_transit');
    expect(stageFor({ description: 'CUSTOMS CLEARED' })).toBe('in_transit');
    expect(stageFor({ description: 'HELD BY CUSTOMS' })).toBe('customs');
    expect(stageFor({ description: 'HANDED OVER TO PARTNER CARRIER' })).toBe('in_transit');
  });

  it('requires text before using a translated delivery label', () => {
    expect(stageFor({ description: ['Delivered'], statusCode: 'transit' })).toBe('in_transit');
    expect(stageFor({ description: { text: 'Delivered' }, statusCode: 'transit' })).toBe('in_transit');
    expect(stageFor({ description: ['unknown'], statusCode: 'delivered' })).toBe('delivered');
  });

  it('reads aliases, converts local timestamps, keeps announcement stages and discards private fields', () => {
    const result = parseDHLEcommerceResponse(shipment());
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-09-09T03:40:17.000Z', expected_delivery: '2026-09-14' });
    expect(result.events?.[1]).toMatchObject({ time: '2026-08-31T07:11:58.000Z', stage: 'registered' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('customer-confirmation');
  });

  it('produces every capability declared in carrier.json, without private fields', () => {
    const checks: Record<string, (result: CarrierResult) => unknown> = {
      history: (result) => result.events?.length,
      location: (result) => result.events?.some((scan) => scan.location),
      eta: (result) => result.expected_delivery,
      sender_name: (result) => result.sender_name,
      delivered_at: (result) => result.delivered_at,
      service_name: (result) => result.service_name,
      weight: (result) => result.weight_kg,
      delivery_partner: (result) => result.delivery_carrier,
      delivery_tracking_number: (result) => result.delivery_tracking_number,
    };
    const declared = json<{ capabilities: string[] }>('./carrier.json').capabilities;
    const results = [parseDHLEcommerceResponse(shipment()), parseDHLEcommerceResponse(json<Payload>('./fixtures/delivered.json')),
      parseDHLEcommerceWebtrackResponse(handedToUsps(), NUMBER)];
    expect(declared.length).toBeGreaterThan(0);
    for (const capability of declared) {
      expect(checks[capability], `no check for capability ${capability}`).toBeDefined();
      expect(results.some((result) => Boolean(checks[capability]!(result))), capability).toBe(true);
    }
    for (const result of results) expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each([
    ['MANIFEST DATA RECEIVED', 'unknown', 'registered', 'pending'],
    ['EN ROUTE TO DHL ECOMMERCE OR AWAITING PROCESSING', 'transit', 'registered', 'pending'],
    ['PACKAGE RECEIVED AT DHL ECOMMERCE DISTRIBUTION CENTER', 'transit', 'accepted', 'in_transit'],
    ['OUT FOR DELIVERY', 'transit', 'out_for_delivery', 'out_for_delivery'],
    ['READY FOR COLLECTION', 'transit', 'ready_for_pickup', 'out_for_delivery'],
    ['CUSTOMS CLEARANCE', 'transit', 'customs', 'in_transit'],
    ['CUSTOMS CLEARED', 'transit', 'in_transit', 'in_transit'],
    ['Carrier exception', 'failure', 'exception', 'exception'],
    ['DELIVERY ATTEMPT FAILED', 'failure', 'failed_attempt', 'exception'],
    ['RETURNED TO SENDER', 'delivered', 'returned', 'exception'],
    ['Signed by PRIVATE', 'delivered', 'delivered', 'delivered'],
  ])('maps %s without inventing progress', (description, code, stage, status) => {
    const payload = shipment(); payload.shipments[0]!.status = event(description, code);
    payload.shipments[0]!.events = [payload.shipments[0]!.status];
    const result = parseDHLEcommerceResponse(payload);
    expect(result).toMatchObject({ current_stage: stage, status });
    if (stage === 'delivered' || stage === 'returned') expect(result.expected_delivery).toBeNull();
    if (stage === 'delivered') expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('handles return delivery flags and invalid delivery estimates', () => {
    const payload = shipment(); payload.shipments[0]!.status = event('Delivered', 'delivered');
    payload.shipments[0]!.returnFlag = true;
    expect(parseDHLEcommerceResponse(payload)).toMatchObject({ current_stage: 'returned', expected_delivery: null });
    payload.shipments[0]!.status = event(); payload.shipments[0]!.estimatedTimeOfDelivery = '2026-02-31';
    expect(parseDHLEcommerceResponse(payload).expected_delivery).toBeNull();
  });

  it('keeps wall clocks at unknown places local, and honors explicit offsets within fourteen hours', () => {
    const unknown = { addressLocality: 'Unknown' };
    const payload = shipment();
    payload.shipments[0]!.status = event('EN ROUTE', 'transit', '2026-09-01T11:00', unknown);
    payload.shipments[0]!.events = [
      event('EN ROUTE', 'transit', '2026-09-01T11:00', unknown),
      { ...event('SORTED', 'transit', '2026-09-01T10:30:00'), location: { address: {} } },
      event('PROCESSED', 'transit', '2026-09-01T09:00:00-05:00', unknown),
      event('ARRIVED', 'transit', '2026-09-01T10:00:00+02', unknown),
      event('DEPARTED', 'transit', '2026-09-01T09:00:00+0200', unknown),
      ...['+2500', '+0299', '+14:30', '+1', '+05:3'].map((offset) => event('SORTED', 'transit', `2026-09-01T08:00:00${offset}`, unknown)),
      event('EN ROUTE', 'transit', 'invalid'),
    ];
    const result = parseDHLEcommerceResponse(payload);
    expect(result.events?.map((scan) => [scan.description, scan.time ?? `local ${String(scan.local_time)}`, scan.location])).toEqual([
      ['EN ROUTE', 'local 2026-09-01T11:00:00', 'Unknown'], ['SORTED', 'local 2026-09-01T10:30:00', ''],
      ['PROCESSED', '2026-09-01T14:00:00.000Z', 'Unknown'], ['ARRIVED', '2026-09-01T08:00:00.000Z', 'Unknown'],
      ['DEPARTED', '2026-09-01T07:00:00.000Z', 'Unknown'],
    ]);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-09-01T11:00:00' });
  });

  it('keeps a UTAPI wall clock local in an hour a clock change skips or repeats, and the reply\'s order with it', () => {
    const zurich = { addressLocality: 'Zurich', countryCode: 'CH' };
    const payload = shipment();
    payload.shipments[0]!.status = event('Delivered', 'delivered', '2026-10-25T02:30:00', zurich);
    payload.shipments[0]!.events = [
      event('Delivered', 'delivered', '2026-10-25T02:30:00', zurich),
      event('OUT FOR DELIVERY', 'transit', '2026-10-25T01:30:00', zurich),
      event('PROCESSED', 'transit', '2026-10-24T09:00:00+0200', zurich),
      event('PROCESSED', 'transit', '2026-03-29T02:30', zurich),
      event('PROCESSED', 'transit', '2026-03-08T02:30:00', { addressLocality: 'Hebron, KY, US' }),
      event('PROCESSED', 'transit', '2026-11-01T01:30:00', { addressLocality: 'Hebron, KY, US' }),
    ];
    const result = parseDHLEcommerceResponse(payload);
    expect(result.events?.map((scan) => scan.time ?? `local ${String(scan.local_time)}`)).toEqual([
      'local 2026-10-25T02:30:00', '2026-10-24T23:30:00.000Z', '2026-10-24T07:00:00.000Z',
      'local 2026-03-29T02:30:00', 'local 2026-03-08T02:30:00', 'local 2026-11-01T01:30:00',
    ]);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-10-25T02:30:00' });
    expect(result).not.toHaveProperty('delivered_at');
    // Clocks that each have one instant are read as before, newest first.
    payload.shipments[0]!.status = event('OUT FOR DELIVERY', 'transit', '2026-10-25T01:30:00', zurich);
    payload.shipments[0]!.events = [payload.shipments[0]!.events[2]!, payload.shipments[0]!.events[1]!];
    expect(parseDHLEcommerceResponse(payload)).toMatchObject({ last_update: '2026-10-24T23:30:00.000Z',
      events: [{ time: '2026-10-24T23:30:00.000Z' }, { time: '2026-10-24T07:00:00.000Z' }] });
    expect(parseDHLEcommerceResponse(payload)).not.toHaveProperty('last_update_local');
  });

  it('writes the country once after a locality that already ends with it', () => {
    const payload = shipment();
    payload.shipments[0]!.events = [
      event('PROCESSED', 'transit', '2026-09-03T10:00:00Z', { addressLocality: 'Sampleton, IL, US', countryCode: 'US' }),
      event('PROCESSED', 'transit', '2026-09-02T10:00:00Z', { addressLocality: 'Zurich', countryCode: 'CH' }),
      event('PROCESSED', 'transit', '2026-09-01T10:00:00Z', { countryCode: 'US' }),
    ];
    expect(parseDHLEcommerceResponse(payload).events?.map((scan) => scan.location)).toEqual(['Sampleton, IL, US', 'Zurich, CH', 'US']);
  });

  it('rejects ambiguous, malformed and other-division responses', () => {
    for (const payload of [{}, { shipments: [] }, { shipments: [shipment().shipments[0], shipment().shipments[0]] },
      { shipments: [{ ...shipment().shipments[0], service: 'express' }] },
      { shipments: [{ ...shipment().shipments[0], status: {} }] },
      { shipments: [{ ...shipment().shipments[0], events: {} }] }]) {
      expect(() => parseDHLEcommerceResponse(payload)).toThrow();
    }
  });

  it('normalizes numbers and creates the global tracking link', () => {
    expect(normalizeDHLEcommerceNumber('gm 1234-5678.9012 3456')).toBe('GM1234567890123456');
    expect(dhlEcommerceTrackingUrl(NUMBER)).toContain(`tracking-id=${NUMBER}&submit=1`);
    expect(() => normalizeDHLEcommerceNumber('https://evil.example')).toThrow();
  });
});

describe('DHL eCommerce fetching', () => {
  beforeEach(() => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(EMPTY_WEBTRACK)));
  it('rejects invalid timeouts before doing any work', () => {
    for (const timeoutMs of [0, -1, Infinity, NaN, 60_001]) {
      expect(() => new DHLEcommerceTracker({ timeoutMs })).toThrow('timeout');
    }
  });

  it('uses the global browser when the regional HTTP endpoint does not list the shipment', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockImplementation(async (_options, spec, parse) => {
      expect(spec.url).toBe(dhlEcommerceTrackingUrl(NUMBER));
      expect(spec.responseUrl).toBe(`https://www.dhl.com/utapi?trackingNumber=${NUMBER}&language=en&requesterCountryCode=CH&source=tt`);
      return parse(shipment());
    });
    const result = await new DHLEcommerceTracker({ executablePath: '/test/chromium', timeoutMs: 30000 }).fetch(NUMBER);
    expect(result.current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browser).toHaveBeenCalledOnce();
    expect(browser.mock.calls[0]![0].timeoutMs).toBeLessThanOrEqual(30000);
  });

  it('propagates browser failures after a regional miss', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockRejectedValue(new Error('Browser unavailable'));
    await expect(new DHLEcommerceTracker({ executablePath: '/test/chromium' }).fetch(NUMBER)).rejects.toThrow('Browser unavailable');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browser).toHaveBeenCalledOnce();
  });

  it('names the challenge statuses so the host keeps the upstream status', async () => {
    vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockRejectedValue(new UpstreamHttpError('DHL eCommerce', 428));
    await expect(new DHLEcommerceTracker({ executablePath: '/test/chromium' }).fetch(NUMBER)).rejects
      .toMatchObject({ name: 'DHLEcommerceSessionError', status: 428 });
    await expect(new DHLEcommerceTracker({ executablePath: '/test/chromium' }).fetch(NUMBER)).rejects
      .toBeInstanceOf(DHLEcommerceSessionError);
    vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockRejectedValue(new UpstreamHttpError('DHL eCommerce', 503));
    await expect(new DHLEcommerceTracker({ executablePath: '/test/chromium' }).fetch(NUMBER)).rejects
      .toMatchObject({ name: 'UpstreamHttpError', status: 503 });
  });

  it('answers a lookup cancelled in the queue at once, without a browser and without failing the one behind it', async () => {
    let finish!: (result: CarrierResult) => void;
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage')
      .mockImplementationOnce(() => new Promise<CarrierResult>((resolve) => { finish = resolve; }))
      .mockImplementation(async (_options, _spec, parse) => parse(shipment()));
    const tracker = new DHLEcommerceTracker({ executablePath: '/test/chromium' });
    const controller = new AbortController();
    const first = tracker.fetch(NUMBER);
    const cancelled = tracker.fetch(NUMBER, { signal: controller.signal });
    const behind = tracker.fetch(NUMBER);
    await vi.waitFor(() => expect(browser).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));
    await expect(cancelled).rejects.toThrow('caller cancelled');
    finish(parseDHLEcommerceResponse(shipment()));
    await expect(first).resolves.toMatchObject({ current_stage: 'in_transit' });
    await expect(behind).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it('counts the wait in the queue against a budget the caller set', async () => {
    let finish!: (result: CarrierResult) => void;
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage')
      .mockImplementationOnce(() => new Promise<CarrierResult>((resolve) => { finish = resolve; }))
      .mockImplementation(async (_options, _spec, parse) => parse(shipment()));
    const tracker = new DHLEcommerceTracker({ executablePath: '/test/chromium' });
    const first = tracker.fetch(NUMBER);
    await expect(tracker.fetch(NUMBER, { budgetMs: 40 })).rejects.toMatchObject({ name: 'BudgetExceededError', kind: 'budget' });
    finish(parseDHLEcommerceResponse(shipment()));
    await expect(first).resolves.toMatchObject({ current_stage: 'in_transit' });
    await expect(tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it('reports the browser step through the recorder', async () => {
    vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockImplementation(async (_options, _spec, parse) => parse(shipment()));
    const steps: string[] = [];
    const lookups: (string | null)[] = [];
    await new DHLEcommerceTracker({ executablePath: '/test/chromium', recorder: {
      step: ({ step }) => { steps.push(step); },
      lookup: ({ finalStep }) => { lookups.push(finalStep); },
    } }).fetch(NUMBER);
    expect(steps).toEqual(['direct', 'browser']);
    expect(lookups).toEqual(['browser']);
  });

  it('ends the global step when UTAPI has no shipment or only another DHL service\'s', async () => {
    const ecommerce = shipment().shipments[0]!;
    const paket = { ...ecommerce, service: 'parcel-de' };
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockImplementation(async (_options, spec) => {
      expect(spec.errorStatuses).toEqual([404]);
      throw spec.responseErrors![spec.responseUrl]!({ title: 'No result found', status: 404, detail: 'No shipment with given tracking number found.' })!;
    });
    await expect(new DHLEcommerceTracker({ executablePath: '/test/chromium' }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    const answer = browser.mock.calls[0]![1].responseErrors![browser.mock.calls[0]![1].responseUrl]!;
    expect(answer({ shipments: [paket] })).toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found', message: 'Another DHL service carries the shipment' });
    for (const payload of [shipment(), { shipments: [ecommerce, paket] }, { shipments: [] }, { title: 'Not Found', status: 404 }]) {
      expect(answer(payload)).toBeUndefined();
    }
  });
});

describe('DHL eCommerce Webtrack', () => {
  it('binds an alias to one identified package and reads only public tracking fields', () => {
    const result = parseDHLEcommerceWebtrackResponse(webtrack(), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_update: '2026-09-09T03:40:17.000Z', expected_delivery: '2026-09-14', sender_name: 'Synthetic Webshop' });
    expect(result.events).toEqual([
      expect.objectContaining({ time: '2026-09-09T03:40:17.000Z', stage: 'in_transit' }),
      expect.objectContaining({ time: '2026-09-02T10:04:26.000Z', stage: 'accepted' }),
      expect.objectContaining({ time: '2026-08-31T07:11:58.000Z', stage: 'registered' }),
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('synthetic-package-id');
    expect(JSON.stringify(result)).not.toContain('GM1234567890123456');
  });

  it('accepts an exact returned carrier identifier and rejects a query echo without a package identity', () => {
    const payload = webtrack();
    expect(parseDHLEcommerceWebtrackResponse(payload, 'GM1234567890123456').events).toHaveLength(3);
    payload.packages[0]!.trackingId = ''; payload.packages[0]!.packageId = '';
    expect(() => parseDHLEcommerceWebtrackResponse(payload, NUMBER)).toThrow('unidentified');
  });

  it('keeps unresolved local clocks separate and validates explicit offsets and impossible dates', () => {
    const payload = webtrack(); payload.packages[0]!.events = [
      { primaryEventDescription: 'EN ROUTE', date: '2026-09-01', time: '09:00:00', timeZone: 'LT', location: 'Unknown' },
      { primaryEventDescription: 'EN ROUTE', date: '2026-09-01', time: '09:00:00-05:00', timeZone: 'LT', location: 'Unknown' },
      { primaryEventDescription: 'EN ROUTE', date: '2026-02-31', time: '09:00:00', timeZone: 'LT', location: 'FR' },
      { primaryEventDescription: 'EN ROUTE', date: '2026-09-01', time: '09:00:00+99:00', timeZone: 'LT', location: 'FR' },
    ];
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER).events).toEqual([
      expect.objectContaining({ local_time: '2026-09-01T09:00:00' }),
      expect.objectContaining({ time: '2026-09-01T14:00:00.000Z' }),
    ]);
  });

  it('reads the clock Webtrack names for each scan, checked against its place', () => {
    const payload = webtrack(); payload.packages[0]!.events = [
      { primaryEventDescription: 'OUT FOR DELIVERY', date: '2026-07-14', time: '08:20:00', timeZone: 'CT', location: 'Sampleton, IL, US' },
      { primaryEventDescription: 'PROCESSED', date: '2026-07-13', time: '21:45:00', timeZone: 'PT', location: '' },
      { primaryEventDescription: 'PROCESSED', date: '2026-07-13', time: '18:05:00', timeZone: 'PDT', location: 'Sampleton, CA, US' },
      // Arizona stays on standard time while Mountain Time is on daylight time.
      { primaryEventDescription: 'PROCESSED', date: '2026-07-13', time: '11:15:00', timeZone: 'MT', location: 'Sampleton, AZ, US' },
      { primaryEventDescription: 'PROCESSED', date: '2026-07-12', time: '23:40:00', timeZone: 'PT', location: 'Sampleton, HI, US' },
      // Part of Indiana keeps Central Time.
      { primaryEventDescription: 'PROCESSED', date: '2026-07-12', time: '19:25:00', timeZone: 'CT', location: 'Sampleton, IN, US' },
      { primaryEventDescription: 'PROCESSED', date: '2026-07-12', time: '14:50:00', timeZone: '+07', location: 'Sampleton' },
      { primaryEventDescription: 'LABEL CREATED', date: '2026-07-11', time: '10:35:00', timeZone: 'XT', location: 'Sampleton' },
    ];
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER).events).toEqual([
      expect.objectContaining({ time: '2026-07-14T13:20:00.000Z', stage: 'out_for_delivery' }),
      expect.objectContaining({ time: '2026-07-14T04:45:00.000Z' }),
      expect.objectContaining({ time: '2026-07-14T01:05:00.000Z' }),
      expect.objectContaining({ time: '2026-07-13T18:15:00.000Z' }),
      expect.objectContaining({ time: '2026-07-13T09:40:00.000Z' }),
      expect.objectContaining({ time: '2026-07-13T00:25:00.000Z' }),
      expect.objectContaining({ time: '2026-07-12T07:50:00.000Z' }),
      expect.objectContaining({ local_time: '2026-07-11T10:35:00', stage: 'registered' }),
    ]);
  });

  it('reads the state from other place formats, a shared code as the state the label fits, and a hub on its own clock', () => {
    const scan = (time: string, timeZone: string, location: string) => ({ primaryEventDescription: 'PROCESSED', date: '2026-07-13', time, timeZone, location });
    const payload = webtrack(); payload.packages[0]!.events = [
      scan('11:15:00', 'MT', 'Sampleton, AZ 00000, US'), scan('10:15:00', 'MT', 'Sampleton AZ US'),
      scan('09:15:00', 'MT', 'Sampleton, AZ'), scan('08:15:00', 'MST', 'Sampleton, AZ 00000'),
      scan('07:40:00', 'PT', 'Sampleton, HI, USA'), scan('06:30:00', 'ET', 'Sampleton, DE'),
      scan('05:45:00', 'PDT', 'Sampleton, CA'), scan('04:45:00', 'CT', 'Hebron, KY, US'),
    ];
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER).events?.map((event) => event.time)).toEqual([
      '2026-07-13T18:15:00.000Z', '2026-07-13T17:40:00.000Z', '2026-07-13T17:15:00.000Z', '2026-07-13T16:15:00.000Z',
      '2026-07-13T15:15:00.000Z', '2026-07-13T12:45:00.000Z', '2026-07-13T10:30:00.000Z', '2026-07-13T08:45:00.000Z',
    ]);
  });

  it('reads a scan abroad on the clock of its place, whatever US label it carries', () => {
    const scan = (time: string, timeZone: string, location: string) => ({ primaryEventDescription: 'PROCESSED', date: '2026-07-10', time, timeZone, location });
    const payload = webtrack(); payload.packages[0]!.events = [
      scan('12:30:00', 'PDT', ''), scan('16:30:00', 'CT', 'Sampleton, CN'), scan('15:30:00', 'ET', 'Sampleton, CN'),
      scan('14:30:00', 'CST', 'Sampleton, CN'), scan('12:30:00', 'PT', 'Sampleton, TH'),
      scan('11:30:00', 'EST', 'Sampleton, TH'), scan('05:00:00', 'CT', 'Sampleton, DE'),
      scan('03:00:00', 'ET', 'Germany'), scan('04:00:00', 'CST', 'CHINA'),
    ];
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER).events?.map((event) => event.time)).toEqual([
      '2026-07-10T19:30:00.000Z', '2026-07-10T08:30:00.000Z', '2026-07-10T07:30:00.000Z', '2026-07-10T06:30:00.000Z',
      '2026-07-10T05:30:00.000Z', '2026-07-10T04:30:00.000Z', '2026-07-10T03:00:00.000Z', '2026-07-10T01:00:00.000Z',
      '2026-07-09T20:00:00.000Z',
    ]);
  });

  it('settles a repeated hour by its abbreviation', () => {
    const scan = (timeZone: string) => ({ primaryEventDescription: 'PROCESSED', date: '2026-11-01', time: '01:30:00', timeZone, location: 'Sampleton, IL, US' });
    const payload = webtrack(); payload.packages[0]!.events = [scan('CST'), scan('CDT')];
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER).events?.map((event) => event.time))
      .toEqual(['2026-11-01T07:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  });

  it('keeps a clock local when its label does not fit the place or names no single instant', () => {
    const scan = (date: string, time: string, timeZone: string, location: string) => ({ primaryEventDescription: 'PROCESSED', date, time, timeZone, location });
    const payload = webtrack(); payload.packages[0]!.events = [
      scan('2026-07-10', '09:30:00', 'ET', 'Sampleton, TX, US'),
      scan('2026-07-10', '10:00:00', 'EST', 'Sampleton, NY, US'),
      // Arizona has no daylight time.
      scan('2026-07-10', '08:00:00', 'MDT', 'Sampleton, AZ, US'),
      scan('2026-07-10', '07:00:00', 'EDT', 'Sampleton, CA'),
      scan('2026-07-10', '06:00:00', 'CT', 'Sampleton, SK, CA'),
      scan('2026-07-10', '05:00:00', 'CT', 'Sampleton, MX'),
      scan('2026-03-08', '02:30:00', 'ET', 'Sampleton, NY, US'),
      scan('2026-03-08', '02:30:00', 'EDT', 'Sampleton, NY, US'),
      scan('2026-11-01', '01:30:00', 'CT', 'Sampleton, IL, US'),
    ];
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER).events?.map((scan) => scan.time ?? scan.local_time)).toEqual([
      '2026-07-10T09:30:00', '2026-07-10T10:00:00', '2026-07-10T08:00:00', '2026-07-10T07:00:00', '2026-07-10T06:00:00',
      '2026-07-10T05:00:00', '2026-03-08T02:30:00', '2026-03-08T02:30:00', '2026-11-01T01:30:00',
    ]);
  });

  it('orders scans by instant only when every scan has one', () => {
    const scan = (time: string, timeZone = 'ET') => ({ primaryEventDescription: 'PROCESSED', date: '2026-07-09', time, timeZone, location: 'Sampleton, NY, US' });
    const payload = webtrack(); payload.packages[0]!.events = [scan('10:00:00'), scan('12:00:00')];
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER).events?.map((event) => event.time))
      .toEqual(['2026-07-09T16:00:00.000Z', '2026-07-09T14:00:00.000Z']);
    payload.packages[0]!.events = [scan('10:00:00'), scan('11:00:00', 'XT'), scan('12:00:00')];
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER).events?.map((event) => event.time ?? event.local_time))
      .toEqual(['2026-07-09T14:00:00.000Z', '2026-07-09T11:00:00', '2026-07-09T16:00:00.000Z']);
  });

  it('stages the handover to the last-mile partner and skips the en-route echo', () => {
    const payload = webtrack(); payload.packages[0]!.events = [
      { primaryEventDescription: 'EN ROUTE', date: '2026-07-16', time: '04:12:09', timeZone: 'ET', location: '' },
      { primaryEventDescription: 'SHIPMENT ACCEPTED BY USPS', date: '2026-07-15', time: '16:40:00', timeZone: 'CT', location: 'Sampleton, IL, US' },
      { primaryEventDescription: 'TENDERED TO DELIVERY SERVICE PROVIDER, ALLOW 1-3 DAYS FOR UPDATES FOR PACKAGES WITHIN THE US', date: '2026-07-15', time: '11:25:30', timeZone: 'CT', location: 'Sampleton, IL, US' },
    ];
    const result = parseDHLEcommerceWebtrackResponse(payload, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-07-15T21:40:00.000Z' });
    expect(result.events).toEqual([
      expect.objectContaining({ time: '2026-07-15T21:40:00.000Z', stage: 'in_transit' }),
      expect.objectContaining({ time: '2026-07-15T16:25:30.000Z', stage: 'in_transit' }),
    ]);
  });

  it('reads the service, weight and last-mile partner Webtrack declares', () => {
    expect(parseDHLEcommerceWebtrackResponse(handedToUsps(), NUMBER)).toMatchObject({ service_name: 'DHL Parcel Ground',
      weight_kg: 0.68, delivery_carrier: 'usps', delivery_tracking_number: '9261299999999999999999' });
    // The partner's number is not repeated when it is the one asked for.
    expect(parseDHLEcommerceWebtrackResponse(handedToUsps(), '9261299999999999999999')).toMatchObject({ delivery_carrier: 'usps' });
    expect(parseDHLEcommerceWebtrackResponse(handedToUsps(), '9261299999999999999999')).not.toHaveProperty('delivery_tracking_number');
    const own = webtrack();
    Object.assign(own.packages[0]!, { weight: { value: 2, unitOfMeasure: 'OZT' }, dspName: 'MIRROR', deliveryConfirmationNumber: 'SYNTHETIC00001' });
    const result = parseDHLEcommerceWebtrackResponse(own, NUMBER);
    for (const field of ['service_name', 'weight_kg', 'delivery_carrier', 'delivery_tracking_number']) expect(result).not.toHaveProperty(field);
  });

  it('names the last-mile partner only once it has the parcel', () => {
    const scan = (primaryEventDescription: string) => ({ primaryEventDescription, date: '2026-07-08', time: '09:00:00', timeZone: 'CT', location: 'Sampleton, IL, US' });
    for (const description of ['LABEL CREATED', 'NOT ACCEPTED BY USPS']) {
      const payload = handedToUsps(); payload.packages[0]!.events = [scan(description)];
      const result = parseDHLEcommerceWebtrackResponse(payload, NUMBER);
      expect(result, description).not.toHaveProperty('delivery_carrier');
      expect(result, description).not.toHaveProperty('delivery_tracking_number');
    }
    const payload = handedToUsps(); payload.packages[0]!.events = [scan('SHIPMENT ACCEPTED BY USPS')];
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER)).toMatchObject({ delivery_carrier: 'usps' });
  });

  it('hands over to a partner named by its Webtrack code or its link, and lists a doubled scan once', () => {
    const scan = (primaryEventId: string, primaryEventDescription: string, time: string, location: string) =>
      ({ primaryEventId, primaryEventDescription, date: '2026-07-08', time, timeZone: 'LT', location });
    const payload = webtrack();
    Object.assign(payload.packages[0]!, { dspName: 'DAI_DIRECT', deliveryConfirmationNumber: '00399999999999999999999', events: [
      scan('77', 'CLEARED CUSTOMS', '11:31:00', 'Sampleton, AU'),
      scan('77', 'CLEARED CUSTOMS', '11:31:00', 'Sampleton, Exampleville, AU'),
      scan('76', 'HANDED OVER TO PARTNER CARRIER', '11:30:00', 'Sampleton, Exampleville, AU'),
      scan('76', 'HANDED OVER TO PARTNER CARRIER', '11:30:00', 'Sampleton, AU'),
      // The same wording at the same minute in two different places is two scans.
      scan('75', 'PROCESSED AT TRANSIT FACILITY', '09:00:00', 'Otherton, AU'),
      scan('75', 'PROCESSED AT TRANSIT FACILITY', '09:00:00', 'Elsewhere, AU'),
    ] });
    const result = parseDHLEcommerceWebtrackResponse(payload, NUMBER);
    expect(result).toMatchObject({ current_stage: 'in_transit', delivery_carrier: 'dai-post', delivery_tracking_number: '00399999999999999999999' });
    expect(result.events?.map((event) => [event.description, event.location, event.stage])).toEqual([
      ['CLEARED CUSTOMS', 'Sampleton, Exampleville, AU', 'in_transit'],
      ['HANDED OVER TO PARTNER CARRIER', 'Sampleton, Exampleville, AU', 'in_transit'],
      ['PROCESSED AT TRANSIT FACILITY', 'Otherton, AU', 'in_transit'],
      ['PROCESSED AT TRANSIT FACILITY', 'Elsewhere, AU', 'in_transit'],
    ]);
    // A code it does not list is read with its link; without one, no partner is named.
    Object.assign(payload.packages[0]!, { dspName: 'NEW_PARTNER', dspUrl: 'https://daipost.com/track?tracknbr=00399999999999999999999' });
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER)).toMatchObject({ delivery_carrier: 'dai-post' });
    Object.assign(payload.packages[0]!, { dspUrl: '' });
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER)).not.toHaveProperty('delivery_carrier');
  });

  it('cleans delivery signatures and excludes delivered estimates', () => {
    const payload = webtrack(); payload.packages[0]!.status = 'Delivered';
    payload.packages[0]!.events[0]!.primaryEventDescription = 'Delivered to PRIVATE SIGNATORY';
    const result = parseDHLEcommerceWebtrackResponse(payload, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', delivered_at: '2026-09-09T03:40:17.000Z', expected_delivery: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('rejects mismatched, ambiguous and malformed histories instead of triggering a browser', async () => {
    const base = webtrack(); const parcel = base.packages[0]!;
    const cases = [ {}, { ...base, packages: [{ ...parcel, trackedValue: '33870000000000002' }] },
      { ...base, total: 2, packages: [parcel, parcel] }, { ...base, total: 2 }, { ...base, offset: 1 },
      { ...base, total: 0 }, { ...base, packages: [{ ...parcel, events: [{}] }, parcel] },
      { ...base, errors: [{ message: 'Unavailable' }] }, { ...base, packages: [{ ...parcel, tmiUid: '' }] },
      { ...base, packages: [{ ...parcel, events: [null] }] }, { ...base, packages: [{ ...parcel, status: '' }] },
    ];
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    for (const payload of cases) {
      const tracker = new DHLEcommerceTracker({ fetcher: vi.fn(async () => reply(payload)) });
      await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    }
    expect(browser).not.toHaveBeenCalled();
  });

  it('posts one anonymous lookup and finishes without Chromium when native history is available', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.dhlecs.com/webtrack/v4/tracking');
      expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ trackedValue: NUMBER, offset: 0, locale: 'en-US' }) });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return reply(webtrack());
    });
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    const steps: string[] = [];
    const result = await new DHLEcommerceTracker({ fetcher, recorder: { step: ({ step }) => steps.push(step), lookup: () => {} } }).fetch(NUMBER);
    expect(result.events).toHaveLength(3); expect(fetcher).toHaveBeenCalledOnce();
    expect(browser).not.toHaveBeenCalled(); expect(steps).toEqual(['direct']);
  });

  it('recognizes native history and clean regional misses without invoking a browser', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    const fetcher = vi.fn(async () => reply(webtrack()));
    const tracker = new DHLEcommerceTracker({ fetcher });
    await expect(tracker.recognize(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T03:40:17.000Z' });
    fetcher.mockImplementation(async () => reply(EMPTY_WEBTRACK));
    await expect(tracker.recognize(NUMBER)).resolves.toEqual({ known: false });
    await expect(tracker.recognize('invalid!')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(browser).not.toHaveBeenCalled();
  });

  it('preserves outage, challenge and malformed answers during recognition', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    for (const status of [403, 404, 410, 429, 503]) {
      const tracker = new DHLEcommerceTracker({ fetcher: vi.fn(async () => reply({}, status)) });
      await expect(tracker.recognize(NUMBER)).rejects.toBeInstanceOf(Error);
    }
    const tracker = new DHLEcommerceTracker({ fetcher: vi.fn(async () => reply({ packages: [] })) });
    await expect(tracker.recognize(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(browser).not.toHaveBeenCalled();
  });

  it('retains the global route for an identified package with no regional history', async () => {
    const payload = webtrack(); payload.packages[0]!.events = [];
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockImplementation(async (_options, _spec, parse) => parse(shipment()));
    await expect(new DHLEcommerceTracker({ fetcher: vi.fn(async () => reply(payload)) }).fetch(NUMBER)).resolves.toMatchObject({ status: 'in_transit' });
    expect(browser).toHaveBeenCalledOnce();
  });

  it('uses the independent global route when the regional API is unavailable', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockImplementation(async (_options, _spec, parse) => parse(shipment()));
    const cases = [
      vi.fn(async () => reply({}, 503)),
      vi.fn(async () => { throw new Error('Network unavailable'); }),
    ];
    for (const fetcher of cases) {
      await expect(new DHLEcommerceTracker({ fetcher }).fetch(NUMBER)).resolves.toMatchObject({ status: 'in_transit', events: expect.any(Array) });
      expect(fetcher).toHaveBeenCalledOnce();
    }
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it('does not spend a browser attempt on a regional rate limit', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    await expect(new DHLEcommerceTracker({ fetcher: vi.fn(async () => reply({}, 429)) }).fetch(NUMBER)).rejects.toMatchObject({ status: 429 });
    expect(browser).not.toHaveBeenCalled();
  });

  it('passes the recognition budget and cancellation to its only HTTP request', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
    });
    const controller = new AbortController();
    const recognition = new DHLEcommerceTracker({ fetcher }).recognize(NUMBER, { signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(recognition).rejects.toMatchObject({ kind: 'transport' });
    await expect(new DHLEcommerceTracker({ fetcher }).recognize(NUMBER, { budgetMs: 5 })).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('DHL eCommerce USPS routing barcodes', () => {
  // A synthetic 9261 PIC with its check digit, behind a made-up ZIP code.
  const PIC = '9261290000000012345677';
  const BARCODE = `42000000${PIC}`;
  function routed() {
    const payload = webtrack();
    Object.assign(payload.packages[0]!, { trackedValue: PIC, trackingId: BARCODE, deliveryConfirmationNumber: PIC });
    return payload;
  }

  it('asks Webtrack for the package identifier and reports it, never the ZIP code', async () => {
    for (const raw of [BARCODE, `420 00000 ${PIC}`, `420000000000${PIC}`]) expect(normalizeDHLEcommerceNumber(raw)).toBe(PIC);
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ trackedValue: PIC, offset: 0, locale: 'en-US' }));
      return reply(routed());
    });
    const tracker = new DHLEcommerceTracker({ fetcher });
    const result = await tracker.fetch(BARCODE);
    expect(result).toMatchObject({ status: 'in_transit', canonical_tracking_number: PIC });
    expect(JSON.stringify(result)).not.toContain(BARCODE);
    expect(await tracker.fetch(PIC)).not.toHaveProperty('canonical_tracking_number');
    await expect(tracker.recognize(BARCODE)).resolves.toMatchObject({ known: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('opens the global page with the package identifier after a regional miss', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockImplementation(async (_options, spec, parse) => {
      expect(spec.url).toBe(dhlEcommerceTrackingUrl(PIC));
      expect(spec.responseUrl).toContain(`trackingNumber=${PIC}&`);
      return parse(shipment());
    });
    const tracker = new DHLEcommerceTracker({ executablePath: '/test/chromium', fetcher: vi.fn(async () => reply(EMPTY_WEBTRACK)) });
    await expect(tracker.fetch(BARCODE)).resolves.toMatchObject({ canonical_tracking_number: PIC });
    // The result recognition lends the lookup names it too.
    await expect(tracker.recognizeWithBrowser(BARCODE)).resolves.toMatchObject({ known: true, result: { canonical_tracking_number: PIC } });
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it('sends no number shorter than its own identifiers, which can name another shipper\'s package', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    const fetcher = vi.fn(async () => reply(routed()));
    const tracker = new DHLEcommerceTracker({ executablePath: '/test/chromium', fetcher });
    for (const raw of ['1234567', '123456789', 'AB-1234-567']) {
      expect(() => normalizeDHLEcommerceNumber(raw)).toThrow('tracking number is invalid');
      await expect(tracker.fetch(raw)).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(tracker.recognize(raw)).resolves.toEqual({ known: false });
    }
    expect(normalizeDHLEcommerceNumber('1234567890')).toBe('1234567890');
    expect(fetcher).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
  });

  it('sends no routing barcode without a single package identifier', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    const fetcher = vi.fn(async () => reply(routed()));
    const tracker = new DHLEcommerceTracker({ executablePath: '/test/chromium', fetcher });
    // A wrong check digit, and a ZIP+4 whose 26-digit reading fits as well as the PIC after it.
    for (const raw of [`42000000${PIC.slice(0, -1)}8`, `420000009300${PIC}`]) {
      expect(() => normalizeDHLEcommerceNumber(raw)).toThrow('single package identifier');
      await expect(tracker.fetch(raw)).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(tracker.recognize(raw)).resolves.toEqual({ known: false });
      await expect(tracker.recognizeWithBrowser(raw)).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
  });
});
