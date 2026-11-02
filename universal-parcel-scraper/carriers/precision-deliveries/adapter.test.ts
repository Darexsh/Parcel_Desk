import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PRECISION_ITEM_URL, PRECISION_SESSION_URL, PrecisionTracker } from './adapter.js';
import { normalizePrecisionNumber, parsePrecision, precisionMissing } from './parser.js';
import { precisionStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'ASL1234067891';
const IN_TRANSIT = 'PRE12345678901';
const UNKNOWN = 'ASL0000000000';
const TOKEN = 'syntheticsessiontoken00000000000';

type Row = Record<string, unknown>;
type Parcel = Row & { itemid: string; scanevents: Row[] };
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Parcel;
const changed = (name: string, change: (parcel: Parcel) => void) => {
  const parcel = fixture(name);
  change(parcel);
  return parcel;
};
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const session = (cookie = `token=${TOKEN}; max-age=3600; domain=track.precisiondeliveries.com; path=/api; secure; samesite=strict; httponly`) =>
  new Response('{"message":"token created.","status":"success"}', { headers: [['Content-Type', 'application/json'], ['Set-Cookie', cookie]] });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const urls = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.map(([url]) => String(url).replace(PRECISION_ITEM_URL, 'item:'));
type Details = { request?: unknown; diagnostics?: unknown };

/** A transport that opens the page's session and answers the parcel lookup with the given replies in turn. */
function precision(...replies: (() => Response | Promise<Response>)[]) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input) === PRECISION_SESSION_URL) return session();
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    return next();
  });
}

describe('Precision Deliveries HTTP adapter', () => {
  it('opens the tracking page’s session once and asks its parcel lookup for the whole number, through the supplied transport', async () => {
    const fetcher = precision(() => json(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new PrecisionTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' pre 123456-78901 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    await expect(tracker.fetch(IN_TRANSIT)).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(urls(fetcher)).toEqual([PRECISION_SESSION_URL, `item:${IN_TRANSIT}`, `item:${IN_TRANSIT}`]);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: '{}', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', Cookie: `token=${TOKEN}`, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'precision-deliveries', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(2);
  });

  it('reads a delivered parcel newest first, with each scan’s offset and the manifest row’s wall clock', () => {
    const result = parsePrecision(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered - Mailroom/Mailbox', last_update: '2026-01-20T21:41:20-05:00', expected_delivery: null,
      delivered_at: '2026-01-20T21:41:20-05:00' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['2026-01-20T21:41:20-05:00', 'AMZ_DELIVERY_D1_LX', 'delivered', 'Delivered - Mailroom/Mailbox'],
      ['2026-01-20T09:20:30-05:00', 'AMNS1', 'out_for_delivery', 'Out for Delivery'],
      ['2026-01-20T09:05:00-05:00', 'AMNS1', 'out_for_delivery', 'Out for Delivery'],
      ['2026-01-20T07:30:45-05:00', 'AMZ_INBOUND_X4_NS', 'accepted', 'Received at Terminal'],
      // The manifest row gives the same clock twice: the page's wall clock, without an offset.
      ['2026-01-19T06:15:10', '1', 'registered', 'Manifest Scan'],
    ]);
    expect(result.events!.at(-1)).not.toHaveProperty('time');
    expect(result).not.toHaveProperty('last_update_local');
    expect(JSON.stringify(result)).not.toMatch(/Sample|X0X|000-000|example\.invalid|SMPL|U0FNUExF|45\.5|AMZ_FREIGHT|Livré/);
  });

  it('reads a parcel on its way, keeps a repeated scan once and leaves a code no map names to the wording rules', () => {
    const result = parsePrecision(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Out for Delivery', last_update: '2026-07-03T08:15:40-04:00', expected_delivery: '2026-07-03' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-07-03T08:15:40-04:00', 'AMNS1', 'out_for_delivery'],
      ['2026-07-02T11:30:20-04:00', 'ROUTE_TRANSFER', null],
      ['2026-07-02T09:45:00-04:00', 'AMZ_INBOUND_X4_NS', 'accepted'],
      ['2026-06-30T17:10:05-04:00', 'INBOUND_RCVD', 'accepted'],
      ['2026-06-29T13:02:11', '1', 'registered'],
    ]);
    // A reply listed newest first is read as it is.
    const reversed = parsePrecision(changed('in-transit', (parcel) => { parcel.scanevents.reverse(); }), IN_TRANSIT);
    expect(reversed.events!.map((event) => event.provider_code)).toEqual(result.events!.map((event) => event.provider_code));
    // A parcel whose newest scan is the manifest row is dated by its wall clock.
    const manifested = parsePrecision(changed('in-transit', (parcel) => { parcel.scanevents.splice(1); }), IN_TRANSIT);
    expect(manifested).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: null, last_update_local: '2026-06-29T13:02:11' });
  });

  it('keeps a clock without a Canadian offset as the page shows it, and rejects one it cannot read', () => {
    const clocks = (change: (row: Row) => void) => parsePrecision(changed('in-transit', (parcel) => change(parcel.scanevents.at(-1)!)), IN_TRANSIT).events![0]!;
    expect(clocks((row) => { row.scandatetimelocal = '2026-07-03 14:15:40'; })).toMatchObject({ local_time: '2026-07-03T14:15:40' });
    expect(clocks((row) => { row.scandatetimelocal = '2026-07-03 08:15:41'; })).toMatchObject({ local_time: '2026-07-03T08:15:41' });
    expect(clocks((row) => { row.scandatetimelocal = null; })).toMatchObject({ local_time: '2026-07-03T12:15:40' });
    expect(clocks((row) => { row.scandatetimelocal = '2026-07-03 09:45:40'; })).toMatchObject({ time: '2026-07-03T09:45:40-02:30' });
    expect(clocks((row) => { row.scandatetime = '2026-07-03 12:15:40.000'; })).toMatchObject({ time: '2026-07-03T08:15:40-04:00' });
    for (const value of ['03/07/2026 08:15', '2026-07-03 24:00:00', '2026-02-30 08:15:40', 20260703]) {
      expect(() => clocks((row) => { row.scandatetimelocal = value; }), String(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => clocks((row) => { row.scandatetime = null; row.scandatetimelocal = ''; })).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes the estimate’s day before a delivery and leaves out one it cannot read', () => {
    expect(parsePrecision(changed('in-transit', (parcel) => { (parcel as Row).edd = '2026-07-04'; }), IN_TRANSIT).expected_delivery).toBe('2026-07-04');
    for (const edd of [null, '', '1900-01-01 00:00:00', 'soon', '2026-02-30']) {
      expect(parsePrecision(changed('in-transit', (parcel) => { (parcel as Row).edd = edd; }), IN_TRANSIT).expected_delivery, String(edd)).toBeNull();
    }
  });

  it('reads the unknown-number reply as not found only when it names the number asked', () => {
    expect(() => precisionMissing(JSON.parse(text('not-found')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => precisionMissing({ error: 'No item was found', itemId: UNKNOWN.toLowerCase() }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => precisionMissing(JSON.parse(text('not-found')), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => precisionMissing({ error: 'No item was found' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const body of [undefined, {}, { error: 'Not Found' }, { error: 'No shipment was found', trackId: UNKNOWN }]) {
      expect(() => precisionMissing(body, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'transport' }));
    }
  });

  it('counts a parcel only when it is the number asked, in a single reply or a list', () => {
    expect(() => parsePrecision(fixture('in-transit'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePrecision(changed('delivered', (parcel) => { parcel.itemid = `${DELIVERED}0`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parsePrecision(changed('delivered', (parcel) => { parcel.itemid = ` ${DELIVERED.toLowerCase()} `; }), DELIVERED).events).toHaveLength(5);
    expect(parsePrecision([fixture('in-transit'), fixture('delivered')], DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parsePrecision([], DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePrecision(changed('delivered', (parcel) => { parcel.scanevents = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parsePrecision(changed('delivered', (parcel) => { delete (parcel as Row).scanevents; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('names a scan by its code’s description, else its code', () => {
    const result = parsePrecision(changed('in-transit', (parcel) => {
      Object.assign(parcel.scanevents[4]!, { publicstatus: null, statusdesc: 'Route Transfer' });
      Object.assign(parcel.scanevents[1]!, { publicstatus: '', statusdesc: '' });
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.description)).toEqual(['Out for Delivery', 'Route Transfer', 'Received at Terminal', 'INBOUND_RCVD', 'Manifest Scan']);
    expect(result.events![3]).toMatchObject({ stage: 'accepted', stage_source: 'carrier_map' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (parcel: Parcel) => { delete (parcel as Row).itemid; },
      (parcel: Parcel) => { (parcel as Row).itemid = 1234567890; },
      (parcel: Parcel) => { parcel.scanevents = 'scans' as never; },
      (parcel: Parcel) => { parcel.scanevents = Array.from({ length: 501 }, () => parcel.scanevents[0]!); },
      (parcel: Parcel) => { parcel.scanevents[0] = 'scan' as never; },
      (parcel: Parcel) => { parcel.scanevents[0]!.status = { code: '1' }; },
      (parcel: Parcel) => { parcel.scanevents[0]!.publicstatus = ['Manifest Scan']; },
      (parcel: Parcel) => { Object.assign(parcel.scanevents[0]!, { status: null, publicstatus: null, statusdesc: null }); },
      (parcel: Parcel) => { (parcel as Row).edd = 20260703; },
    ]) {
      expect(() => parsePrecision(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, 'parcel', [null], Array.from({ length: 21 }, () => fixture('in-transit'))]) {
      expect(() => parsePrecision(payload, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (reply: () => Response) => carrier(precision(reply)).track({ number: UNKNOWN });
    await expect(lookup(() => json(text('not-found'), 404))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => new Response(null, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('<!doctype html><title>Not Found</title>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('', { status: 302, headers: { Location: 'https://track.precisiondeliveries.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    const check = '<!DOCTYPE html><html><head><title>Just a moment...</title><script>window._cf_chl_opt={}</script></head></html>';
    await expect(lookup(() => new Response(check, { status: 403, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response(check, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response(check, { status: 404, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response('<html><title>Precision</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response(''))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json({ itemid: DELIVERED, scanevents: [] }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s from the parcel lookup as %s, without the session in the error', async (status, kind) => {
      const fetcher = precision(() => json('{"error":"synthetic"}', status));
      const error = await carrier(fetcher).track({ number: DELIVERED }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind });
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN);
      expect([(error as Details).request, (error as Details).diagnostics]).toEqual([undefined, undefined]);
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('opens the session again once when the service ends it, and reads a refused fresh one as a challenge', async () => {
    const expired = () => json('{"error":"Token expired. Please re-authenticate."}', 401);
    const fetcher = precision(expired, () => json(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new PrecisionTracker({ fetcher, recorder }).fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(urls(fetcher)).toEqual([PRECISION_SESSION_URL, `item:${DELIVERED}`, PRECISION_SESSION_URL, `item:${DELIVERED}`]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'refresh', outcome: 'ok' }));
    const refused = precision(expired);
    await expect(carrier(refused).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    expect(refused).toHaveBeenCalledTimes(4);
  });

  it('opens one session for lookups that start together, and a new one when it has no lifetime', async () => {
    const fetcher = precision(() => json(text('delivered')));
    const tracker = new PrecisionTracker({ fetcher });
    await Promise.all([tracker.fetch(DELIVERED), tracker.fetch(DELIVERED)]);
    expect(urls(fetcher).filter((url) => url === PRECISION_SESSION_URL)).toHaveLength(1);
    const brief = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input) === PRECISION_SESSION_URL
      ? session(`token=${TOKEN}; path=/api; secure`) : json(text('delivered')));
    const once = new PrecisionTracker({ fetcher: brief });
    await once.fetch(DELIVERED);
    await once.fetch(DELIVERED);
    expect(urls(brief).filter((url) => url === PRECISION_SESSION_URL)).toHaveLength(2);
  });

  it('keeps a refused or broken session apart from a missing parcel', async () => {
    const opening = (reply: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => reply())).track({ number: DELIVERED });
    await expect(opening(() => json('{"error":"Forbidden"}', 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(opening(() => json('{"error":"Unauthorized"}', 401))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(opening(() => json('{"message":"token created.","status":"success"}'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(opening(() => session('session=other; path=/'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(opening(() => new Response('<title>Just a moment...</title>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(opening(() => new Response(null, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(opening(() => json('{}', 429))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(opening(() => json('{}', 500))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    let failures = 0;
    const fetcher = precision(() => {
      if (failures++ === 0) throw new TypeError('fetch failed');
      return json(text('delivered'));
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new PrecisionTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('recognizes a known parcel and the unknown-number answer, and asks nothing for a number Precision does not issue', async () => {
    const fetcher = precision(() => json(text('delivered')), () => json(text('not-found'), 404), () => json('{}', 500));
    const direct = carrier(fetcher);
    await expect(direct.recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-21T02:41:20.000Z' });
    await expect(direct.recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(direct.recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(direct.recognize!('SE000000SMPL')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects numbers Precision does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ASL000000000', 'AS0000000000', 'ASLX000000000', 'SE000000SMPL', `ASL${'0'.repeat(22)}`, 'ASL-0000/000000']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePrecisionNumber('asl 123-406-7891')).toBe(DELIVERED);
    expect(normalizePrecisionNumber('pre12345678901')).toBe(IN_TRANSIT);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    // The first try gets half of the budget; the retry gets the rest.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under Precision, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = precision(() => json(text('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'precision-deliveries' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'precision-deliveries', source: 'precision-deliveries', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'precision-deliveries', source: 'precision-deliveries' });
    expect(fetcher.mock.calls.every(([url]) => String(url) === PRECISION_SESSION_URL || String(url).startsWith(PRECISION_ITEM_URL))).toBe(true);
  });
});

describe('Precision Deliveries numbers', () => {
  it('claims ASL and ten digits, and leaves the PRE layout unclaimed', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'precision-deliveries', confidence: 'high' });
    expect(detectCarrierMatch(IN_TRANSIT).candidates ?? []).not.toContain('precision-deliveries');
  });
});

describe('Precision Deliveries status vocabulary', () => {
  it('records every code and wording with the stage the adapter gives it', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(precisionStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'precision-deliveries', providerCode: 'AMZ_DELIVERY_D1_FP', description: 'Delivered - Front Porch' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'precision-deliveries', providerCode: 'ROUTE_TRANSFER', description: 'Route Transfer' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(precisionStage('D1NS9', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(precisionStage('ROUTE_TRANSFER', 'Route Transfer')).toBeNull();
    expect(precisionStage('amns1', 'Synthetic wording')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
  });
});
