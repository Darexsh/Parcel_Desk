import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { AB_COURIER_API, abCourierLookupBody, AbCourierTracker, adapter } from './adapter.js';
import { normalizeAbCourierNumber, parseAbCourier } from './parser.js';
import { abCourierStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '8000123';
const IN_TRANSIT = '12000456';
const UNKNOWN = '1999999999';

type Row = Record<string, unknown>;
type Reply = Row & { trackingDtl: Row; trackingImages: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
// A fixture with its order changed.
const changed = (name: string, change: (detail: Row, body: Reply) => void) => {
  const body = fixture(name);
  change(body.trackingDtl, body);
  return body;
};
const delivered = (change: (detail: Row, body: Reply) => void) => changed('delivered', change);
const transit = (change: (detail: Row, body: Reply) => void) => changed('in-transit', change);
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of the reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
const events = (result: ReturnType<typeof parseAbCourier>) => result.events!.map((event) => [event.time ?? event.local_time,
  event.description, event.stage ?? null, event.location ?? null]);

describe('A&B Courier HTTP adapter', () => {
  it('posts the whole order number once to the tracking page’s lookup, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AbCourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 12 000 456 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(AB_COURIER_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBe('{"accountNumber":0,"orderNumber":12000456}');
    expect(abCourierLookupBody('12000456')).toBe(init!.body);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ab-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an Ontario delivery’s pickup and delivery in Toronto time, without the signer, driver or boxes', () => {
    const result = parseAbCourier(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Finalized', last_update: '2026-03-09T14:41:00-04:00', expected_delivery: null,
      delivered_at: '2026-03-09T14:41:00-04:00', service_name: '3:00 PM', weight_kg: 5.443, destination_country: 'CA',
      summary_only: true,
      events: [
        { time: '2026-03-09T14:41:00-04:00', location: 'Exampleville, ON', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-03-09T09:05:00-04:00', location: 'Sampleton, ON', description: 'Picked Up', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/J Sample|4321|BOX|10"|2026-03-08/);
  });

  it('reads an order on its way from its pickup, with the picture’s wording and the estimate', () => {
    const result = parseAbCourier(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In Transit', last_update: null, expected_delivery: '2026-10-15T17:00:00-04:00',
      service_name: 'Overnight', weight_kg: 1.588, summary_only: true });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('last_update_local');
    expect(result).not.toHaveProperty('delivery_carrier');
    // The pickup does not date the status after it.
    expect(events(result)).toEqual([['2026-10-14T16:12:00-04:00', 'Picked Up', 'accepted', 'Sampleton, ON']]);
    // The status itself words it without the picture, with its spaces collapsed.
    expect(parseAbCourier(transit((_detail, body) => { body.trackingImages = []; }), IN_TRANSIT).last_status_text)
      .toBe('Picked Up In Transit On Time');
  });

  it('keeps wall clocks for an order that leaves Ontario, and the estimate’s day', () => {
    const result = parseAbCourier(transit((detail) => { detail.deliveryProvince = 'QC'; }), IN_TRANSIT);
    expect(result).toMatchObject({ expected_delivery: '2026-10-15', last_update: null });
    expect(result.events).toEqual([{ local_time: '2026-10-14T16:12:00', location: 'Sampleton, ON', description: 'Picked Up',
      stage: 'accepted', stage_source: 'carrier_map' }]);
    const abroad = parseAbCourier(delivered((detail) => { detail.deliveryCountry = 'USA'; detail.deliveryProvince = 'NY'; }), DELIVERED);
    expect(abroad).toMatchObject({ destination_country: 'US', last_update: null, last_update_local: '2026-03-09T14:41:00' });
    expect(abroad).not.toHaveProperty('delivered_at');
    // An hour the clocks skip in Toronto stays a wall clock.
    const skipped = parseAbCourier(delivered((detail) => { detail.deliveredTime = 'Mar  8 2026  2:30AM'; }), DELIVERED);
    expect(skipped.events![0]).toMatchObject({ local_time: '2026-03-08T02:30:00' });
    expect(skipped.events![0]).not.toHaveProperty('time');
  });

  it('reads an order still to be picked up with its estimate and no clock, and a pickup as its own status', () => {
    const dispatched = parseAbCourier(transit((detail, body) => {
      detail.status = 'Dispatched';
      detail.pickedUpTime = null;
      body.trackingImages = [{ customerDescription: 'Dispatched', trackingImageName: 'TrackingStage1', status: null }];
    }), IN_TRANSIT);
    expect(dispatched).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Dispatched',
      last_update: null, expected_delivery: '2026-10-15T17:00:00-04:00', events: [] });
    // A pickup clock before the pickup is the scheduled one: it is not a scan.
    expect(parseAbCourier(transit((detail) => { detail.status = 'Assigned'; }), IN_TRANSIT).events).toEqual([]);
    const picked = parseAbCourier(transit((detail, body) => { detail.status = 'Picked Up'; body.trackingImages = []; }), IN_TRANSIT);
    expect(picked).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Picked Up',
      last_update: '2026-10-14T16:12:00-04:00' });
    // The database's empty clock is no clock.
    expect(parseAbCourier(transit((detail) => { detail.pickedUpTime = 'Jan  1 1900 12:00AM'; }), IN_TRANSIT).events).toEqual([]);
    expect(parseAbCourier(transit((detail) => { detail.estimatedDeliveryBy = '01/01/1900 00:00:00'; }), IN_TRANSIT).expected_delivery).toBeNull();
  });

  it('stages the statuses after a pickup, a cancellation and a status only the picture’s step places', () => {
    const read = (status: string, step = 'TrackingStage3', wording = '') => parseAbCourier(transit((detail, body) => {
      detail.status = status;
      body.trackingImages = [{ customerDescription: wording, trackingImageName: step, status: null }];
    }), IN_TRANSIT);
    expect(read('Picked Up  Out for Delivery')).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(read('Picked Up  Destination Dock')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Picked Up Destination Dock' });
    const cancelled = read('Cancelled', 'TrackingStage1');
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'exception', expected_delivery: null, events: [] });
    // A status the map does not know: the picture's step, else the shared wording rules, else no stage.
    expect(read('Sample Hold', 'TrackingStage4')).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(read('Refused by consignee', 'TrackingSample')).toMatchObject({ current_stage: 'exception', status: 'exception' });
    const unknown = read('Sample Note', 'TrackingSample');
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Sample Note', events: [] });
    expect(unknown).not.toHaveProperty('current_stage');
    // The picture's wording stages a status the reply writes as "null".
    expect(read('null', '', 'Delivered')).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
    expect(() => read('null', '', '')).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('names the partner the page links to by the driver, with its reference, and none for A&B’s own drivers', () => {
    const partner = (driver: unknown, waybill: unknown, barcodes: unknown = null, status = 'Picked Up  In Transit On Time') => {
      const { delivery_carrier, delivery_tracking_number } = parseAbCourier(transit((detail) => {
        detail.currentDriverNumber = driver;
        detail.waybillNumber = waybill;
        detail.childTrackingBarcodes = barcodes;
        detail.status = status;
      }), IN_TRANSIT);
      return [delivery_carrier ?? null, delivery_tracking_number ?? null];
    };
    expect(partner(910, '0', ' D000000000000001001 ')).toEqual(['canpar', 'D000000000000001001']);
    expect(partner(955, '320000000001')).toEqual(['purolator', '320000000001']);
    expect(partner('903', '320000000001')).toEqual(['purolator', '320000000001']);
    expect(partner(918, '700000000001')).toEqual(['fedex', '700000000001']);
    expect(partner(910, '0', '')).toEqual([null, null]);
    expect(partner(957, '0')).toEqual([null, null]);
    expect(partner(917, null)).toEqual([null, null]);
    expect(partner(917, '7000#0001')).toEqual([null, null]);
    expect(partner(4567, '320000000001')).toEqual([null, null]);
    expect(partner(null, '320000000001')).toEqual([null, null]);
    expect(partner(955, '320000000001', null, 'Cancelled')).toEqual([null, null]);
  });

  it('places events at their town and province, and leaves out a town that looks like a street', () => {
    const at = (change: (detail: Row) => void) => events(parseAbCourier(delivered(change), DELIVERED)).map((event) => event[3]);
    expect(at((detail) => { detail.deliveryCity = '12 Sample St'; })).toEqual(['ON', 'Sampleton, ON']);
    expect(at((detail) => { detail.pickupCity = null; detail.pickupProvince = ''; detail.pickupCountry = ''; }))
      .toEqual(['Exampleville, ON', null]);
  });

  it('reads the not-found answer, and an order only when it is the number asked', () => {
    expect(() => parseAbCourier(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAbCourier(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate',
      message: 'A&B Courier answered for another order' }));
    expect(parseAbCourier(transit((detail) => { detail.orderNo = IN_TRANSIT; }), IN_TRANSIT).current_stage).toBe('in_transit');
    // Another answer of the service is not a missing order.
    expect(() => parseAbCourier({ ...fixture('not-found'), statusCode: 500, statusDescription: 'Sample failure' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAbCourier({ ...fixture('not-found'), statusDescription: 'Sample failure' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAbCourier({ ...fixture('delivered'), statusDescription: 'Partial' }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (detail: Row) => { delete detail.orderNo; },
      (detail: Row) => { detail.orderNo = 12000456.5; },
      (detail: Row) => { detail.orderNo = 'ORDER-1'; },
      (detail: Row) => { detail.status = ['Picked Up']; },
      (detail: Row) => { detail.pickupCity = { name: 'Sampleton' }; },
      (detail: Row) => { detail.pickedUpTime = '2026-10-14T16:12:00'; },
      (detail: Row) => { detail.pickedUpTime = 'Oct 14 2026 16:12PM'; },
      (detail: Row) => { detail.pickedUpTime = 'Feb 30 2026  4:12PM'; },
      (detail: Row) => { detail.pickedUpTime = 'Okt 14 2026  4:12PM'; },
      (detail: Row) => { detail.estimatedDeliveryBy = '10/15/2026 5:00 PM'; },
      (detail: Row) => { detail.estimatedDeliveryBy = '13/15/2026 17:00:00'; },
      (detail: Row) => { detail.currentDriverNumber = 'driver'; },
      (_detail: Row, body: Reply) => { body.trackingImages = 'TrackingStage3' as never; },
      (_detail: Row, body: Reply) => { body.trackingImages = ['TrackingStage3'] as never; },
      (_detail: Row, body: Reply) => { body.trackingDtl = null as never; },
    ]) {
      expect(() => parseAbCourier(transit(change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', null, [], {}, { statusCode: 200 }, { statusDescription: 'Success' }, { statusCode: '2xx', statusDescription: 'Success' }]) {
      expect(() => parseAbCourier(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown order, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html><title>404 - File or directory not found.</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://abcourier.com/CCWebClient/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CHALLENGE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHALLENGE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>ABWebClient Pro</title><app-root></app-root></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ title: 'Synthetic failure' }, { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known order and the not-found answer, and asks nothing for a number A&B does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-09T18:41:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(fetcher).recognize!('123456')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers A&B does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123456', '0123456', '08000123', '2147483648', '12345678901', 'ABCDEFG', '800012X', `8000123${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of ['1000000', '12345678', '123456789', '2147483647']) {
      expect(normalizeAbCourierNumber(number), number).toBe(number);
    }
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

  it('routes an order the caller names A&B’s to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'ab-courier' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ab-courier', source: 'ab-courier', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url, init]) => String(url) === AB_COURIER_API && init?.body === abCourierLookupBody(DELIVERED))).toBe(true);
  });
});

describe('A&B Courier numbers', () => {
  it('leaves order numbers to the caller’s choice, and reads tracking links', () => {
    // Many carriers' references are bare digits, so neither detection nor recognition offers A&B.
    for (const number of [DELIVERED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('ab-courier');
      expect(recognitionAskedCarriers(number), number).not.toContain('ab-courier');
    }
    for (const link of [`https://abcourier.com/CCWebClient/General/TrackingInfo/${DELIVERED}`,
      `https://abcourier.com/tracking-info?tracking-number=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'ab-courier', source: 'link' });
    }
  });
});

describe('A&B Courier status vocabulary', () => {
  it('records every status the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(abCourierStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'ab-courier', providerCode: null, description: 'Picked Up  Out for Delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'ab-courier', providerCode: null, description: 'Sample Note' })).toEqual({ kind: 'unknown' });
    // The map decides over the picture's step.
    expect(abCourierStage('Delivered', 'TrackingStage1')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(abCourierStage('', 'TrackingStage2')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(abCourierStage('Sample Note')).toBeNull();
    expect(abCourierStage('')).toBeNull();
  });
});
