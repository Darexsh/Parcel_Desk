import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GAASH_API, GAASH_PAGE, GaashTracker } from './adapter.js';
import { normalizeGaashNumber, parseGaash } from './parser.js';
import { gaashStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'GAIH12345679';
const IN_TRANSIT = 'PH1234567890';
const UNKNOWN = 'GWD000000000';
const NONCE = 'abcdef0000';

type Row = Record<string, unknown>;
type Replies = { 'parcel-tracking-data': Row & { Statuses: Row[] | null }; 'parcel-status-data': Row };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Replies;
const PAGE = readFileSync(new URL('./fixtures/page.html', import.meta.url), 'utf8');
const changed = (name: string, change: (tracking: Replies['parcel-tracking-data'], status: Row) => void) => {
  const replies = fixture(name);
  change(replies['parcel-tracking-data'], replies['parcel-status-data']);
  return replies;
};
const parse = (replies: Replies, number: string) => parseGaash(replies['parcel-tracking-data'], replies['parcel-status-data'], number);
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
// WordPress's answers to a missing and to an expired nonce.
const FORBIDDEN = { code: 'rest_forbidden', message: 'Sorry, you are not allowed to do that.', data: { status: 401 } };
const STALE = { code: 'rest_cookie_invalid_nonce', message: 'Cookie check failed', data: { status: 403 } };

/** A site that serves the page and answers each route with the fixture's reply, the status route's `no_data` as HTTP 404. */
function site(replies: Replies, options: { page?: () => Response; route?: (route: string, nonce: string | null) => Response | undefined } = {}) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.href === GAASH_PAGE) return options.page?.() ?? html(PAGE);
    const route = url.pathname.split('/').at(-1)! as keyof Replies;
    const nonce = new Headers(init?.headers).get('X-WP-Nonce');
    const own = options.route?.(route, nonce);
    if (own) return own;
    const body = replies[route];
    return reply(body, { status: body.code === 'no_data' ? 404 : 200 });
  });
}
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GAASH HTTP adapter', () => {
  it('reads the page’s nonce once and asks both of its routes with it, through the supplied transport', async () => {
    const fetcher = site(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new GaashTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(' ph 1234-567-890 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    await expect(tracker.fetch(IN_TRANSIT)).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(5);
    const [page, ...lookups] = fetcher.mock.calls;
    expect(String(page![0])).toBe(GAASH_PAGE);
    expect(page![1]).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(lookups.map(([url]) => String(url))).toEqual([
      `${GAASH_API}/parcel-tracking-data?parcel_id=${IN_TRANSIT}&lang=en`, `${GAASH_API}/parcel-status-data?parcel_id=${IN_TRANSIT}&lang=en`,
      `${GAASH_API}/parcel-tracking-data?parcel_id=${IN_TRANSIT}&lang=en`, `${GAASH_API}/parcel-status-data?parcel_id=${IN_TRANSIT}&lang=en`,
    ]);
    for (const [, init] of lookups) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', 'X-WP-Nonce': NONCE, 'Cache-Control': 'no-cache', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gaash', step: 'direct', outcome: 'ok' }));
  });

  it('keeps a parcel’s collection at its pickup point with each scan’s offset, once, without the codes or the merchant', () => {
    const result = parse(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-05-18T10:12:13+03:00', expected_delivery: null,
      delivered_at: '2026-05-18T10:12:13+03:00', pickup_point: 'Sample Pickup Shop\n1 Sample Street SAMPLE TOWN' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-05-18T10:12:13+03:00', '16', 'delivered'],
      ['2026-05-17T12:26:53+03:00', '15', 'ready_for_pickup'],
      ['2026-05-15T08:08:37+03:00', '28', 'in_transit'],
      // The repeated scan is kept once, and the one without a time is left out, as on the page.
      ['2026-05-14T21:52:08+03:00', '25', 'in_transit'],
      ['2026-05-12T10:03:19+03:00', '7', 'in_transit'],
      ['2026-05-12T09:55:23+03:00', '595', 'in_transit'],
      ['2026-05-12T09:25:07+03:00', '3', 'customs'],
      ['2026-05-04T19:50:43+03:00', '1001', 'in_transit'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.location === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/0000#5|"0000"|000000|SAMPLESHOP|Sample Couriers|without a time|IL"/);
  });

  it('reads a winter history held for checks and fees, cleared and left to another company, without the payment link', () => {
    const result = parse(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Cleared customs', last_update: '2025-12-07T17:58:00+02:00' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.description])).toEqual([
      ['7', 'in_transit', 'Cleared customs'],
      ['849', 'customs', 'Storage occured - payment is required'],
      ['912', 'customs', 'Paymant is required for a transportion check'],
      ['813', 'customs', 'Ministry of Transportation'],
      ['595', 'in_transit', 'Arrived at destination country'],
      ['813', 'customs', 'Ministry of Transportation'],
      ['1001', 'in_transit', 'Parcel is on the way to destination country'],
    ]);
    // The company that delivers is named, but not with a number of its own.
    for (const field of ['delivered_at', 'pickup_point', 'delivery_carrier', 'delivery_tracking_number']) expect(result).not.toHaveProperty(field);
    expect(JSON.stringify(result)).not.toMatch(/pay\.example|Sample Couriers|SAMPLESHOP/);
    const held = parse(changed('in-transit', (tracking) => { tracking.Statuses!.pop(); }), IN_TRANSIT);
    expect(held).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Storage occured - payment is required' });
  });

  it('takes the status reply’s word for a return, a lost or damaged parcel and a clearance that cannot go on', () => {
    const ended = (type: number) => parse(changed('delivered', (tracking, status) => {
      tracking.Statuses!.pop();
      (status.DistributionStatus as Row).StatusType = type;
    }), DELIVERED);
    expect(ended(6)).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map', last_status_text: 'Arrived at pickup location' });
    expect(ended(4)).toMatchObject({ current_stage: 'exception' });
    expect(ended(3)).toMatchObject({ current_stage: 'exception' });
    // A parcel on its way or at its pickup point keeps its scans' stage.
    expect(ended(0)).toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(ended(1)).toMatchObject({ current_stage: 'ready_for_pickup' });
    // A delivery the scans have not shown yet has no delivery time.
    expect(ended(2)).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(ended(2)).not.toHaveProperty('delivered_at');
    const stopped = parse(changed('in-transit', (tracking, status) => {
      tracking.Statuses!.pop();
      status.IsClearance = false;
      status.FinalStatuses = [{ StatusCode: 882 }];
    }), IN_TRANSIT);
    expect(stopped).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    // The page reads the delivery's status only for a parcel GAASH delivers itself.
    const other = parse(changed('in-transit', (_tracking, status) => { status.DistributionStatus = { StatusType: 6 }; }), IN_TRANSIT);
    expect(other).toMatchObject({ current_stage: 'in_transit' });
  });

  it('keeps a scan’s wall clock when it comes without an offset', () => {
    const result = parse(changed('in-transit', (tracking) => {
      for (const row of tracking.Statuses!) row.TimeZoneOffset = '';
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2025-12-07T17:58:00' });
    expect(result.events!.every((event) => event.time === undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    const fractional = parse(changed('in-transit', (tracking) => { tracking.Statuses!.at(-1)!.StatusTime = '2025-12-07T17:58:00.123'; }), IN_TRANSIT);
    expect(fractional.last_update).toBe('2025-12-07T17:58:00+02:00');
  });

  it('keeps a pickup point given as a name alone, and none when the reply gives none', () => {
    const named = parse(changed('delivered', (tracking) => { tracking.PudoDetails = ' Sample Pickup Shop '; }), DELIVERED);
    expect(named.pickup_point).toBe('Sample Pickup Shop');
    const phone = parse(changed('delivered', (tracking) => { tracking.PudoDetails = 'Sample Pickup Shop, 1 Sample Street, 000-000-0000'; }), DELIVERED);
    expect(phone.pickup_point).toBe('Sample Pickup Shop\n1 Sample Street');
    expect(parse(changed('delivered', (tracking) => { tracking.PudoDetails = null; }), DELIVERED)).not.toHaveProperty('pickup_point');
  });

  it('reads an unknown number as not found, replies that disagree as inconclusive and a parcel without scans as no history', () => {
    expect(() => parse(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const found = fixture('delivered');
    const missing = fixture('not-found');
    expect(() => parseGaash(found['parcel-tracking-data'], missing['parcel-status-data'], DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGaash(missing['parcel-tracking-data'], found['parcel-status-data'], DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(changed('delivered', (tracking) => { tracking.Statuses = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parse(changed('delivered', (tracking) => { tracking.Statuses = null; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parse(changed('delivered', (tracking) => { tracking.Statuses = [tracking.Statuses![4]!]; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a parcel only when its number or air waybill is the number asked, and its status is the same parcel’s', () => {
    expect(() => parse(fixture('in-transit'), 'PH0000000000'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GAASH answered for another shipment' }));
    expect(() => parse(changed('in-transit', (_tracking, status) => { status.Hawb = 'PH0000000000'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'GAASH answered for another shipment' }));
    // The echo of the search proves nothing.
    expect(() => parse(changed('in-transit', (tracking) => {
      tracking.TrackingNumber = 'PH0000000000';
      tracking.HAWB = 'PH0000000000';
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ message: 'GAASH answered for another shipment' }));
    // Either of the parcel's own numbers binds it.
    const byWaybill = changed('in-transit', (tracking) => { tracking.TrackingNumber = 'SAMPLEREF0'; });
    expect(parse(byWaybill, IN_TRANSIT).events).toHaveLength(7);
    const byNumber = changed('in-transit', (tracking, status) => {
      tracking.HAWB = 'GWD000000000';
      status.Hawb = 'GWD000000000';
    });
    expect(parse(byNumber, IN_TRANSIT).events).toHaveLength(7);
    expect(parse(changed('in-transit', (tracking) => { tracking.HAWB = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(7);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (tracking: Row) => { tracking.Statuses = 'scans'; },
      (tracking: Row) => { tracking.TrackingNumber = 7; },
      (tracking: Row) => { tracking.PudoDetails = ['shop']; },
      (_tracking: Row, status: Row) => { delete status.Hawb; },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses = Array.from({ length: 501 }, () => tracking.Statuses![0]!); },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses![0] = 'scan' as never; },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses![0]!.StatusTime = '20/11/2025 16:59'; },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses![0]!.StatusTime = '2025-02-30T16:59:55'; },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses![0]!.StatusTime = '2025-11-20T24:00:00'; },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses![0]!.StatusTime = '2025-11-20T16:59:55+02:00'; },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses![0]!.TimeZoneOffset = '+2'; },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses![0]!.TimeZoneOffset = 'GMT+02:99'; },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses![0]!.StatusCode = -1; },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses![0]!.StatusCode = { code: 1001 }; },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses![0]!.StatusDescription = ' '; },
      (tracking: Replies['parcel-tracking-data']) => { tracking.Statuses![0]!.StatusDescription = ['On the way']; },
    ]) {
      expect(() => parse(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseGaash('scans', {}, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGaash({}, null, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the page again when its kept nonce is refused, and fails when the page’s own nonce is', async () => {
    let now = 0;
    let current = NONCE;
    const pages = vi.fn(() => html(PAGE.replace(NONCE, current)));
    const fetcher = site(fixture('delivered'), { page: pages,
      route: (_route, nonce) => (nonce === current ? undefined : reply(STALE, { status: 403 })) });
    const tracker = new GaashTracker({ fetcher, now: () => now });
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    current = 'abcdef1111';
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(pages).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('X-WP-Nonce')))
      .toEqual([null, NONCE, NONCE, NONCE, NONCE, null, 'abcdef1111', 'abcdef1111']);
    // A kept nonce is read again after an hour.
    now += 60 * 60_000;
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(pages).toHaveBeenCalledTimes(3);

    const refusing = site(fixture('delivered'), { route: () => reply(FORBIDDEN, { status: 401 }) });
    await expect(carrier(refusing).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
    expect(refusing).toHaveBeenCalledTimes(3);
  });

  it('keeps a moved page or route, a refusal, a browser check, a throttle and a broken reply apart', async () => {
    const lookup = (options: Parameters<typeof site>[1]) => carrier(site(fixture('delivered'), options)).track({ number: DELIVERED });
    const routed = (response: () => Response) => lookup({ route: (route) => (route === 'parcel-status-data' ? response() : undefined) });
    await expect(lookup({ page: () => html('<html><title>Track Parcel</title></html>') })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ page: () => html('<html><script>window._cf_chl_opt = {}</script></html>') })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ page: () => html('', { status: 301, headers: { Location: 'https://gaashwd.com/' } }) })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ page: () => html('', { status: 403 }) })).rejects.toMatchObject({ kind: 'challenge' });
    // WordPress's own answer to a route it does not have.
    await expect(routed(() => reply({ code: 'rest_no_route', data: { status: 404 } }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(routed(() => html('<html>Not found</html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(routed(() => reply('', { status: 302, headers: { Location: 'https://gaashwd.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(routed(() => html('<html><title>Attention Required! | Cloudflare</title></html>', { status: 403 })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(routed(() => html('<html><title>Just a moment...</title></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(routed(() => html('<html><title>GAASH</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(routed(() => reply('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(routed(() => reply('', { status: 500 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(routed(() => reply('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number GAASH does not issue', async () => {
    const known = carrier(site(fixture('delivered')));
    await expect(known.recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-18T07:12:13.000Z' });
    const unknown = site(fixture('not-found'));
    await expect(carrier(unknown).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(unknown).recognize!('GWD00000000')).resolves.toEqual({ known: false });
    expect(unknown).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers GAASH does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['GWD00000000', 'GAIH123456789', 'PH123456789', 'GAAS12345678', 'SAMPLETRACKING', `GWD${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGaashNumber('gaih 1234-5679')).toBe(DELIVERED);
  });

  it('ends a hanging read inside the budget and tries it once more', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a number filed under GAASH to the adapter', async () => {
    const fetcher = site(fixture('delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'gaash' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'gaash', source: 'gaash', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(GAASH_API))).toBe(true);
  });
});

describe('GAASH status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(gaashStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'gaash', providerCode: '15', description: 'Arrived at pickup location' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'gaash', providerCode: '999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(gaashStage('999', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(gaashStage('999', 'Synthetic note')).toBeNull();
  });
});
