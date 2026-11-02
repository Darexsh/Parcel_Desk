import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GOGO_XPRESS_API, GogoXpressTracker } from './adapter.js';
import { gogoXpressRemark, normalizeGogoXpressNumber, parseGogoXpress } from './parser.js';
import { gogoXpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'ZXQA-0000-0001';
const IN_TRANSIT = 'ZXQA-0000-0002';
const UNKNOWN = 'ZXQA-0000-0009';

type Row = Record<string, unknown>;
type Shipment = Row & { events: Record<string, Row[]> };
type Reply = { data: { attributes: Shipment } };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
const changed = (name: string, change: (shipment: Shipment, body: Reply) => void) => {
  const body = fixture(name);
  change(body.data.attributes, body);
  return body;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const scan = (status: string, at: string, extra: Row = {}) => ({ status, status_id: '0000', created_at: at, remarks: null, agent: null,
  hubs: null, failure_reason: null, photo: null, signature: null, status_updated_at: at, status_name: null, ...extra });

describe('GoGo Xpress HTTP adapter', () => {
  it('asks the tracker’s lookup for the number in capitals with its hyphens, once, through the supplied transport', async () => {
    const fetcher = answering(() => reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GogoXpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zxqa 0000 0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${GOGO_XPRESS_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gogo-xpress', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel newest first at Manila’s offset, with the hub that scanned it', () => {
    const result = parseGogoXpress(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-04T15:42:10+08:00', expected_delivery: null,
      delivered_at: '2026-03-04T15:42:10+08:00' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location ?? null, event.description])).toEqual([
      ['2026-03-04T15:42:10+08:00', 'delivered', 'delivered', null, 'Delivered'],
      ['2026-03-04T13:05:44+08:00', 'out_for_delivery', 'out_for_delivery', null, 'Out for delivery'],
      // The partner's relayed wording names the person met, so only the status stays.
      ['2026-03-04T11:20:00+08:00', 'failed_delivery', 'failed_attempt', null, 'Failed delivery'],
      ['2026-03-04T07:55:18+08:00', 'out_for_delivery', 'out_for_delivery', null, 'Out for delivery'],
      // A partner's scan takes the clock it happened at, not the later one GoGo Xpress recorded it at.
      ['2026-03-04T00:40:31+08:00', 'in_transit', 'in_transit', null, 'In transit: FORWARDED TO SAMPLE DELIVERY TEAM'],
      ['2026-03-03T21:15:02+08:00', 'in_transit', 'in_transit', null, 'In transit: RECEIVED AT SAMPLE PARTNER EXCHANGE'],
      ['2026-03-03T10:31:09+08:00', 'for_transfer', 'in_transit', 'sample city hub', 'For transfer: Via land: For transfer to partner'],
      ['2026-03-03T08:12:40+08:00', 'received_at_delivery_hub', 'in_transit', 'sample city hub', 'Received at delivery hub: Ready for delivery'],
      ['2026-03-02T21:47:56+08:00', 'in_transit', 'in_transit', 'sample hub', 'In transit: Via land: For transfer to delivery area : SAMPLE CITY HUB'],
      ['2026-03-02T19:02:13+08:00', 'in_transit', 'in_transit', 'sample hub', 'In transit: For transfer to delivery area'],
      ['2026-03-02T16:20:44+08:00', 'received_at_pickup_hub', 'in_transit', 'sample hub', 'Received at pickup hub: Received by SAMPLE HUB'],
      ['2026-03-02T12:14:05+08:00', 'picked_up', 'accepted', 'sample hub', 'Picked up: Package successfully picked up'],
      ['2026-03-02T10:58:30+08:00', 'out_for_pickup', 'registered', 'sample hub', 'Out for pickup: Rider is out for pickup'],
      ['2026-03-02T09:39:47+08:00', 'pickup_rider_found', 'registered', 'sample hub', 'Pickup rider found'],
      ['2026-03-02T09:05:11+08:00', 'for_pickup', 'registered', null,
        'Booking Confirmed: Item/s will be picked up on 02 Mar 2026, Mon. Please prepare your shipment to avoid delays.'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
  });

  it('keeps no rider, person met, proof of delivery, item or cash to collect', () => {
    const result = JSON.stringify([parseGogoXpress(fixture('delivered'), DELIVERED), parseGogoXpress(fixture('in-transit'), IN_TRANSIT)]);
    expect(result).not.toMatch(/Sample (?:Rider|Courier|Person|Item|Gadget)|0900000000|0917|example\.invalid|450|1299|POSTED|ASPER|Consignee|New pickup date|<br/i);
  });

  it('reads a parcel on its way with its estimate, once per repeated scan, with the carrier’s masked remark', async () => {
    const result = await carrier(answering(() => reply(text('in-transit')))).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In transit: Via roro: For transfer to SAMPLE ISLAND HUB', last_update: '2026-03-12T09:31:27+08:00',
      expected_delivery: '2026-03-13' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events).toHaveLength(9);
    expect(result.events!.filter((event) => event.provider_code === 'received_at_pickup_hub')).toHaveLength(1);
    expect(result.events!.at(-2)).toEqual({ time: '2026-03-10T11:16:50+08:00', provider_code: 'for_pickup', stage: 'registered',
      stage_source: 'carrier_map', description: 'Ready for pickup: Pickup unsuccessful due to: rider unavailability.' });
    // The page's estimate is a weekday and a date; one that does not read as such is left out.
    for (const [eta, expected] of [['2026-03-13', '2026-03-13'], ['Thu, Mar 13, 2026', null], ['soon', null], [null, null]] as const) {
      expect(parseGogoXpress(changed('in-transit', (shipment) => { shipment.estimated_delivery_date = eta; }), IN_TRANSIT).expected_delivery, String(eta))
        .toBe(expected);
    }
  });

  it('takes the shipment’s own code for a cancellation, a claim or a return, and hides claim scans as the page does', () => {
    const canceled = parseGogoXpress(changed('in-transit', (shipment) => {
      shipment.status = 'canceled';
      shipment.events.canceled = [scan('canceled', '2026-03-12 23:36:54.620202+08', { status_name: 'Canceled', remarks: 'Buyer requested to cancel transaction.' })];
    }), IN_TRANSIT);
    expect(canceled).toMatchObject({ status: 'exception', current_stage: 'exception', expected_delivery: null,
      last_status_text: 'Canceled: Buyer requested to cancel transaction.', last_update: '2026-03-12T23:36:54+08:00' });
    const lost = parseGogoXpress(changed('in-transit', (shipment) => {
      shipment.status = 'lost';
      shipment.events.disposition = [scan('lost', '2026-03-13 10:00:00+08', { status_name: 'Lost', remarks: 'Internal note' })];
    }), IN_TRANSIT);
    expect(lost).toMatchObject({ current_stage: 'exception', current_stage_source: 'carrier_map', expected_delivery: null,
      last_update: '2026-03-12T09:31:27+08:00' });
    expect(JSON.stringify(lost)).not.toMatch(/Internal note|"lost"/);
    const returned = parseGogoXpress(changed('in-transit', (shipment) => {
      shipment.status = 'returned';
      shipment.events.returns = [scan('return_in_transit', '2026-03-14 08:00:00+08', { status_name: 'Return in transit' }),
        scan('returned', '2026-03-16 15:00:00+08', { status_name: 'Returned', remarks: 'Parcel received by Shipper Sample Person' })];
    }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned', expected_delivery: null });
    expect(returned).not.toHaveProperty('delivered_at');
  });

  it('reads the tracker’s 400 “Order Not Found” as not found, and a recognition of it as unknown', async () => {
    await expect(carrier(answering(() => reply(text('not-found'), { status: 400 }))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseGogoXpress(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(() => reply(text('not-found'), { status: 400 }))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(answering(() => reply(text('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T07:42:10.000Z' });
    // A shape GoGo Xpress does not issue is unknown without a request.
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('ZXQA-0000-001')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a shipment for another number', () => {
    expect(() => parseGogoXpress(fixture('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const number of ['ZXQA-0000-001', 'ZXQA-0000-00011', 'ZXQA-0000']) {
      expect(() => parseGogoXpress(changed('delivered', (shipment) => { shipment.tracking_number = number; }), DELIVERED), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // The same number written without hyphens or in lower case is the shipment asked for.
    expect(parseGogoXpress(changed('delivered', (shipment) => { shipment.tracking_number = 'zxqa00000001'; }), DELIVERED).events).toHaveLength(15);
  });

  it('refuses a malformed reply, and reads a shipment without scans as no history', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Partial<Reply>).data; },
      (_shipment: Shipment, body: Reply) => { (body.data as Row).attributes = 'shipment'; },
      (shipment: Shipment) => { delete shipment.tracking_number; },
      (shipment: Shipment) => { shipment.events = 'events' as never; },
      (shipment: Shipment) => { shipment.events.booked = 'scans' as never; },
      (shipment: Shipment) => { shipment.events.booked = Array.from({ length: 501 }, () => shipment.events.booked![0]!); },
      (shipment: Shipment) => { shipment.events.booked![0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.events.booked![0]!.status = 7; },
      (shipment: Shipment) => { shipment.events.booked![0]!.status = 'Picked Up!'; },
      (shipment: Shipment) => { shipment.events.booked![0]!.status_name = ['Picked up']; },
      (shipment: Shipment) => { shipment.events.booked![0]!.remarks = { text: 'Picked up' }; },
      (shipment: Shipment) => { shipment.events.on_the_way![0]!.hubs = 'sample hub'; },
      // Every clock carries its offset; one without, or one that is not a date, is a changed reply.
      (shipment: Shipment) => { shipment.events.booked![0]!.status_updated_at = '2026-03-02 09:05:11'; },
      (shipment: Shipment) => { shipment.events.booked![0]!.status_updated_at = '2026-02-30 09:05:11+08'; },
      (shipment: Shipment) => { shipment.events.booked![0]!.status_updated_at = '2026-03-02 24:00:00+08'; },
      (shipment: Shipment) => { shipment.events.booked![0]!.status_updated_at = '02/03/2026 09:05+08'; },
      (shipment: Shipment) => { shipment.events.booked![0]!.status_updated_at = undefined; shipment.events.booked![0]!.created_at = undefined; },
      (shipment: Shipment) => { shipment.status = 7; },
    ]) {
      expect(() => parseGogoXpress(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, 'text', {}, { data: null }, { status: 400, error: { detail: 'Invalid request' } }]) {
      expect(() => parseGogoXpress(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A scan without its own clock takes the one it was recorded at, and one without a name its code.
    const fallback = parseGogoXpress(changed('delivered', (shipment) => {
      shipment.events.booked![0]!.status_updated_at = null;
      shipment.events.delivered![0]!.status_name = null;
    }), DELIVERED);
    expect(fallback.events!.at(-1)).toMatchObject({ time: '2026-03-02T09:05:11+08:00' });
    expect(fallback.events![0]).toMatchObject({ description: 'Delivered' });
    expect(() => parseGogoXpress(changed('delivered', (shipment) => {
      shipment.events = { pending: [], booked: [], on_the_way: [], delivered: [] };
    }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE, { status: 400, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('{"message":"Forbidden"}', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('{"message":"Too Many Requests"}', { status: 429, headers: { 'Retry-After': '120' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    // API Gateway's answer for a route it does not have is a moved route, as are a redirect and a 404.
    await expect(lookup(() => reply('{"message":"Missing Authentication Token"}', { status: 403 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 301, headers: { Location: 'https://app.gogoxpress.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('{"message":"Not Found"}', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    // A 400 without the tracker's own message is not a missing parcel.
    await expect(lookup(() => reply('{"status":400,"code":"BAD_REQUEST","error":{"detail":"Invalid tracking number"}}', { status: 400 })))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply('<html><body>Internal Server Error</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply('{"message":"Internal server error"}', { status: 502 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => reply('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('drops who took, refused or reported the parcel, and phone numbers, from a remark', () => {
    expect(gogoXpressRemark('delivered', 'Parcel received by Authorized Receiver Sample')).toBe('');
    expect(gogoXpressRemark('failed_delivery', 'POSTED STATUS : CONSIGNEE OUT ASPER SAMPLE PERSON /')).toBe('');
    // The page's masked wording replaces the remark, and stays.
    expect(gogoXpressRemark('failed_delivery', 'POSTED STATUS : CONSIGNEE OUT ASPER SAMPLE PERSON /', 'Delivery unsuccessful due to: recipient unavailable'))
      .toBe('Delivery unsuccessful due to: recipient unavailable');
    expect(gogoXpressRemark('in_transit', 'POSTED STATUS : SAMPLE')).toBe('');
    expect(gogoXpressRemark('in_transit', 'RECEIVED AT SAMPLE HUB AS PER SAMPLE PERSON')).toBe('RECEIVED AT SAMPLE HUB');
    expect(gogoXpressRemark('in_transit', 'Package handed over, received by Sample Person')).toBe('Package handed over');
    expect(gogoXpressRemark('received_at_pickup_hub', 'Received by NORTH SAMPLE CENTER')).toBe('Received by NORTH SAMPLE CENTER');
    expect(gogoXpressRemark('out_for_delivery', 'Rider will call +63 917 000 0000 first')).toBe('Rider will call first');
    expect(gogoXpressRemark('for_pickup', 'Picked up on 02 Mar 2026, Mon.<br/>Please prepare.')).toBe('Picked up on 02 Mar 2026, Mon. Please prepare.');
  });

  it('asks once more when GoGo Xpress cannot be reached, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new GogoXpressTracker({ fetcher: flaky, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects what is not a GoGo Xpress number, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'ZXQA-0000-001', 'ZXQA-0000-00011', '0000-0000-0001', 'ZXQA_0000_0001', `ZXQA-${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGogoXpressNumber('zxqa00000001')).toBe(DELIVERED);
    expect(normalizeGogoXpressNumber(' zxqa 0000 0001 ')).toBe(DELIVERED);
    expect(normalizeGogoXpressNumber('1234-5678-ABCD')).toBe('1234-5678-ABCD');
  });

  it('answers a number filed under GoGo Xpress, detected in its printed form, or opened from its tracker’s address', async () => {
    const fetcher = answering(() => reply(text('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'gogo-xpress' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'gogo-xpress', source: 'gogo-xpress', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ carrier: 'gogo-xpress', source: 'gogo-xpress' });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${GOGO_XPRESS_API}${DELIVERED}`)).toBe(true);
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'gogo-xpress', confidence: 'high' });
    expect(parseTrackingInput(`https://app.gogoxpress.com/track/${DELIVERED}`)).toMatchObject({ carrier: 'gogo-xpress' });
  });
});

describe('GoGo Xpress status vocabulary', () => {
  it('maps every code recorded for the tracker to its stage', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(gogoXpressStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'gogo-xpress', providerCode: 'for_transfer', description: 'For transfer: Via land: For transfer to partner' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'gogo-xpress', providerCode: 'xyzzy', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared rules on its name.
    expect(gogoXpressStage('posted_delivery', 'Delivered')).toMatchObject({ stage: 'delivered' });
    expect(gogoXpressStage('xyzzy', 'Xyzzy')).toBeNull();
  });
});
