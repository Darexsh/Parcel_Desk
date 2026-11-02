import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CHUKOU1_API, Chukou1Tracker, signChukou1Lookup } from './adapter.js';
import { normalizeChukou1Number, parseChukou1 } from './parser.js';
import { chukou1Stage, chukou1SummaryStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'SUF260901ZZZZ0000001';
const IN_TRANSIT = 'CNI260915AAA0000002';
const UNKNOWN = 'SUF991231ZZZZ0000000';
const USPS = '9200190000000000001235';
const CHINA_POST = 'UU000000005CN';
// The page's signing text, as its script ships it to every visitor.
const PAGE_SECRET = 'Vnj25FYu3mIjbNUS'; // gitleaks:allow
const INSTANT = Date.UTC(2026, 9, 19, 12, 0, 0, 129);

type Row = Record<string, unknown>;
type Feed = Row & { trackingDetails: Row[] };
type Shipment = Row & { firstLegTrackingDetails: Row[]; supplierTrackingDetails: Feed[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Shipment[];
const changed = (name: string, change: (shipment: Shipment, reply: Shipment[]) => void) => {
  const reply = fixture(name);
  change(reply[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const refusal = (clock: string) => reply({ TicketId: '00000000-0000-0000-0000-000000000000', UtcDateTime: clock,
  RequestUri: 'http://synthetic/api/v1/trackings?lang=en-US', Errors: [{ Sn: null, Code: '200F1004', Message: 'Query illegal!' }] }, { status: 400 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const sent = (init: RequestInit | undefined) => JSON.parse(String(init!.body)) as { securityKey: string; securityValue: string };

/** The number a signed body carries, decrypted as the gateway does. */
function opened(body: { securityKey: string; securityValue: string }): string {
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(body.securityKey.slice(0, 32), 'utf8'), Buffer.from(PAGE_SECRET, 'utf8'));
  return Buffer.concat([decipher.update(Buffer.from(body.securityValue, 'hex')), decipher.final()]).toString('utf8');
}

describe('Chukou1 HTTP adapter', () => {
  it('signs the number as the tracking page does, with the UTC clock to the hundredth', () => {
    const body = signChukou1Lookup(DELIVERED, INSTANT);
    expect(body.securityKey).toBe(`${createHash('md5').update(`2026101912000012${PAGE_SECRET}`).digest('hex')}0012`);
    expect(body.securityValue).toMatch(/^(?:[0-9a-f]{32})+$/);
    expect(opened(body)).toBe(DELIVERED);
    expect(signChukou1Lookup(DELIVERED, INSTANT + 10).securityKey.slice(-4)).toBe('0013');
  });

  it('posts the signed number once to the page’s lookup, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new Chukou1Tracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => INSTANT })
      .fetch(' cni-260915-aaa-0000002 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(CHUKOU1_API);
    expect(String(url)).toBe('https://ec-gateway.chukou1.com/api/v1/trackings?lang=en-US');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(sent(init)).toEqual(signChukou1Lookup(IN_TRANSIT, INSTANT));
    expect(opened(sent(init))).toBe(IN_TRANSIT);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'chukou1', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel as wall clocks, newest first, without postcodes or the proof of delivery', () => {
    const result = normalizeCarrierResult(parseChukou1(fixture('delivered'), DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'SPRINGFIELD, ZZ, Delivered, In/At Mailbox -> Your item was delivered in or at the mailbox at 1:48 pm on September 12, 2026 in SPRINGFIELD, ZZ.',
      last_update: null, last_update_local: '2026-09-12T13:48:00', expected_delivery: null,
      delivery_carrier: 'usps', delivery_tracking_number: USPS, destination_country: 'US' });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-09-12T13:48:00', undefined, result.last_status_text, 'delivered'],
      ['2026-09-12T07:20:00', undefined, 'SPRINGFIELD, ZZ, Out for Delivery', 'out_for_delivery'],
      ['2026-09-12T07:03:00', undefined, 'SPRINGFIELD, ZZ, Arrived at Post Office', 'in_transit'],
      ['2026-09-11T01:33:00', undefined, 'EXAMPLE PROCESSING ANNEX, Departed USPS Regional Facility', 'in_transit'],
      ['2026-09-11T01:33:00', undefined, 'EXAMPLE PROCESSING ANNEX, Arrived at USPS Regional Facility', 'in_transit'],
      ['2026-09-09T20:56:00', undefined, 'EXAMPLETOWN, ZZ, Arrived Shipping Partner Facility, USPS Awaiting Item', 'in_transit'],
      ['2026-09-08T14:11:00', 'United States', 'Turned over to last mile facility', 'in_transit'],
      ['2026-09-08T04:17:00', 'United States', 'Transport to next facility', 'in_transit'],
      ['2026-09-07T11:02:00', 'United States', 'Customs declaration completed', 'in_transit'],
      ['2026-09-07T03:30:00', 'United States', 'Customs clearance in progress', 'customs'],
      ['2026-09-07T01:47:00', 'United States', 'Arrived at Airport of destination', 'in_transit'],
      ['2026-09-05T11:38:00', 'China', 'Departed from Airport of Origin', 'in_transit'],
      ['2026-09-04T20:22:00', 'China', 'Arrived at Airport of Origin', 'in_transit'],
      ['2026-09-04T12:56:00', 'China', 'Transfer to Airport of Origin', 'in_transit'],
      ['2026-09-03T07:29:00', 'SHENZHEN, China', 'Item was sent out from Logistics Centre', 'in_transit'],
      ['2026-09-02T23:32:00', 'SHENZHEN, China', 'Item received by Logistics Centre', 'accepted'],
      ['2026-09-01T15:03:00', undefined, 'Shipment information received', 'registered'],
      ['2026-09-01T11:39:00', undefined, 'EXAMPLETOWN, ZZ, Shipping Label Created, USPS Awaiting Item', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.provider_code === undefined)).toBe(true);
    expect(result.events!.filter((event) => event.location).every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/(?<!\d)0000[12](?!\d)|JVBERi|Chukou1|Unknown/);
    // The delivery carrier and its number propose the confirmation lookup.
    expect(deliveryHandoff('chukou1', DELIVERED, result)).toMatchObject({ carrier: 'usps', number: USPS });
  });

  it('reads a parcel with China Post once per scan, and hands its number on', () => {
    const result = normalizeCarrierResult(parseChukou1(fixture('in-transit'), IN_TRANSIT));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '到达寄达地', last_update_local: '2026-09-22T07:53:00',
      delivery_carrier: 'china-post', delivery_tracking_number: CHINA_POST, destination_country: 'US' });
    expect(result.events!.map((event) => [event.local_time, event.description])).toEqual([
      ['2026-09-22T07:53:00', '到达寄达地'],
      ['2026-09-20T04:41:00', '航空公司启运'],
      ['2026-09-19T07:23:00', '示例市, 已交承运商运输'],
      ['2026-09-18T15:15:00', '示例市, 出口海关/放行'],
      ['2026-09-18T09:59:00', '示例市, 送交出口海关'],
      ['2026-09-17T14:07:00', '示例市, 中国邮政 已收取邮件'],
      ['2026-09-17T06:17:00', 'Item was sent out from Logistics Centre'],
      ['2026-09-15T20:50:00', 'Item received by Logistics Centre'],
    ]);
    // China Post's own wording has no rule; the scans before it stage the parcel.
    expect(result.events!.slice(0, 6).every((event) => event.stage === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/(?<!\d)(?:0000003\d|00000020)(?!\d)|示例省/);
  });

  it('keeps the destination carrier only when the reply names one the catalog tracks and the number is its own', () => {
    const handoff = (change: (shipment: Shipment) => void) => {
      const { delivery_carrier, delivery_tracking_number } = parseChukou1(changed('delivered', change), DELIVERED);
      return { delivery_carrier, delivery_tracking_number };
    };
    // A USPS routing barcode loses the recipient's ZIP code.
    expect(handoff((shipment) => { shipment.trackingNumber = `42000000${USPS}`; })).toEqual({ delivery_carrier: 'usps', delivery_tracking_number: USPS });
    // The service names no carrier, a partner feed does.
    expect(handoff((shipment) => { shipment.trackingServiceDiscription = 'Synthetic Line'; }))
      .toEqual({ delivery_carrier: 'usps', delivery_tracking_number: USPS });
    const none = { delivery_carrier: undefined, delivery_tracking_number: undefined };
    for (const change of [
      (shipment: Shipment) => { shipment.trackingServiceDiscription = 'Synthetic Line'; shipment.supplierTrackingDetails[0]!.carrierCode = 'SyntheticPOD'; },
      // A number another carrier's rules claim, or none of them.
      (shipment: Shipment) => { shipment.trackingNumber = CHINA_POST; },
      (shipment: Shipment) => { shipment.trackingNumber = 'ZZ'; },
      (shipment: Shipment) => { shipment.trackingNumber = ''; },
      (shipment: Shipment) => { shipment.trackingNumber = DELIVERED; },
      (shipment: Shipment) => { shipment.trackingServiceDiscription = 'Chukou1'; shipment.supplierTrackingDetails = []; },
    ]) expect(handoff(change)).toEqual(none);
  });

  it('drops phone numbers, the receiver of a delivery, every form of the destination postcode and repeated parts', () => {
    const scans = (postcode: string, ...descriptions: string[]) => parseChukou1(changed('delivered', (shipment) => {
      shipment.destinctPostCode = postcode;
      shipment.supplierTrackingDetails[0]!.trackingDetails = descriptions.map((description, index) =>
        ({ description, dateTimeString: `Sep 2${index} 2026 10:00 AM`, viewOrder: index + 1 }));
    }), DELIVERED).events!.filter((event) => !event.location).map((event) => event.description);
    expect(scans('ZZ1 1ZZ',
      'Exampleton,ZZ1 1ZZ, Exampleton, ZZ11ZZ, Delivered, signed by A. SAMPLE',
      'Exampleton, Out for delivery, call +44 0000 000000',
      'Exampleton, Delivered to the recipient, 签收人是【示例】',
      'Exampleton, Arrived at the delivery office, received by the delivery office',
    )).toEqual([
      'Exampleton, Arrived at the delivery office, received by the delivery office',
      'Exampleton, Delivered to the recipient',
      'Exampleton, Out for delivery, call',
      'Exampleton, Delivered',
      'Shipment information received',
    ]);
  });

  it('keeps the page’s Delivered over an earlier scan, and a later return over it', () => {
    const delivered = parseChukou1(changed('delivered', (shipment) => { shipment.supplierTrackingDetails = []; }), DELIVERED);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Turned over to last mile facility' });
    const returned = parseChukou1(changed('delivered', (shipment) => {
      shipment.firstLegTrackingDetails.unshift({ description: 'United States, Return To Sender', dateTimeString: 'Sep 30 2026 09:00 AM', viewOrder: 13 });
    }), DELIVERED);
    expect(returned).toMatchObject({ current_stage: 'returned', current_stage_source: 'carrier_map' });
    // A shipment the page calls in process or in transit, without a staged scan, keeps that.
    const quiet = parseChukou1(changed('in-transit', (shipment) => { shipment.firstLegTrackingDetails = []; }), IN_TRANSIT);
    expect(quiet).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    const unstaged = parseChukou1(changed('in-transit', (shipment) => {
      shipment.orderStatus = 'Synthetic';
      shipment.firstLegTrackingDetails = [];
    }), IN_TRANSIT);
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: '到达寄达地' });
    expect(unstaged).not.toHaveProperty('current_stage');
  });

  it('reads a known parcel without scans as no history', () => {
    for (const status of ['InProcess', 'InTransit', 'Delivered']) {
      expect(() => parseChukou1(changed('in-transit', (shipment) => {
        shipment.orderStatus = status;
        shipment.firstLegTrackingDetails = [];
        shipment.supplierTrackingDetails = null as never;
      }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('rejects an answer for another shipment', () => {
    for (const lookup of [
      changed('in-transit', (shipment) => { shipment.orderNumber = 'CNI260915AAA0000003'; }),
      changed('not-found', (shipment) => { shipment.orderNumber = 'SUF991231ZZZZ0000001'; }),
      changed('in-transit', (shipment) => { shipment.orderNumber = ''; }),
    ]) {
      expect(() => parseChukou1(lookup, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // The shipment asked is found among others, in any case.
    const listed = [...fixture('not-found'), ...changed('in-transit', (shipment) => { shipment.orderNumber = IN_TRANSIT.toLowerCase(); })];
    expect(parseChukou1(listed, IN_TRANSIT).events).toHaveLength(8);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Shipment[]) => { body.length = 0; },
      (_shipment: Shipment, body: Shipment[]) => { body.push(...Array.from({ length: 10 }, () => body[0]!)); },
      (_shipment: Shipment, body: Shipment[]) => { body.push('shipment' as never); },
      (shipment: Shipment) => { delete shipment.orderNumber; },
      (shipment: Shipment) => { shipment.orderStatus = 2; },
      (shipment: Shipment) => { shipment.firstLegTrackingDetails = 'scans' as never; },
      (shipment: Shipment) => { shipment.firstLegTrackingDetails = Array.from({ length: 301 }, () => shipment.firstLegTrackingDetails[0]!); },
      (shipment: Shipment) => { shipment.supplierTrackingDetails = { feed: true } as never; },
      (shipment: Shipment) => { shipment.supplierTrackingDetails = Array.from({ length: 11 }, () => shipment.supplierTrackingDetails[0]!); },
      (shipment: Shipment) => { shipment.supplierTrackingDetails[0] = 'feed' as never; },
      (shipment: Shipment) => { shipment.supplierTrackingDetails[0]!.carrierCode = 7; },
      (shipment: Shipment) => { shipment.supplierTrackingDetails[0]!.trackingDetails = 'scans' as never; },
      (shipment: Shipment) => { shipment.firstLegTrackingDetails[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.firstLegTrackingDetails[0]!.description = ''; },
      (shipment: Shipment) => { shipment.firstLegTrackingDetails[0]!.description = { en: 'Arrived' }; },
      (shipment: Shipment) => { delete shipment.firstLegTrackingDetails[0]!.dateTimeString; },
      (shipment: Shipment) => { shipment.firstLegTrackingDetails[0]!.dateTimeString = 1790000000; },
      (shipment: Shipment) => { shipment.firstLegTrackingDetails[0]!.dateTimeString = '2026-09-17T06:17:00+08:00'; },
      (shipment: Shipment) => { shipment.firstLegTrackingDetails[0]!.dateTimeString = 'Sep 31 2026 06:18 AM'; },
      (shipment: Shipment) => { shipment.firstLegTrackingDetails[0]!.dateTimeString = 'Sep 17 2026 13:18 PM'; },
      (shipment: Shipment) => { shipment.firstLegTrackingDetails[0]!.dateTimeString = 'Sep 7 2026 06:18 AM'; },
      (shipment: Shipment) => { shipment.destinctPostCode = 3; },
      (shipment: Shipment) => { shipment.trackingNumber = ['UU000000005CN']; },
    ]) {
      expect(() => parseChukou1(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', null, { Errors: [] }]) expect(() => parseChukou1(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the page’s NotFound as not found, and recognizes by the same lookup', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // A local clock dates the last activity without an instant.
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-12T13:48:00' });
  });

  it('signs once more with the gateway’s clock when it refuses one too far from its own', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(refusal('2026-10-19T12:05:00.1234567Z')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(new Chukou1Tracker({ fetcher, now: () => INSTANT }).fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sent(fetcher.mock.calls[0]![1])).toEqual(signChukou1Lookup(DELIVERED, INSTANT));
    expect(sent(fetcher.mock.calls[1]![1])).toEqual(signChukou1Lookup(DELIVERED, Date.UTC(2026, 9, 19, 12, 5, 0, 123)));
  });

  it('reads a signature refused at the gateway’s own clock, or refused again, as a changed page', async () => {
    const lookup = (...responses: Response[]) => {
      const fetcher = vi.fn<typeof fetch>();
      for (const response of responses) fetcher.mockResolvedValueOnce(response);
      return { fetcher, result: new Chukou1Tracker({ fetcher, now: () => INSTANT }).fetch(DELIVERED) };
    };
    const near = lookup(refusal('2026-10-19T12:00:03Z'));
    await expect(near.result).rejects.toMatchObject({ kind: 'schema', status: 400 });
    expect(near.fetcher).toHaveBeenCalledTimes(1);
    const again = lookup(refusal('2026-10-19T12:05:00Z'), refusal('2026-10-19T12:10:00Z'));
    await expect(again.result).rejects.toMatchObject({ kind: 'schema', status: 400 });
    expect(again.fetcher).toHaveBeenCalledTimes(2);
    for (const body of [{ Errors: [{ Code: '200F0000', Message: 'Synthetic' }], UtcDateTime: '2026-10-19T12:05:00Z' },
      { Errors: [{ Code: '200F1004' }], UtcDateTime: 'yesterday' }, { Errors: [{ Code: '200F1004' }], UtcDateTime: '2026-10-19T12:05:00' }, 'Bad Request']) {
      const other = lookup(reply(body, { status: 400 }));
      await expect(other.result).rejects.toMatchObject({ kind: 'schema' });
      expect(other.fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps a refusal, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: IN_TRANSIT });
    await expect(lookup(reply({ status: 404, title: 'Not Found' }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(reply({ message: 'Forbidden' }, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // A browser check, even with HTTP 200 or 400, is never a missing parcel.
    await expect(lookup(new Response(CHECK, { status: 200, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response(CHECK, { status: 400, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(new Response('<!DOCTYPE html><html><head><title>EC-FirstClass</title></head><body><div id=app></div></body></html>', { status: 200 })))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('refuses a redirect, which would answer for another request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://ec.chukou1.com/' } }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      // An HTTP status is never sent again.
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a lookup that does not reach the service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new Chukou1Tracker({ fetcher, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
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
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses numbers Chukou1 does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['SUF261301ZZZZ0000001', 'SUF260932ZZZZ0000001', 'SUF260901ZZZZ00001', 'SUF260901ZZZZ00000001', 'SU260901ZZZZ0000001',
      'SUF2609011230000001', 'SUF260901Z000001', `${DELIVERED},${IN_TRANSIT}`, `${DELIVERED}/../1`, USPS, CHINA_POST, `SUF260901ZZZZ${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeChukou1Number(' suf 260901.zzzz-0000001 ')).toBe(DELIVERED);
    // A customer code may start with a digit when it holds a letter.
    expect(normalizeChukou1Number('SUF2609011ZZ1000001')).toBe('SUF2609011ZZ1000001');
  });

  it('routes a number filed under Chukou1 to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input) === CHUKOU1_API
      ? reply(fixture('in-transit')) : new Response('', { status: 503 }));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: IN_TRANSIT, carrier: 'chukou1' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'chukou1', source: 'chukou1', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === CHUKOU1_API)).toBe(true);
  });
});

describe('Chukou1 status vocabulary', () => {
  const entries = statuses.entries as { code?: string; wording: string; stage?: string; confirmedBy: string; unmapped?: boolean }[];

  it('records every wording with the stage the adapter gives it', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const stage = chukou1Stage(entry.wording)?.stage ?? (entry.code ? chukou1SummaryStage(entry.code) : undefined);
      expect(stage ?? null, entry.wording).toBe(entry.stage ?? null);
      expect(entry.unmapped === true, entry.wording).toBe(entry.stage === undefined);
    }
  });

  it('maps Chukou1’s own wordings, without a code, and leaves the partners’ to the shared rules', () => {
    for (const entry of entries.filter((item) => item.confirmedBy === 'official-doc')) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code!, normalizeStatusWording(entry.wording)), entry.wording).toBeUndefined();
    }
    for (const event of parseChukou1(fixture('delivered'), DELIVERED).events!.filter((item) => item.location || item.description === 'Shipment information received')) {
      expect(statusMap.stage(null, normalizeStatusWording(event.description!)), event.description).toBe(event.stage);
    }
    expect(statusMapAnswer({ carrier: 'chukou1', providerCode: null, description: 'Item received by Logistics Centre' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'chukou1', providerCode: null, description: '示例市, 已交承运商运输' })).toEqual({ kind: 'unknown' });
  });
});
