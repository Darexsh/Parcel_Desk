import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, APPLE_EXPRESS_API, appleExpressOrdersUrl, appleExpressOrderUrl, AppleExpressTracker } from './adapter.js';
import { appleExpressOrderFor, normalizeAppleExpressNumber, parseAppleExpress } from './parser.js';
import { appleExpressStage, appleExpressStateStage, isAppleExpressNotice, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const ORDER = '12345679';
const REFERENCE = 'APPL1234067890124';
const LISTED = '123456789';
const CAINIAO = 'CACAINIAO12345678901';
const UNKNOWN = '00000000';

type Row = Record<string, unknown>;
type Reply = { orderDetails: Row; statusDetails: Row[]; screenDetails: Row };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const listed = (reference: string, order: string) => [{ reference, appleTrackingNumber: order, currentStatus: 'Delivered', isECommerce: true }];
// The service's answers by address: an order reply, or the list of orders a reference names.
const service = (replies: Record<string, unknown>): typeof fetch => async (input) => {
  const url = String(input);
  return Object.hasOwn(replies, url) ? reply(replies[url]) : reply(fixture('not-found'));
};
// Imperva's block page, as it stands in for a reply.
const IMPERVA = '<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW">'
  + '<script src="/_Incapsula_Resource?SWJIYLWA=synthetic"></script></head><body>Incapsula incident ID: 0-0</body></html>';

describe('Apple Express HTTP adapter', () => {
  it('asks the tracking page’s order lookup for the whole order number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AppleExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1234 5679 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${APPLE_EXPRESS_API}/order/${ORDER}/language/en`);
    expect(appleExpressOrderUrl(ORDER)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'apple-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('opens a reference through the one order the list names for it, and gives that order’s number', async () => {
    const fetcher = vi.fn<typeof fetch>(service({
      [appleExpressOrdersUrl(CAINIAO)]: fixture('orders'),
      [appleExpressOrderUrl(LISTED)]: fixture('in-transit'),
    }));
    await expect(carrier(fetcher).track({ number: CAINIAO.toLowerCase() }))
      .resolves.toMatchObject({ current_stage: 'in_transit', canonical_tracking_number: LISTED });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${APPLE_EXPRESS_API}/trackmultiple/${CAINIAO}/language/en`, `${APPLE_EXPRESS_API}/order/${LISTED}/language/en`,
    ]);
    const shipper = vi.fn<typeof fetch>(service({
      [appleExpressOrdersUrl(REFERENCE)]: listed(REFERENCE, ORDER),
      [appleExpressOrderUrl(ORDER)]: fixture('delivered'),
    }));
    await expect(carrier(shipper).track({ number: REFERENCE }))
      .resolves.toMatchObject({ current_stage: 'delivered', canonical_tracking_number: ORDER });
    expect(shipper).toHaveBeenCalledTimes(2);
  });

  it('keeps the reply’s order and wall clocks, reads a named zone as an instant, and drops what the page keeps private', () => {
    const result = parseAppleExpress(fixture('delivered'), ORDER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-12T14:06:30', expected_delivery: null });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result).not.toHaveProperty('history_truncated');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location ?? null, event.description,
      event.stage ?? null, event.stage_source ?? null])).toEqual([
      // A notification keeps the stage of the scan before it, without being evidence of it.
      ['2026-03-12T14:06:30', 'Sampleville, BC', 'Delivery Notification Sent', 'delivered', 'none'],
      ['2026-03-12T14:05:41', 'Sampleville, BC', 'Delivered', 'delivered', 'carrier_map'],
      ['2026-03-12T08:32:02', 'Sampleville, BC', 'Pending Delivery Notification Sent', 'out_for_delivery', 'none'],
      ['2026-03-12T08:31:10-07:00', 'Sampleville, BC', 'Out for Delivery', 'out_for_delivery', 'carrier_map'],
      ['2026-03-11T19:45:12', 'Sampleville, BC', 'Exception - No Buzz Code', 'failed_attempt', 'carrier_map'],
      ['2026-03-11T09:15:00', 'Sampleville, BC', 'Out for Delivery', 'out_for_delivery', 'carrier_map'],
      // The depot's arrival reads later than its next scan, which the reply lists above it.
      ['2026-03-10T15:52:46', 'Demoburg, BC', 'Parcel Received, Out for Delivery Soon', 'in_transit', 'carrier_map'],
      ['2026-03-10T17:49:18', 'Demoburg, BC', 'Package Arrived', 'in_transit', 'carrier_map'],
      ['2026-03-08T15:47:06', null, 'Delivery Instructions Added', 'in_transit', 'none'],
      // The repeated row appears once, and the place with a postcode is not kept.
      ['2026-03-06T21:38:07', null, 'In Transit', 'in_transit', 'carrier_map'],
      ['2026-03-06T21:07:09', null, 'Package Processed', 'accepted', 'carrier_map'],
      ['2026-03-06T19:31:24', null, 'Waiting for Parcel', 'registered', 'carrier_map'],
    ]);
    expect(result.events!.filter((event) => event.time).map((event) => event.description)).toEqual(['Out for Delivery']);
    expect(result.events!.every((event) => !(event.time && event.local_time))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/A0A|buzzer|example\.com|EXAMPLETON|SAMPLEVILLE|9 AM|Proof|statusIconId|\.12/);
  });

  it('reads a parcel on its way with its estimate, and an instant in Eastern time', () => {
    const result = parseAppleExpress(fixture('in-transit'), CAINIAO, LISTED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'En Route to Destination Sort Facility', last_update: null, last_update_local: '2026-04-24T15:47:06',
      expected_delivery: '2026-04-29', canonical_tracking_number: LISTED });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location ?? null, event.stage, event.stage_source])).toEqual([
      ['2026-04-24T15:47:06', null, 'in_transit', 'none'],
      ['2026-04-23T21:38:07-04:00', null, 'in_transit', 'carrier_map'],
      ['2026-04-23T21:07:09', 'Exampleton, ON', 'accepted', 'carrier_map'],
      ['2026-04-22T18:21:45', null, 'registered', 'carrier_map'],
    ]);
    // A newest row in a named zone dates the update.
    expect(parseAppleExpress(changed('in-transit', (body) => { body.statusDetails.shift(); }), CAINIAO))
      .toMatchObject({ last_update: '2026-04-23T21:38:07-04:00' });
    expect(parseAppleExpress(changed('in-transit', (body) => { body.statusDetails.shift(); }), CAINIAO)).not.toHaveProperty('last_update_local');
    const without = (text: unknown) => parseAppleExpress(changed('in-transit', (body) => { body.orderDetails.statusChangeText = text; }), CAINIAO);
    expect(without('Estimated Delivery: To Be Determined').expected_delivery).toBeNull();
    expect(without(null).expected_delivery).toBeNull();
    expect(without('Estimated Delivery: May 2, 2026').expected_delivery).toBe('2026-05-02');
  });

  it('stages the order by its state where that says more, else by its current status, else by its newest scan', () => {
    const order = (change: (body: Reply) => void) => parseAppleExpress(changed('in-transit', change), CAINIAO);
    expect(order((body) => { body.orderDetails.statusId = 7; body.orderDetails.currentStatus = 'Cancelled'; }))
      .toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', expected_delivery: '2026-04-29' });
    expect(order((body) => { body.orderDetails.statusId = 14; }))
      .toMatchObject({ current_stage: 'returned', expected_delivery: null });
    expect(order((body) => { body.orderDetails.statusId = 29; })).toMatchObject({ current_stage: 'exception' });
    expect(order((body) => { body.orderDetails.statusId = null; body.orderDetails.currentStatus = 'Out for Delivery'; }))
      .toMatchObject({ current_stage: 'out_for_delivery' });
    // A notice as the current status moves nothing: the newest scan gives the stage.
    expect(order((body) => { body.orderDetails.currentStatus = 'Delivery Instructions Added'; }))
      .toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Delivery Instructions Added' });
    expect(order((body) => { body.orderDetails.currentStatus = 'Synthetic note'; }))
      .toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note' });
    expect(order((body) => { body.orderDetails.currentStatus = null; }))
      .toMatchObject({ current_stage: 'in_transit', last_status_text: 'Delivery Instructions Added' });
    // Wording the map does not know falls to the shared rules, and a row they cannot read has no stage.
    const unread = order((body) => {
      body.orderDetails.currentStatus = null;
      body.statusDetails = [{ ...body.statusDetails[3]!, status: 'Synthetic note' }];
    });
    expect(unread).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note' });
    expect(unread).not.toHaveProperty('current_stage');
    expect(unread.events![0]).not.toHaveProperty('stage');
    expect(order((body) => { body.statusDetails.unshift({ ...body.statusDetails[0]!, status: 'Package delivered to customer' }); }).events![0])
      .toMatchObject({ stage: 'delivered', stage_source: 'wording:language' });
  });

  it('marks a history cut to its newest scans', () => {
    const result = parseAppleExpress(changed('in-transit', (body) => {
      body.statusDetails = Array.from({ length: 101 }, (_, index) => ({ ...body.statusDetails[1]!,
        generatedAt: `2026-04-${String(1 + Math.floor(index / 24)).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00` }));
    }), CAINIAO);
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
  });

  it('opens a reference only when the list names one order under the whole reference', () => {
    expect(appleExpressOrderFor(fixture('orders'), CAINIAO)).toBe(LISTED);
    expect(appleExpressOrderFor([...listed(CAINIAO.toLowerCase(), LISTED), ...listed(CAINIAO, LISTED)], CAINIAO)).toBe(LISTED);
    expect(() => appleExpressOrderFor([], CAINIAO)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => appleExpressOrderFor([...listed(CAINIAO, LISTED), ...listed(CAINIAO, ORDER)], CAINIAO))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Apple Express names several orders for the reference' }));
    expect(() => appleExpressOrderFor(listed('CACAINIAO1234567890', LISTED), CAINIAO))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Apple Express answered for other orders' }));
    expect(() => appleExpressOrderFor(Array.from({ length: 51 }, () => listed(CAINIAO, LISTED)[0]), CAINIAO))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const payload of [{}, 'list', ['row'], [{ reference: CAINIAO }], [{ reference: CAINIAO, appleTrackingNumber: 123456789 }],
      [{ reference: CAINIAO, appleTrackingNumber: 'A123' }], [{ reference: 5, appleTrackingNumber: LISTED }]]) {
      expect(() => appleExpressOrderFor(payload, CAINIAO), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads an unknown number as not found, and an order without scans as no history', () => {
    expect(() => parseAppleExpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAppleExpress(changed('delivered', (body) => { body.statusDetails = []; }), ORDER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseAppleExpress(changed('delivered', (body) => { body.statusDetails = null as never; }), ORDER))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts an order only when it is the one asked', () => {
    expect(() => parseAppleExpress(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Apple Express answered for another order' }));
    expect(() => parseAppleExpress(fixture('in-transit'), ORDER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAppleExpress(fixture('delivered'), 'APPL0000000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A reference's order must also be the one the list named.
    expect(() => parseAppleExpress(fixture('in-transit'), CAINIAO, ORDER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAppleExpress(changed('in-transit', (body) => { body.orderDetails.reference = null; }), CAINIAO, LISTED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseAppleExpress(changed('delivered', (body) => { body.orderDetails.reference = REFERENCE.toLowerCase(); }), REFERENCE, ORDER)
      .canonical_tracking_number).toBe(ORDER);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete (body as Partial<Reply>).orderDetails; },
      (body: Reply) => { body.orderDetails = 'order' as never; },
      (body: Reply) => { body.orderDetails.appleTrackingNumber = 12345679; },
      (body: Reply) => { body.orderDetails.appleTrackingNumber = ''; },
      (body: Reply) => { body.orderDetails.statusId = '9'; },
      (body: Reply) => { body.orderDetails.statusId = 9.5; },
      (body: Reply) => { body.orderDetails.currentStatus = 5; },
      (body: Reply) => { body.orderDetails.statusChangeText = {}; },
      (body: Reply) => { body.statusDetails = 'rows' as never; },
      (body: Reply) => { body.statusDetails = Array.from({ length: 501 }, () => body.statusDetails[0]!); },
      (body: Reply) => { body.statusDetails[0] = 'row' as never; },
      (body: Reply) => { body.statusDetails[0]!.status = ''; },
      (body: Reply) => { body.statusDetails[0]!.status = ['Delivered']; },
      (body: Reply) => { body.statusDetails[0]!.location = { town: 'Sampleville' }; },
      (body: Reply) => { body.statusDetails[0]!.generatedAt = null; },
      (body: Reply) => { body.statusDetails[0]!.generatedAt = '2026-03-12 14:06:30'; },
      (body: Reply) => { body.statusDetails[0]!.generatedAt = '2026-03-12T14:06'; },
      (body: Reply) => { body.statusDetails[0]!.generatedAt = '2026-03-12T24:00:00'; },
      (body: Reply) => { body.statusDetails[0]!.generatedAt = '2026-02-30T14:06:30'; },
      (body: Reply) => { body.statusDetails[0]!.generatedAt = 1_773_324_390_000; },
      (body: Reply) => { body.statusDetails[0]!.generatedAtTimeZone = 5; },
    ]) {
      expect(() => parseAppleExpress(changed('delivered', change), ORDER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of ['reply', [], { orderDetails: null, statusDetails: [] }]) {
      expect(() => parseAppleExpress(payload, ORDER), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check, a quota and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers an unknown number with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.appleexpress.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(IMPERVA, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(IMPERVA, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('API calls quota exceeded! maximum admitted 25 per 1h.', { status: 429,
      headers: { 'Content-Type': 'text/plain', 'Retry-After': '1800' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 1_800_000 });
    await expect(lookup('API calls quota exceeded! maximum admitted 25 per 1h.', { status: 429, headers: { 'Content-Type': 'text/plain' } }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup('<html><title>Apple Express</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ orderDetails: { appleTrackingNumber: null } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks for no order when the list names none for a reference', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply([]));
    await expect(carrier(fetcher).track({ number: CAINIAO })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const several = vi.fn<typeof fetch>().mockResolvedValue(reply([...listed(CAINIAO, LISTED), ...listed(CAINIAO, ORDER)]));
    await expect(carrier(several).track({ number: CAINIAO })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(several).toHaveBeenCalledTimes(1);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: ORDER })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ORDER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known order and the unknown-number answer, and asks nothing for a number Apple Express does not track', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply([]));
    await expect(carrier(fetcher).recognize!(ORDER)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T15:31:10.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(CAINIAO)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ABC123')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Apple Express does not track and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1234567', '1234567890', 'ABCDEFGH', '1234567%', 'APPL123456789012', 'APPL12345678901234',
      'CACAINIAO1234567890', `${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: ORDER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAppleExpressNumber('appl 1234 0678 90124')).toEqual({ number: REFERENCE, kind: 'reference' });
    expect(normalizeAppleExpressNumber(LISTED)).toEqual({ number: LISTED, kind: 'order' });
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('delivered')) }]);
    const answered = carrier(recovered.fetcher).track({ number: ORDER }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(recovered.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: ORDER }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes an order filed under Apple Express, and an APPL reference by its rule, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>(service({
      [appleExpressOrderUrl(ORDER)]: fixture('delivered'),
      [appleExpressOrdersUrl(REFERENCE)]: listed(REFERENCE, ORDER),
    }));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: ORDER, carrier: 'apple-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'apple-express', source: 'apple-express', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: REFERENCE }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'apple-express', source: 'apple-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === appleExpressOrdersUrl(REFERENCE))).toBe(true);
  });
});

describe('Apple Express numbers', () => {
  it('claims APPL references and leaves order numbers and Cainiao references to other rules', () => {
    expect(detectCarrierMatch(REFERENCE)).toMatchObject({ carrier: 'apple-express', confidence: 'high' });
    for (const number of [ORDER, LISTED, CAINIAO]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('apple-express');
    }
  });
});

describe('Apple Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives, and its notices as gaps', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; note?: string }[]) {
      if (entry.code) {
        expect(appleExpressStateStage(Number(entry.code)), entry.wording).toBe(entry.stage);
        continue;
      }
      // The page's summary sentences are not status rows.
      if (entry.note?.startsWith('Summary text')) continue;
      if (!entry.stage) {
        expect(isAppleExpressNotice(entry.wording), entry.wording).toBe(true);
        expect(statusMapAnswer({ carrier: 'apple-express', providerCode: null, description: entry.wording }), entry.wording)
          .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
        continue;
      }
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(appleExpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'apple-express', providerCode: null, description: 'Out for delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'apple-express', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(appleExpressStage('Synthetic note')).toBeNull();
    expect(appleExpressStage('Delivery Exception Notification Sent')).toBeNull();
    expect(appleExpressStateStage(9)).toBeUndefined();
  });
});
