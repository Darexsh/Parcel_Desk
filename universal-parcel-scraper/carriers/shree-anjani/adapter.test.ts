import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SHREE_ANJANI_API, ShreeAnjaniTracker } from './adapter.js';
import { normalizeShreeAnjaniNumber, parseShreeAnjani } from './parser.js';
import { shreeAnjaniMappedStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '9900000011';
const IN_TRANSIT = '9900000022';
const UNKNOWN = '9900000033';

type Row = Record<string, unknown>;
type Reply = { success: boolean; data: { booking: Row | null; booking_tracking: Row[]; last_center_details: Row; drs_list: Row[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
/** The lookup, answering each number from `bodies` and anything else as unknown. */
const service = (bodies: Record<string, unknown>) => vi.fn<typeof fetch>(async (input) => {
  const number = String(input).slice(SHREE_ANJANI_API.length);
  return json(bodies[number] ?? changed('not-found', (reply) => { reply.data.booking!.barcode_number = number; }));
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseShreeAnjani>) => result.events!.map((event) =>
  [event.time ?? event.local_time, event.provider_code ?? null, event.stage ?? null, event.location ?? null, event.description]);

describe('Shree Anjani HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number through the supplied transport', async () => {
    const fetcher = service({ [IN_TRANSIT]: fixture('in-transit') });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new ShreeAnjaniTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' 9900-0000 22 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(`https://api-customer.shreeanjani.co.in/public/awb/${IN_TRANSIT}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shree-anjani', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history at India’s offset, with the booking day last and no centre manager’s details', () => {
    const result = parseShreeAnjani(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED ON 4/3/2026', last_update: '2026-03-05T19:16:34+05:30',
      // The booking's status date, which its first run sheet shares.
      delivered_at: '2026-03-04T10:40:20+05:30' });
    expect(rows(result)).toEqual([
      ['2026-03-05T19:16:34+05:30', null, 'delivered', 'SAMPLE NAGAR', 'Delivered'],
      ['2026-03-04T10:40:20+05:30', null, 'delivered', 'SAMPLE NAGAR', 'Delivered'],
      ['2026-03-03T11:45:00+05:30', 'OUT', 'in_transit', 'SAMPLE CITY R.O.', 'Out To SAMPLE NAGAR From SAMPLE CITY R.O.'],
      // The repeated scan is kept once.
      ['2026-03-03T08:10:30+05:30', 'IN', 'in_transit', 'SAMPLE CITY R.O.', 'Inward AT SAMPLE CITY R.O.'],
      // Late evening in UTC is the booking day in India.
      ['2026-03-02T02:00:00+05:30', 'OUT', 'in_transit', 'SAMPLE TOWN', 'Out To SAMPLE CITY R.O. From SAMPLE TOWN'],
      ['2026-03-02', null, 'accepted', 'SAMPLE TOWN', 'Booked'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/9000000|Sample Manager|calling|SAMPLE CITY"/);
  });

  it('reads an in-transit history whose scans name both centres', () => {
    const result = parseShreeAnjani(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Inward AT SAMPLE TOWN From SAMPLE CITY-HUB', last_update: '2026-07-08T10:29:28+05:30' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(rows(result)).toEqual([
      ['2026-07-08T10:29:28+05:30', 'IN', 'in_transit', 'SAMPLE TOWN', 'Inward AT SAMPLE TOWN From SAMPLE CITY-HUB'],
      ['2026-07-07T22:51:41+05:30', 'OUT', 'in_transit', 'SAMPLE CITY-HUB', 'Out To SAMPLE TOWN From SAMPLE CITY-HUB'],
      ['2026-07-07T14:31:30+05:30', 'IN', 'in_transit', 'SAMPLE CITY-HUB', 'Inward AT SAMPLE CITY-HUB From SAMPLE NAGAR'],
      ['2026-07-06T18:40:44+05:30', 'OUT', 'in_transit', 'SAMPLE NAGAR', 'Out To SAMPLE CITY-HUB From SAMPLE NAGAR'],
      ['2026-07-06', null, 'accepted', 'SAMPLE NAGAR', 'Booked'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/9000000|Sample Owner/);
  });

  it('reads a booking without scans as accepted on its day', () => {
    const result = parseShreeAnjani(changed('in-transit', (reply) => { reply.data.booking_tracking = []; }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Booked',
      last_update: null, last_update_local: '2026-07-06', events: [{ local_time: '2026-07-06', description: 'Booked' }] });
  });

  it('reads each run sheet outcome by its own words, without who took the parcel or phone numbers', () => {
    const result = parseShreeAnjani(changed('in-transit', (reply) => {
      reply.data.drs_list = [
        { from_center_name: 'SAMPLE TOWN', reason_name: 'Delivered To SAMPLE PERSON 9000000005', drs_date: '2026-07-11T06:00:00.000Z' },
        { from_center_name: 'SAMPLE TOWN', reason_name: 'Door Locked', drs_date: '2026-07-10T06:00:00.000Z' },
        { from_center_name: 'SAMPLE TOWN', reason_name: 'Consignee Not Available, call 9000000006', drs_date: '2026-07-09T06:00:00.000Z' },
        // A run sheet without its outcome yet.
        { from_center_name: 'SAMPLE TOWN', reason_name: '', drs_date: '2026-07-08T06:00:00.000Z' },
      ];
    }), IN_TRANSIT);
    expect(rows(result).slice(0, 5)).toEqual([
      ['2026-07-11T11:30:00+05:30', null, 'delivered', 'SAMPLE TOWN', 'Delivered'],
      // Wording no rule knows keeps no stage.
      ['2026-07-10T11:30:00+05:30', null, null, 'SAMPLE TOWN', 'Door Locked'],
      ['2026-07-09T11:30:00+05:30', null, 'failed_attempt', 'SAMPLE TOWN', 'Consignee Not Available, call'],
      ['2026-07-08T11:30:00+05:30', null, 'out_for_delivery', 'SAMPLE TOWN', 'Out For Delivery'],
      ['2026-07-08T10:29:28+05:30', 'IN', 'in_transit', 'SAMPLE TOWN', 'Inward AT SAMPLE TOWN From SAMPLE CITY-HUB'],
    ]);
    expect(result.events![2]!.stage_source).toMatch(/^wording:/);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-07-11T11:30:00+05:30', last_status_text: 'Delivered' });
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|9000000/);
  });

  it('takes a delivery from the booking’s status, without a name after it', () => {
    const result = parseShreeAnjani(changed('in-transit', (reply) => {
      Object.assign(reply.data.booking!, { status_name: 'DELIVERED ON 9/7/2026 TO SAMPLE PERSON', reason_name: 'DELIVERED',
        status_date: '2026-07-09T07:15:00.000Z' });
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED ON 9/7/2026', delivered_at: '2026-07-09T12:45:00+05:30', last_update: '2026-07-08T10:29:28+05:30' });
    expect(JSON.stringify(result)).not.toContain('SAMPLE PERSON');
  });

  it('keeps an unknown scan status with its route and the shared wording rules', () => {
    const result = parseShreeAnjani(changed('in-transit', (reply) => {
      reply.data.booking_tracking.unshift({ status_name: 'misroute', scanned_center_name: '', from_center_name: 'SAMPLE TOWN',
        to_center_name: 'SAMPLE VILLAGE', created_at: '2026-07-09T01:00:00Z' });
    }), IN_TRANSIT);
    expect(result.events![0]).toEqual({ time: '2026-07-09T06:30:00+05:30', location: 'SAMPLE TOWN',
      description: 'MISROUTE (SAMPLE TOWN -> SAMPLE VILLAGE)', provider_code: 'MISROUTE' });
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'MISROUTE (SAMPLE TOWN -> SAMPLE VILLAGE)' });
  });

  it('reads an empty booking as not found, and scans no one booked or a refused lookup as inconclusive', () => {
    expect(() => parseShreeAnjani(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // Stray scans under a number without a booking, which the page does not show.
    const stray = fixture('in-transit').data.booking_tracking;
    expect(() => parseShreeAnjani(changed('not-found', (reply) => { reply.data.booking_tracking = stray; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Shree Anjani has scans but no booking for the number' }));
    expect(() => parseShreeAnjani(changed('not-found', (reply) => { reply.data.booking = null; reply.data.booking_tracking = stray; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseShreeAnjani(changed('not-found', (reply) => { reply.data.booking = null; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseShreeAnjani({ success: false, message: 'Something went wrong' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps only a booking that names the number asked', () => {
    expect(() => parseShreeAnjani(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Shree Anjani answered for another shipment' }));
    expect(() => parseShreeAnjani(changed('delivered', (reply) => { reply.data.booking!.barcode_number = `${DELIVERED}0`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseShreeAnjani(changed('delivered', (reply) => { delete reply.data.booking!.barcode_number; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // An empty booking for another number is not this number's answer.
    expect(() => parseShreeAnjani(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Shree Anjani answered for another shipment' }));
    // A numeric identifier still names the number.
    expect(parseShreeAnjani(changed('delivered', (reply) => { reply.data.booking!.barcode_number = Number(DELIVERED); }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (reply: Reply) => { (reply as Row).success = 'true'; },
      (reply: Reply) => { (reply as Row).data = []; },
      (reply: Reply) => { reply.data.booking = 'booking' as never; },
      (reply: Reply) => { (reply.data as Row).booking_tracking = 'scans'; },
      (reply: Reply) => { (reply.data as Row).drs_list = {}; },
      (reply: Reply) => { reply.data.booking_tracking = Array.from({ length: 501 }, () => reply.data.booking_tracking[0]!); },
      (reply: Reply) => { reply.data.booking_tracking[0] = 'scan' as never; },
      (reply: Reply) => { reply.data.booking_tracking[0]!.created_at = '2026-03-03 06:15:00'; },
      (reply: Reply) => { reply.data.booking_tracking[0]!.created_at = '2026-03-03T06:15:00+05:30'; },
      (reply: Reply) => { reply.data.booking_tracking[0]!.created_at = '2026-02-30T06:15:00.000Z'; },
      (reply: Reply) => { delete reply.data.booking_tracking[0]!.created_at; },
      (reply: Reply) => { reply.data.booking_tracking[0]!.status_name = ''; },
      (reply: Reply) => { reply.data.booking_tracking[0]!.status_name = ['OUT']; },
      (reply: Reply) => { reply.data.drs_list[0]!.drs_date = 1772551360000; },
      (reply: Reply) => { reply.data.drs_list[0]!.reason_name = { name: 'Delivered' }; },
      (reply: Reply) => { reply.data.booking!.booking_date = '2026-03-02'; },
      (reply: Reply) => { reply.data.booking!.booking_date = '2026-02-30T00:00:00.000Z'; },
      (reply: Reply) => { reply.data.booking!.status_date = 'yesterday'; },
    ]) {
      expect(() => parseShreeAnjani(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseShreeAnjani('{}', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A booking at another moment than midnight is an instant.
    expect(parseShreeAnjani(changed('delivered', (reply) => { reply.data.booking!.booking_date = '2026-03-01T12:00:00.000Z'; }), DELIVERED)
      .events!.at(-1)).toMatchObject({ time: '2026-03-01T17:30:00+05:30', description: 'Booked' });
    // The page also reads the shipment from `item`.
    const item = fixture('delivered');
    expect(parseShreeAnjani({ success: true, item: item.data }, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('keeps an unknown number, a refused number, a moved route, a refusal, a rate limit, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>(async () => response())).track({ number: UNKNOWN });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => json({ success: false, error: 'Validation failed',
      details: [{ field: 'awbNumber', message: 'AWB must be a 10-15 digit numeric string' }] }, { status: 400 })))
      .rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(lookup(() => json({ success: false, error: 'Bad request' }, { status: 400 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response('<pre>Cannot GET /public/awb/</pre>', { status: 404, headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('', { status: 302, headers: { Location: 'https://shreeanjani.co.in/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json({ success: false, message: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '42' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 42_000 });
    await expect(lookup(() => json('Too many requests', { status: 429, headers: { 'RateLimit-Reset': '17' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 17_000 });
    await expect(lookup(() => new Response('<html><title>Attention Required! | Cloudflare</title></html>', { status: 403 })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response('<html><title>Just a moment...</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json('<html><title>SACS</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(''))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(fixture('delivered')))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number by its newest scan and an unknown one by its empty booking', async () => {
    const fetcher = service({ [DELIVERED]: fixture('delivered') });
    const shreeAnjani = carrier(fetcher);
    await expect(shreeAnjani.recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T13:46:34.000Z' });
    await expect(shreeAnjani.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(shreeAnjani.recognize!('990000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Shree Anjani does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['990000001', '9900000000000001', 'SA99000000', '990000001A', `9${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeShreeAnjaniNumber('99 0000 0011')).toBe(DELIVERED);
    expect(normalizeShreeAnjaniNumber('990000000000011')).toBe('990000000000011');
  });

  it('tries once more after a failed connection, and ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    let calls = 0;
    const flaky = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return json(fixture('delivered'));
    });
    await clock.settle(expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' }));
    expect(flaky).toHaveBeenCalledTimes(2);
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

  it('routes a number filed under Shree Anjani to the adapter', async () => {
    const fetcher = service({ [DELIVERED]: fixture('delivered') });
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'shree-anjani' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'shree-anjani', source: 'shree-anjani', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${SHREE_ANJANI_API}${DELIVERED}`)).toBe(true);
  });
});

describe('Shree Anjani numbers', () => {
  it('leaves bare ten-digit runs to other carriers’ rules, so only a number filed under Shree Anjani reaches it', () => {
    for (const number of [DELIVERED, IN_TRANSIT, '990000000000011']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('shree-anjani');
      expect(recognitionAskedCarriers(number), number).not.toContain('shree-anjani');
    }
  });
});

describe('Shree Anjani status vocabulary', () => {
  it('records every status and line the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (entry.code) expect(shreeAnjaniMappedStage(entry.code), entry.code).toBe(entry.stage);
      else if (statusMap.stage(null, entry.wording.toLowerCase())) expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'shree-anjani', providerCode: 'OUT', description: 'Out To SAMPLE TOWN From SAMPLE CITY' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'shree-anjani', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'shree-anjani', description: 'Booked' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'shree-anjani', providerCode: 'MISROUTE', description: 'MISROUTE' })).toEqual({ kind: 'unknown' });
  });
});
