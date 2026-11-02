import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, AJEX_LOGIN_API, AJEX_TRACK_API, AJEX_VISITOR_KEY, AjexTracker, decryptAjexReply, decryptAjexText,
  encryptAjexText } from './adapter.js';
import { ajexWording, normalizeAjexNumber, parseAjex } from './parser.js';
import { ajexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'AJA123406789013';
const IN_TRANSIT = 'A1234567890';
const UNKNOWN = 'AJA000000000000';
const OLD_FORMAT = 'AJS000000000000';

type Row = Record<string, unknown>;
type Shipment = Row & { orderTrackingHistory: Row[]; orderTackingDetails: Row & { receiverDetails: Row } };
type Reply = Row & { status: number; msg: string | null; data: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const answer = (msg: string | null, status = 500) => ({ ...fixture('not-found'), status, msg });
// A token shaped as the service's, built here so no token-like text sits in the source.
const FAR = Date.UTC(2100, 0, 1) / 1000;
const jwt = (exp?: number) => [{ alg: 'HS512' }, { sub: 'sample', ...(exp === undefined ? {} : { exp }) }]
  .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.c2FtcGxl';
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const login = (token: string | null = jwt(FAR)) => json({ accessToken: token, tokenType: 'Bearer', shipperId: null, shipperAccount: null,
  errorMessage: null, externalCustomerActNo: null });
const sealed = (body: unknown, init?: ResponseInit) => json(encryptAjexText(JSON.stringify(body)), init);
const asked = (init: RequestInit | undefined) => decryptAjexText((JSON.parse(String(init!.body)) as { waybillList: string[] }).waybillList[0]!);

/** AJEX's two calls: the visitor login, then the lookup, which `lookup` answers for the number asked. */
function service(lookup: (number: string) => Response, token: () => Response = () => login()) {
  return vi.fn<typeof fetch>(async (input, init) => (String(input) === AJEX_LOGIN_API ? token() : lookup(asked(init))));
}
const replies = (bodies: Record<string, unknown>) => service((number) => sealed(bodies[number] ?? fixture('not-found')));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('AJEX HTTP adapter', () => {
  it('logs in as the site’s visitor, then asks for the whole number, encrypted, through the supplied transport', async () => {
    const fetcher = replies({ [IN_TRANSIT]: fixture('in-transit'), [DELIVERED]: fixture('delivered') });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new AjexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' a 12345 67890 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[loginUrl, loginInit], [trackUrl, trackInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(loginUrl).toBe(AJEX_LOGIN_API);
    expect(loginInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(loginInit.body))).toEqual({ token: AJEX_VISITOR_KEY });
    expect(trackUrl).toBe(AJEX_TRACK_API);
    expect(trackInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0', Authorization: `Bearer ${jwt(FAR)}` } });
    expect(JSON.parse(String(trackInit.body))).toEqual({ customerAccount: 'AJ47', waybillList: [encryptAjexText(IN_TRANSIT)], pageNumber: 1, lang: 'en' });
    expect(asked(trackInit)).toBe(IN_TRANSIT);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ajex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    // The token serves later lookups until a minute before it expires.
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([AJEX_LOGIN_API, AJEX_TRACK_API, AJEX_TRACK_API]);
  });

  it('logs in again when its token is about to expire, names no expiry or is refused', async () => {
    let now = Date.UTC(2026, 4, 1);
    const fetcher = replies({ [DELIVERED]: fixture('delivered') });
    fetcher.mockImplementation(async (input, init) => (String(input) === AJEX_LOGIN_API ? login(jwt(now / 1000 + 20 * 60))
      : sealed(asked(init) === DELIVERED ? fixture('delivered') : fixture('not-found'))));
    const tracker = new AjexTracker({ fetcher, now: () => now });
    await tracker.fetch(DELIVERED);
    now += 18 * 60_000;
    await tracker.fetch(DELIVERED);
    now += 90_000;
    await tracker.fetch(DELIVERED);
    expect(fetcher.mock.calls.map(([url]) => String(url) === AJEX_LOGIN_API)).toEqual([true, false, false, true, false]);

    const unnamed = service(() => sealed(fixture('delivered')), () => login(jwt()));
    const once = new AjexTracker({ fetcher: unnamed });
    await once.fetch(DELIVERED);
    await once.fetch(DELIVERED);
    expect(unnamed.mock.calls.filter(([url]) => String(url) === AJEX_LOGIN_API)).toHaveLength(2);

    // A reused token the service dropped is replaced once; a fresh one it refuses is a refusal.
    let refused = true;
    const dropped = service(() => (refused ? new Response('', { status: 401 }) : sealed(fixture('delivered'))));
    const reused = new AjexTracker({ fetcher: dropped });
    refused = false;
    await reused.fetch(DELIVERED);
    refused = true;
    await expect(reused.fetch(DELIVERED)).rejects.toMatchObject({ kind: 'challenge', status: 401 });
    expect(dropped.mock.calls.map(([url]) => String(url) === AJEX_LOGIN_API)).toEqual([true, false, false, true, false]);
  });

  it('keeps each scan’s instant and stages it by the older system’s status code', () => {
    const result = parseAjex(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment delivered', last_update: '2026-03-04T13:25:00Z', delivered_at: '2026-03-04T13:25:00Z',
      destination_country: 'SA' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location, event.description])).toEqual([
      ['2026-03-04T13:25:00Z', '80', 'delivered', 'Sample Town', 'Shipment delivered'],
      ['2026-03-04T09:10:00Z', '204', 'out_for_delivery', 'Sample Town', 'Shipment assigned to driver'],
      ['2026-03-04T07:00:00Z', '50', 'in_transit', 'Sample Town', 'Shipment arrived at Sample Town Hub'],
      ['2026-03-03T18:05:00Z', '70', 'failed_attempt', 'Sample Town', 'Undelivered (Arrived at address - No answer)'],
      ['2026-03-03T09:40:00Z', '204', 'out_for_delivery', 'Sample Town', 'Shipment assigned to driver'],
      ['2026-03-03T07:15:00Z', '50', 'in_transit', 'Sample Town', 'Shipment arrived at Sample Town Hub'],
      // The repeated hub scan is kept once, and the page's "AJEX" leaves the city's name.
      ['2026-03-02T08:30:01Z', '618', 'in_transit', 'Sample City', 'Shipment scanned in Sample City Hub'],
      ['2026-03-02T08:30:00Z', '54', 'accepted', 'Sample City', 'Shipment picked up'],
      ['2026-03-01T09:00:00Z', '100', 'registered', 'Sample City', 'Shipment pickup scheduled'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The goods, the placeholder weight and the estimate stay out.
    expect(result).not.toHaveProperty('weight_kg');
    expect(result).not.toHaveProperty('expected_delivery');
    expect(JSON.stringify(result)).not.toMatch(/Sample goods|AJEX0000|SMPHUB|ARRIVED AT ADDRESS/);
  });

  it('adds the newer system’s notes to its statuses, without the row the page hides or anyone’s details', () => {
    const result = parseAjex(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'In Transit: Arrived At Destination', last_update: '2026-05-12T07:10:00Z', destination_country: 'SA' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null, event.description])).toEqual([
      ['AJ0016', 'in_transit', 'Sample Town', 'In Transit: Arrived At Destination'],
      ['AJ0031', 'in_transit', 'Sample Town', 'Trip Exception: Load to destination - LH-Delay'],
      ['AJ0012', 'in_transit', 'Sample City', 'In Transit: Load to Destination'],
      ['AJ0008', 'in_transit', 'Sample City', 'Received at Hub: Master Pallet Created'],
      ['AJ0008', 'in_transit', 'Sample City', 'Received at Hub'],
      // A note inside its status adds nothing.
      ['AJ0007', 'accepted', 'Sample City', 'Shipment picked up'],
      ['AJ0017', 'exception', 'Sample City', 'Shipment Not Picked: On Hold - Customer Request'],
      ['AJ0002', 'registered', 'Sample City', 'Booking Confirmed: Booking Approved'],
      ['AJ0001', 'registered', null, 'Booking Placed: Booking created'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Recipient|Shop|Street|Road|goods)|0000000000|Pickup Driver/);
  });

  it('leaves a delivery’s note out, and keeps a holding scan and the delivery of the newer system', () => {
    const result = parseAjex(changed('in-transit', (shipment) => {
      const row = (actionTime: number, eventCode: string, status: string, note: string) => ({ ...shipment.orderTrackingHistory.at(-1),
        actionTime, eventCode, status, note });
      shipment.orderTrackingHistory.push(
        row(Date.UTC(2026, 4, 12, 9), 'AJ0026', 'Hold at Terminal', 'Customer Appointment Required'),
        row(Date.UTC(2026, 4, 13, 6), 'AJ0015', 'DeliverySheet Created', 'DeliverySheet Created'),
        row(Date.UTC(2026, 4, 13, 7), 'AJ0019', 'Out For Delivery', 'Out For Delivery'),
        row(Date.UTC(2026, 4, 13, 10), 'AJ0011', 'Delivered', 'Received by Sample Person, 000 000 0000'),
      );
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-05-13T10:00:00Z' });
    expect(result.events!.slice(0, 4).map((event) => [event.provider_code, event.stage, event.description])).toEqual([
      ['AJ0011', 'delivered', 'Delivered'],
      ['AJ0019', 'out_for_delivery', 'Out For Delivery'],
      ['AJ0015', 'in_transit', 'DeliverySheet Created'],
      ['AJ0026', 'exception', 'Hold at Terminal: Customer Appointment Required'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample Person/);
  });

  it('orders the scans by their instants, newest first, whatever order the reply lists them in', () => {
    const result = parseAjex(changed('delivered', (shipment) => { shipment.orderTrackingHistory.reverse(); }), DELIVERED);
    expect(result).toMatchObject({ last_update: '2026-03-04T13:25:00Z', current_stage: 'delivered' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: '100' });
  });

  it('keeps scans of one instant in the reply’s order, whichever way it lists them', () => {
    const tied = (newestFirst: boolean) => parseAjex(changed('in-transit', (shipment) => {
      const row = (eventCode: string, status: string) => ({ ...shipment.orderTrackingHistory.at(-1), actionTime: Date.UTC(2026, 4, 13, 7), eventCode, status, note: '' });
      shipment.orderTrackingHistory.push(row('AJ0015', 'DeliverySheet Created'), row('AJ0019', 'Out For Delivery'));
      if (newestFirst) shipment.orderTrackingHistory.reverse();
    }), IN_TRANSIT).events!.slice(0, 2).map((event) => event.provider_code);
    expect(tied(false)).toEqual(['AJ0019', 'AJ0015']);
    expect(tied(true)).toEqual(['AJ0019', 'AJ0015']);
  });

  it('stages a code the map does not know by its wording, and leaves an unclear one without a stage', () => {
    const worded = parseAjex(changed('delivered', (shipment) => {
      Object.assign(shipment.orderTrackingHistory.at(-1)!, { statusCode: 999, status: 'Returned to shipper' });
    }), DELIVERED);
    expect(worded.events![0]).toMatchObject({ provider_code: '999', stage: 'returned', stage_source: expect.stringMatching(/^wording:/) });
    const unclear = parseAjex(changed('delivered', (shipment) => {
      Object.assign(shipment.orderTrackingHistory.at(-1)!, { statusCode: 999, status: 'Synthetic note' });
    }), DELIVERED);
    expect(unclear.events![0]).not.toHaveProperty('stage');
    expect(unclear).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Synthetic note' });
  });

  it('takes phone numbers out of the wording', () => {
    expect(ajexWording('Shipment Not Picked', 'Call 000 000 0000 first', true)).toBe('Shipment Not Picked: Call first');
    expect(ajexWording('Delivered', 'Received by Sample Person', true, 'delivered')).toBe('Delivered');
    expect(ajexWording('Shipment picked up', 'Shipment has been collected successfully.', false)).toBe('Shipment picked up');
    expect(ajexWording('Received at Hub', 'received at hub', true)).toBe('Received at Hub');
    expect(ajexWording('Booking Placed', '', true)).toBe('Booking Placed');
  });

  it('reads an unknown number as not found, a refused format as invalid, and the rest as inconclusive', () => {
    expect(() => parseAjex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAjex(answer('Invalid Waybill Number Format'), OLD_FORMAT)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    // The newer system's unknown numbers come without a message, as a failure could.
    expect(() => parseAjex(answer(null), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAjex(answer('Something went wrong'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAjex(answer('Too many requests', 429), DELIVERED)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseAjex(changed('delivered', (shipment) => { shipment.orderTrackingHistory = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseAjex(changed('delivered', (shipment) => { (shipment as Row).orderTrackingHistory = null; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseAjex(changed('in-transit', (shipment) => {
      shipment.orderTrackingHistory = shipment.orderTrackingHistory.filter((row) => row.status === '');
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseAjex(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'AJEX answered for another shipment' }));
    expect(() => parseAjex(changed('delivered', (shipment) => { shipment.waybillNumber = 'AJA12340678901'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAjex(changed('delivered', (_shipment, reply) => { reply.data = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseAjex(changed('delivered', (shipment, reply) => {
      reply.data.unshift({ ...shipment, waybillNumber: UNKNOWN });
      shipment.waybillNumber = DELIVERED.toLowerCase();
    }), DELIVERED).events).toHaveLength(9);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, reply: Reply) => { reply.status = '200' as never; },
      (_shipment: Shipment, reply: Reply) => { reply.data = 'shipments' as never; },
      (_shipment: Shipment, reply: Reply) => { reply.data[0] = 'shipment' as never; },
      (shipment: Shipment) => { delete shipment.waybillNumber; },
      (shipment: Shipment) => { shipment.orderTrackingHistory = 'scans' as never; },
      (shipment: Shipment) => { shipment.orderTrackingHistory = Array.from({ length: 501 }, () => shipment.orderTrackingHistory[0]!); },
      (shipment: Shipment) => { shipment.orderTrackingHistory[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.orderTrackingHistory[0]!.actionTime = '2026-03-01 12:00:00'; },
      (shipment: Shipment) => { shipment.orderTrackingHistory[0]!.actionTime = 1772355600.5; },
      (shipment: Shipment) => { shipment.orderTrackingHistory[0]!.actionTime = 1772355600; },
      (shipment: Shipment) => { delete shipment.orderTrackingHistory[0]!.actionTime; },
      (shipment: Shipment) => { shipment.orderTrackingHistory[0]!.status = ['Shipment delivered']; },
      (shipment: Shipment) => { shipment.orderTrackingHistory[0]!.statusCode = { code: 80 }; },
      (shipment: Shipment) => { shipment.orderTrackingHistory[0]!.cityName = 7; },
    ]) {
      expect(() => parseAjex(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response) => carrier(service(response)).track({ number: UNKNOWN });
    await expect(lookup(() => sealed(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => sealed(answer('Invalid Waybill Number Format')))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup(() => sealed(answer('Too many requests', 429)))).rejects.toMatchObject({ kind: 'rate_limited' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(() => sealed(fixture('not-found'), { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('', { status: 302, headers: { Location: 'https://aj-ex.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('<html><title>Just a moment...</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json('<html><title>AJEX</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(encryptAjexText('not json')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(''))).rejects.toMatchObject({ kind: 'schema' });
    // A visitor key the service no longer takes gets a login without a token.
    const keyless = carrier(service(() => sealed(fixture('delivered')), () => login(null)));
    await expect(keyless.track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema', message: 'AJEX visitor login gave no token' });
    const blocked = carrier(service(() => sealed(fixture('delivered')), () => json('<html><div class="cf-turnstile"></div></html>')));
    await expect(blocked.track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    expect(() => decryptAjexReply('AAAA')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
      const lookup = service(() => new Response('', { status }));
      await expect(carrier(lookup).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(lookup).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number by its newest scan, the unknown-number answer and a refused format, and asks nothing for another shape', async () => {
    const fetcher = replies({ [DELIVERED]: fixture('delivered'), [OLD_FORMAT]: answer('Invalid Waybill Number Format') });
    const ajex = carrier(fetcher);
    await expect(ajex.recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T13:25:00.000Z' });
    await expect(ajex.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(ajex.recognize!(OLD_FORMAT)).resolves.toEqual({ known: false });
    await expect(ajex.recognize!('AJB000000000000')).resolves.toEqual({ known: false });
    expect(fetcher.mock.calls.filter(([url]) => String(url) === AJEX_TRACK_API)).toHaveLength(3);
  });

  it('rejects numbers AJEX does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['AJB000000000000', 'AJA00000000000', 'AJA0000000000000', 'A000000000', 'B0000000000', 'SAMPLETRACKING', `AJA${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAjexNumber('aja 1234-0678-9013')).toBe(DELIVERED);
  });

  it('tries once more after a failed connection, and ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    let calls = 0;
    const flaky = service(() => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return sealed(fixture('delivered'));
    });
    await clock.settle(expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' }));
    // The retry reuses the token the first try got.
    expect(flaky.mock.calls.map(([url]) => String(url))).toEqual([AJEX_LOGIN_API, AJEX_TRACK_API, AJEX_TRACK_API]);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a number filed under AJEX, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = replies({ [DELIVERED]: fixture('delivered') });
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'ajex' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ajex', source: 'ajex', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ajex', source: 'ajex' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === AJEX_TRACK_API)).toBe(true);
  });
});

describe('AJEX numbers', () => {
  it('claims AJA and AJS with twelve digits, which leaves nothing to recognize, but not A with ten digits', () => {
    for (const number of [DELIVERED, UNKNOWN, OLD_FORMAT]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'ajex', confidence: 'high' });
      expect(recognitionAskedCarriers(number), number).toEqual([]);
    }
    expect(detectCarrierMatch(IN_TRANSIT).carrier).not.toBe('ajex');
    expect(recognitionAskedCarriers(IN_TRANSIT)).not.toContain('ajex');
  });
});

describe('AJEX status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(ajexStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'ajex', providerCode: 'AJ0019', description: 'Out For Delivery' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'ajex', providerCode: '70', description: 'Undelivered (Change of address)' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'ajex', providerCode: 'AJ9999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    expect(ajexStage('aj0011', 'Delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(ajexStage('AJ9999', 'Synthetic note')).toBeNull();
  });
});
