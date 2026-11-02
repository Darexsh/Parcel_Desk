import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, COURIERSPLEASE_API, COURIERSPLEASE_PAGE, CouriersPleaseTracker } from './adapter.js';
import { couriersPleaseToken, couriersPleaseWording, normalizeCouriersPleaseNumber, parseCouriersPlease } from './parser.js';
import { couriersPleaseStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'CPBZZZZ0000014';
const IN_TRANSIT = 'CPBZZZZ0000028';
const ITEM = 'CPBZZZZ0000028001';
const COUPON = '10000000005';
const UNKNOWN = 'CPBZZZZ0000035';

type Row = Record<string, unknown>;
type Entry = { consignmentInfo: Row[]; trakingInfo: { tracker: { track: Row[] | null } }[]; statusInfo: Row };
type Reply = Row & { data: { root: Entry[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const PAGE = readFileSync(new URL('./fixtures/page.html', import.meta.url), 'utf8');
const TOKEN = couriersPleaseToken(PAGE)!;
const SESSION = '__Host-csrf=00000000-0000-4000-8000-000000000000';
const changed = (name: string, change: (entry: Entry, body: Reply) => void) => {
  const body = fixture(name);
  change(body.data.root[0]!, body);
  return body;
};
const page = (init: ResponseInit = {}, body = PAGE) => new Response(body, { ...init, headers: {
  'Content-Type': 'text/html;charset=utf-8', 'Set-Cookie': `${SESSION}; Path=/; HttpOnly; Secure; SameSite=Strict`, ...init.headers } });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
/** A transport that opens the page, then answers the lookup with `lookup`. */
const site = (lookup: () => Response) => vi.fn<typeof fetch>(async (url) => (String(url) === COURIERSPLEASE_PAGE ? page() : lookup()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Azure Front Door's page for a refused request.
const AZURE = '<!DOCTYPE html><html><head><title>Service unavailable</title></head><body><h2>The request is blocked.</h2></body></html>';
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('CouriersPlease HTTP adapter', () => {
  it('opens the tracking page for its session, then asks its lookup for the whole number through the supplied transport', async () => {
    const fetcher = site(() => reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CouriersPleaseTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cpbzzzz 0000028 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(pageUrl).toBe(COURIERSPLEASE_PAGE);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(url).toBe(COURIERSPLEASE_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0', 'Sec-Fetch-Site': 'same-origin', 'csrf-token': TOKEN, Cookie: SESSION,
    } });
    expect(JSON.parse(String(init.body))).toEqual({ trackingCode: IN_TRANSIT });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'couriersplease', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered consignment on local clocks, without the receiver, the driver, the references or the help links', () => {
    const result = parseCouriersPlease(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered with Authority to Leave (ATL)', last_update: null, last_update_local: '2026-03-06T12:05:00',
      expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('weight_kg');
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null, event.location ?? null, event.description]))
      .toEqual([
        ['2026-03-06T12:05:00', 'deliver', 'delivered', 'SA', 'Delivered with Authority to Leave (ATL)'],
        ['2026-03-06T06:56:00', 'accept', 'out_for_delivery', 'SA', 'Onboard for delivery'],
        ['2026-03-05T18:45:00', 'offboard-depot', 'failed_attempt', 'SA', 'Delivery rescheduled for next business day'],
        ['2026-03-05T16:33:00', 'faildeliver', 'exception', 'SA', 'Unable to deliver'],
        ['2026-03-05T07:05:00', 'accept', 'out_for_delivery', 'SA', 'Onboard for delivery'],
        ['2026-03-05T04:01:00', 'deconsolidate', 'in_transit', 'SA', 'Arrived at delivery centre'],
        ['2026-03-03T17:23:00', 'transit', 'in_transit', 'VIC', 'In transit to delivery centre (Melbourne - Adelaide)'],
        ['2026-03-03T16:53:00', 'reweigh', 'in_transit', 'VIC', 'Arrived at facility for processing'],
        ['2026-03-03T15:30:00', 'pickup', 'accepted', 'VIC', 'Your parcel has been picked up'],
        ['2026-03-02T22:01:00', 'futile', 'exception', 'VIC', 'Pickup attempt was unsuccessful. Awaiting rebook confirmation by sender'],
        ['2026-03-02T09:15:00', 'manifest', 'registered', 'VIC', 'Shipment information received'],
      ]);
    expect(result.events!.every((event) => !('time' in event))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample Receiver|driver|SAMPLE-REF|Declared|support\.couriersplease|0901|adelaide\)|Despatched/);
  });

  it('merges the items of a consignment on its way, with the estimate and without the sender’s details after the pickup', () => {
    const result = parseCouriersPlease(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In transit to regional delivery centre', last_update_local: '2026-03-05T08:09:00', expected_delivery: '2026-03-09' });
    // The pickup both items share is kept once; the details the sender sent after it are left out, as on the page.
    expect(result.events!.map((event) => [event.local_time, event.description])).toEqual([
      ['2026-03-05T08:09:00', 'In transit to regional delivery centre'],
      ['2026-03-04T20:00:00', 'In Transit with Couriers Please'],
      ['2026-03-04T17:12:00', 'Arrived at facility for processing'],
      ['2026-03-04T17:10:00', 'Arrived at facility for processing'],
      ['2026-03-04T13:36:00', 'Your parcel has been picked up'],
    ]);
    expect(result.events![1]).toEqual({ local_time: '2026-03-04T20:00:00', description: 'In Transit with Couriers Please',
      provider_code: 'status', stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('reads an item label or a prepaid coupon by its own number, which its first row names', () => {
    const label = changed('in-transit', (entry) => {
      entry.consignmentInfo = [];
      entry.trakingInfo.pop();
      entry.statusInfo.type = 'label';
    });
    expect(parseCouriersPlease(label, ITEM)).toMatchObject({ current_stage: 'in_transit', expected_delivery: null });
    const coupon = parseCouriersPlease(fixture('coupon'), COUPON);
    expect(coupon).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has been collected from Sample Newsagency', last_update_local: '2026-06-24T17:00:00' });
    expect(coupon.events!.map((event) => event.location)).toEqual(['NSW', 'NSW', 'VIC']);
  });

  it('gives no estimate while the sender’s details are all there is', () => {
    const announced = changed('in-transit', (entry) => {
      entry.trakingInfo.pop();
      entry.trakingInfo[0]!.tracker.track = entry.trakingInfo[0]!.tracker.track!.filter((row) => row.nodeType === null || row.nodeType === 'manifest');
    });
    expect(parseCouriersPlease(announced, IN_TRANSIT)).toMatchObject({ status: 'pending', current_stage: 'registered', expected_delivery: null });
  });

  it('skips rows without wording, without a date or the page’s own overdue marker', () => {
    const result = parseCouriersPlease(changed('coupon', (entry) => {
      entry.trakingInfo[0]!.tracker.track!.push(
        { date: '', time: '', action: 'Overdue', nodeType: '', contractor: null, stateName: null, datetime: null },
        { date: '25 Jun 2026', time: '9:00 am', action: 'Overdue', nodeType: null, contractor: null, stateName: null, datetime: null },
        { date: '25 Jun 2026', time: '9:00 am', action: '', nodeType: 'status', contractor: null, stateName: null, datetime: null });
    }), COUPON);
    expect(result.events).toHaveLength(3);
  });

  it('takes markup and the sentence pointing to a link out of the wording', () => {
    expect(couriersPleaseWording('Pickup attempt was unsuccessful <br /> Awaiting rebook confirmation by sender'))
      .toBe('Pickup attempt was unsuccessful. Awaiting rebook confirmation by sender');
    expect(couriersPleaseWording("Unable to deliver - no one home. Book a redelivery. You can book a redelivery <a target=\"_blank\" href=\"/book/redelivery\">here</a>"))
      .toBe('Unable to deliver - no one home. Book a redelivery');
    expect(couriersPleaseWording('Arrived at facility for processing.')).toBe('Arrived at facility for processing');
    expect(couriersPleaseWording('Parcel is ready <div class="x">at the counter</div> &amp; waiting')).toBe('Parcel is ready at the counter & waiting');
    expect(couriersPleaseWording('<a href="/x">Track here</a>')).toBe('Track here');
  });

  it('reads the tracker’s answers for a number it has no rows for as not found', () => {
    expect(() => parseCouriersPlease(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCouriersPlease(fixture('unlisted'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A consignment the tracker names but holds no rows for is known, without a history.
    expect(() => parseCouriersPlease(changed('delivered', (entry) => { entry.trakingInfo = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseCouriersPlease(changed('delivered', (entry) => {
      entry.trakingInfo[0]!.tracker.track = entry.trakingInfo[0]!.tracker.track!.slice(0, 1);
    }), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // The service's refusal of the request itself is no answer about a parcel.
    expect(() => parseCouriersPlease({ responseCode: '400', msg: 'Tracking Code not provided or exceed 10 codes .', data: null }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('counts a reply only when its consignment or an item is the number asked', () => {
    expect(() => parseCouriersPlease(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CouriersPlease answered for another shipment' }));
    expect(() => parseCouriersPlease(fixture('coupon'), '10000000012'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'CouriersPlease answered for another shipment' }));
    expect(parseCouriersPlease(fixture('in-transit'), ITEM).events).toHaveLength(5);
    expect(parseCouriersPlease(changed('in-transit', (entry) => {
      entry.consignmentInfo[0]!.action = IN_TRANSIT.toLowerCase();
    }), IN_TRANSIT).events).toHaveLength(5);
  });

  it('rejects a changed reply', () => {
    const scan = (entry: Entry) => entry.trakingInfo[0]!.tracker.track![1]!;
    for (const change of [
      (_entry: Entry, body: Reply) => { delete (body as Row).data; },
      (_entry: Entry, body: Reply) => { (body as Row).data = { root: 'list' }; },
      (_entry: Entry, body: Reply) => { body.data.root.push(body.data.root[0]!); },
      (_entry: Entry, body: Reply) => { body.data.root = []; },
      (entry: Entry) => { delete (entry as Row).statusInfo; },
      (entry: Entry) => { (entry as Row).consignmentInfo = 'details'; },
      (entry: Entry) => { (entry as Row).trakingInfo = 'items'; },
      (entry: Entry) => { (entry.trakingInfo as unknown[])[0] = 'item'; },
      (entry: Entry) => { (entry.trakingInfo[0]!.tracker as Row).track = 'rows'; },
      (entry: Entry) => { entry.trakingInfo[0]!.tracker.track!.push('row' as never); },
      (entry: Entry) => { entry.trakingInfo[0]!.tracker.track = Array.from({ length: 501 }, () => scan(entry)); },
      (entry: Entry) => { scan(entry).date = '2026-03-02'; },
      (entry: Entry) => { scan(entry).date = '31 Feb 2026'; },
      (entry: Entry) => { scan(entry).time = '17:15'; },
      (entry: Entry) => { scan(entry).time = '13:15 pm'; },
      (entry: Entry) => { scan(entry).action = 7; },
      (entry: Entry) => { scan(entry).stateName = ['VIC']; },
    ]) {
      expect(() => parseCouriersPlease(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', [], {}, null, { data: null }]) {
      expect(() => parseCouriersPlease(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block, a rate limit, a refused session and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit, number = UNKNOWN) => carrier(site(() => reply(body, init))).track({ number });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('unlisted'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.couriersplease.com.au/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(AZURE, { status: 429, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '30' } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(lookup(AZURE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    // The service's refusal of a client it does not take for its own page.
    await expect(lookup({ error: true, statusCode: 403, statusMessage: 'Forbidden: API access is only permitted from the frontend application.' },
      { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ error: true, statusCode: 403, statusMessage: 'CSRF Token Mismatch', message: 'CSRF Cookie not found' }, { status: 403 }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ error: true, statusCode: 400, statusMessage: 'Bad Request' }, { status: 400 })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><title>CouriersPlease</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('reads a refused or broken tracking page apart from a missing parcel', async () => {
    const opened = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(opened(page({ status: 429 }, AZURE))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(opened(page({ status: 403 }, AZURE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(opened(page({}, AZURE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(opened(page({}, CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(opened(page({ status: 301, headers: { Location: 'https://www.couriersplease.com.au/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(opened(page({}, '<html><head><title>Tracking Tools</title></head></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(opened(new Response(PAGE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s from the lookup as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = site(() => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number CouriersPlease does not issue', async () => {
    const answers = [fixture('delivered'), fixture('not-found')];
    const fetcher = site(() => reply(answers.shift()));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-06T12:05:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('CP-1')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects numbers CouriersPlease does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['CP12345', 'SAMPLETRACKING', `CP${'0'.repeat(30)}`, 'CPBZZZZ0000014,CPBZZZZ0000028']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCouriersPleaseNumber('cpbzzzz 000 0014')).toBe(DELIVERED);
    expect(normalizeCouriersPleaseNumber('00000000000000000017')).toBe('00000000000000000017');
  });

  it('tries once more with a new session when the lookup fails to reach CouriersPlease', async () => {
    let lookups = 0;
    const fetcher = site(() => {
      if (lookups++ === 0) throw new TypeError('fetch failed');
      return reply(fixture('delivered'));
    });
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([COURIERSPLEASE_PAGE, COURIERSPLEASE_API, COURIERSPLEASE_PAGE, COURIERSPLEASE_API]);
  });

  it('ends a hanging page inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it('routes a number filed under CouriersPlease to the adapter', async () => {
    const fetcher = site(() => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'couriersplease' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'couriersplease', source: 'couriersplease', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === COURIERSPLEASE_API)).toBe(true);
  });
});

describe('CouriersPlease numbers', () => {
  it('names CouriersPlease for its consignments and leaves coupons and SSCCs to the shapes other carriers share', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'couriersplease' });
    expect(detectCarrierMatch(IN_TRANSIT)).toMatchObject({ carrier: 'couriersplease' });
    expect(detectCarrierMatch(COUPON)?.carrier).not.toBe('couriersplease');
  });
});

describe('CouriersPlease status vocabulary', () => {
  it('records every row kind and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? '';
      if (entry.unmapped) {
        expect(statusMap.stage(code || null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(couriersPleaseStage(code, entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'couriersplease', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(code || null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(couriersPleaseStage(code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    // Wording comes before the kind several outcomes share.
    expect(couriersPleaseStage('faildeliver', 'Delivery attempted - Delivery refused by receiver')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(couriersPleaseStage('faildeliver', 'Unable to deliver - no one home. Book a redelivery')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    // A kind the map does not know falls to its wording, then to the shared rules.
    expect(couriersPleaseStage('synthetic', 'Delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(couriersPleaseStage('status', 'Synthetic note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'couriersplease', providerCode: 'accept', description: 'Onboard for delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'couriersplease', providerCode: 'status', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
