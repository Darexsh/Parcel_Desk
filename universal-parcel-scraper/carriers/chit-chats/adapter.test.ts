import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CHIT_CHATS_SEARCH, ChitChatsTracker, chitChatsJsonUrl } from './adapter.js';
import { parseChitChats, parseChitChatsSearch } from './parser.js';
import { chitChatsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'Z9X8W7V6U5';
const PICKUP = 'Y8Q7R6S5T4';
const TRANSIT = 'X7M6N5P4Q3';
const ABSENT = 'W6A5B4C3D2';
const PIC = '9400111000001234567804';
const SESSION = '_chitchats_session=SyntheticSession%3D%3D--0123abcd';
type Shipment = Record<string, unknown> & { tracking_events: Record<string, unknown>[] };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const payload = (name: string): { shipment: Shipment } => JSON.parse(fixture(`${name}.json`));
/** The fixture's shipment, changed by `edit`. */
const edited = (name: string, edit: (shipment: Shipment) => void) => {
  const reply = payload(name);
  edit(reply.shipment);
  return reply;
};
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const redirect = (location = 'https://chitchats.com/tracking', cookie: string | null = `${SESSION}; path=/; secure; HttpOnly; SameSite=Lax`) => {
  const headers = new Headers({ Location: location });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
};
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseChitChats>) => result.events!.map(event => [event.time ?? event.local_time, event.description, event.location, event.stage]);

describe('Chit Chats tracking adapter', () => {
  it('asks the shipment JSON once through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(payload('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ChitChatsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' z9x8 w7v6 u5 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://chitchats.com/tracking/${DELIVERED}.json`);
    expect(String(url)).toBe(chitChatsJsonUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'chit-chats', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered USPS shipment: its own scans as instants, the partner scans as wall clocks, and the partner with its number', () => {
    const result = parseChitChats(payload('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Front Door/Porch', last_update: null, last_update_local: '2026-03-12T14:21:00',
      expected_delivery: null, service_name: 'Chit Chats U.S. Edge', weight_kg: 0.25, dimensions_text: '8 × 6 × 2 in',
      destination_country: 'US', delivery_carrier: 'usps', delivery_tracking_number: PIC,
      events: [
        { local_time: '2026-03-12T14:21:00', description: 'Delivered, Front Door/Porch', location: 'SPRINGVALE, NM', provider_code: 'delivered',
          stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-12T06:05:00', description: 'Out for Delivery, Expected Delivery by 9:00pm', location: 'SPRINGVALE, NM',
          provider_code: 'out_for_delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-11T22:40:00', description: 'Departed USPS Facility', location: 'MIDTOWN NM DISTRIBUTION CENTER',
          provider_code: 'in_transit', stage: 'in_transit', stage_source: 'wording:language' },
        { local_time: '2026-03-11T19:02:00', description: 'Arrived at USPS Facility', location: 'MIDTOWN NM DISTRIBUTION CENTER',
          provider_code: 'in_transit', stage: 'in_transit', stage_source: 'wording:language' },
        { local_time: '2026-03-10T18:30:00', description: 'In Transit to Next Facility', provider_code: 'in_transit', stage: 'in_transit',
          stage_source: 'wording:language' },
        { local_time: '2026-03-10T09:12:00', description: 'Accepted at USPS Facility', location: 'LAKESIDE, WA', provider_code: 'in_transit',
          stage: 'accepted', stage_source: 'wording:language' },
        { local_time: '2026-03-09T17:45:00', description: 'Shipping Label Created', location: 'LAKESIDE, WA', provider_code: 'pre_transit',
          stage: 'registered', stage_source: 'wording:language' },
        { time: '2026-03-09T16:29:51.551-07:00', description: 'In transit', provider_code: 'in_transit', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-09T08:51:58.990-07:00', description: 'Departed from Chit Chats facility', provider_code: 'in_transit', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { time: '2026-03-08T16:39:38.732-07:00', description: 'Arrived at Chit Chats facility', provider_code: 'in_transit', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { time: '2026-03-08T16:39:38.723-07:00', description: 'Received by Chit Chats', provider_code: 'in_transit', stage: 'accepted',
          stage_source: 'carrier_map' },
        { time: '2026-03-08T15:35:45.665-07:00', description: 'Shipment created, Chit Chats awaiting item', provider_code: 'pre_transit',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // Towns, postcodes, the recipient, the token, the subtitles and the routing ZIP are never read.
    expect(JSON.stringify(result)).not.toMatch(/86420|98765|NORTHPORT|V0X|SYNTHETIC|synthetictoken|Postage purchased|^420/);
  });

  it('reads a Canada Post shipment waiting at a post office in winter time, and drops postcodes and street addresses from places', () => {
    const result = parseChitChats(payload('pickup'), PICKUP);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'Final Notice; Item will be returned to sender if not collected within 10 days', last_update: null,
      last_update_local: '2026-01-20T09:15:00', expected_delivery: '2026-01-15', service_name: 'Chit Chats Canada Tracked', weight_kg: 1.588,
      destination_country: 'CA', delivery_carrier: 'canada-post', delivery_tracking_number: '9999000000000017' });
    expect(rows(result)).toEqual([
      ['2026-01-20T09:15:00', 'Final Notice; Item will be returned to sender if not collected within 10 days', 'NORTHVALE, QC', 'ready_for_pickup'],
      ['2026-01-14T13:02:00', 'Item available for pickup at Post Office', 'NORTHVALE, QC', 'ready_for_pickup'],
      ['2026-01-14T12:58:00', 'Notice card left indicating where and when to pick up item', undefined, 'failed_attempt'],
      ['2026-01-14T05:40:00', 'Item out for delivery', 'NORTHVALE, QC', 'out_for_delivery'],
      ['2026-01-13T21:10:00', 'Item processed', 'EASTHAVEN, QC', 'in_transit'],
      ['2026-01-12T17:00:00', 'Electronic information submitted by shipper', undefined, 'registered'],
      ['2026-01-12T16:44:00', 'Received from Chit Chats', 'WESTBROOK, BC', 'in_transit'],
      ['2026-01-12T15:10:35.073-08:00', 'In transit', undefined, 'in_transit'],
      ['2026-01-11T11:20:04.312-08:00', 'Received by Chit Chats', undefined, 'accepted'],
      ['2026-01-10T19:02:44.118-08:00', 'Shipment created, Chit Chats awaiting item', undefined, 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/X0X|V0V|SYNTHETIC ST/);
  });

  it('keeps a shipment Chit Chats still holds on its own clocks, without a partner', () => {
    expect(parseChitChats(payload('in-transit'), TRANSIT)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Departed from Chit Chats facility', last_update: '2026-03-31T07:48:12.204-07:00', expected_delivery: '2026-04-03',
      service_name: 'Chit Chats Select', weight_kg: 1.2, dimensions_text: '10 × 8 × 4 in', destination_country: 'CA',
      events: [
        { time: '2026-03-31T07:48:12.204-07:00', description: 'Departed from Chit Chats facility', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-30T18:03:51.977-07:00', description: 'Arrived at Chit Chats facility', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-30T18:03:51.960-07:00', description: 'Received by Chit Chats', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-03-29T21:51:42.363-07:00', description: 'Shipment created, Chit Chats awaiting item', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // Its own wording on a whole-second clock is a partner's relay of it.
    const relayed = parseChitChats(edited('in-transit', (shipment) => {
      shipment.tracking_events[0]!.created_at = '2026-03-31T07:48:12.000-07:00';
    }), TRANSIT);
    expect(relayed).toMatchObject({ last_update: null, last_update_local: '2026-03-31T07:48:12' });
  });

  it('stages wording first, a delivery or out-for-delivery status next, and a coarse status only when the wording says nothing', () => {
    const newest = (title: string, status: string | null) => parseChitChats(edited('pickup', (shipment) => {
      Object.assign(shipment.tracking_events[0]!, { title, status });
    }), PICKUP);
    expect(newest('Moved, Left no Address', 'in_transit')).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(newest('Moved, Left no Address', 'pre_transit')).toMatchObject({ current_stage: 'registered', current_stage_source: 'carrier_map' });
    expect(newest('Left in parcel locker', 'delivered')).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(newest('Customs clearance', 'in_transit')).toMatchObject({ current_stage: 'customs', current_stage_source: expect.stringMatching(/^wording:/) });
    const unknown = newest('Synthetic partner remark', null);
    expect(unknown).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Synthetic partner remark' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-01-20T09:15:00', description: 'Synthetic partner remark', location: 'NORTHVALE, QC' });
    // A confirmed delivery stands over a newest scan that says less, and clears the estimate.
    const confirmed = parseChitChats(edited('pickup', (shipment) => {
      shipment.resolution = 'delivery_confirmed';
    }), PICKUP);
    expect(confirmed).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', expected_delivery: null });
    const unstaged = parseChitChats(edited('in-transit', (shipment) => {
      shipment.tracking_events = [{ ...shipment.tracking_events[0]!, title: 'Synthetic partner remark' }];
    }), TRANSIT);
    expect(unstaged).toMatchObject({ status: 'unknown', expected_delivery: '2026-04-03' });
    expect(unstaged.current_stage).toBeUndefined();
  });

  it('drops repeated scans, keeps the partner number only when it is one, and caps a long history', () => {
    const delivered = parseChitChats(payload('delivered'), DELIVERED);
    expect(delivered.events!.filter(event => event.description === 'Arrived at USPS Facility')).toHaveLength(1);
    for (const [code, expected] of [[`420864201357${PIC}`, PIC], [`42086420${PIC}`, PIC], [PIC, PIC], ['9999 0000 0000 0017', '9999000000000017'],
      [DELIVERED, undefined], ['', undefined], [null, undefined], ['A1', undefined], ['SYN/THETIC', undefined], ['4208642013579400111000001234567805', undefined]] as const) {
      const result = parseChitChats(edited('delivered', (shipment) => {
        shipment.carrier_tracking_code = code;
      }), DELIVERED);
      expect(result.delivery_tracking_number, String(code)).toBe(expected);
    }
    for (const [partner, expected] of [['canada_post', 'canada-post'], ['usps', 'usps'], ['gtagsm', 'gta-airskip'], ['synthetic_courier', undefined], [null, undefined], ['chit_chats', undefined]] as const) {
      expect(parseChitChats(edited('delivered', (shipment) => {
        shipment.carrier = partner;
      }), DELIVERED).delivery_carrier, String(partner)).toBe(expected);
    }
    const long = parseChitChats(edited('in-transit', (shipment) => {
      const [scan] = shipment.tracking_events;
      shipment.tracking_events = Array.from({ length: 120 }, (_, index) => ({ ...scan, created_at: `2026-03-31T07:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.204-07:00` }));
    }), TRANSIT);
    expect(long).toMatchObject({ history_truncated: true });
    expect(long.events).toHaveLength(100);
  });

  it('binds the reply to the requested shipment and rejects replies it cannot read', () => {
    expect(parseChitChats(edited('delivered', (shipment) => {
      shipment.shipment_id = DELIVERED.toLowerCase();
    }), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseChitChats(payload('delivered'), PICKUP)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const broken: ((shipment: Shipment) => void)[] = [
      (shipment) => { shipment.shipment_id = 'Z9X8W7V6U4'; },
      (shipment) => { delete shipment.shipment_id; },
      (shipment) => { shipment.tracking_events = undefined as never; },
      (shipment) => { shipment.tracking_events = {} as never; },
      (shipment) => { shipment.tracking_events = Array.from({ length: 501 }, () => shipment.tracking_events[0]!); },
      (shipment) => { shipment.tracking_events[0]!.title = ''; },
      (shipment) => { shipment.tracking_events[0]!.title = { text: 'Delivered' }; },
      (shipment) => { shipment.tracking_events[0]!.created_at = '2026-03-12T14:21:00'; },
      (shipment) => { shipment.tracking_events[0]!.created_at = '2026-03-12T25:21:00.000-07:00'; },
      (shipment) => { shipment.tracking_events[0]!.created_at = null; },
      (shipment) => { shipment.tracking_events[0] = 'Delivered' as never; },
      (shipment) => { shipment.carrier = ['usps']; },
    ];
    for (const edit of broken) {
      expect(() => parseChitChats(edited('delivered', edit), DELIVERED), edit.toString()).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const reply of [null, [], {}, { shipment: [] }, { shipments: [payload('delivered').shipment] }]) {
      expect(() => parseChitChats(reply, DELIVERED), JSON.stringify(reply).slice(0, 40)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A shipment without a single scan says nothing.
    expect(() => parseChitChats(edited('delivered', (shipment) => {
      shipment.tracking_events = [];
    }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads only the search page notice naming the whole shipment ID as a missing shipment', () => {
    const page = fixture('not-found.html');
    expect(() => parseChitChatsSearch(page, ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseChitChatsSearch(page.replace(ABSENT, ABSENT.toLowerCase()), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const html of [page.replace(ABSENT, TRANSIT), page.replace(ABSENT, `${ABSENT}1`), page.replace(/new Flash\([^)]*\)/, ''),
      page.replace(`Nothing found for shipment ID ${ABSENT}`, 'Please slow down'), '<html><body></body></html>']) {
      expect(() => parseChitChatsSearch(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const html of ['<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center><hr><center>nginx</center></body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>']) {
      expect(() => parseChitChatsSearch(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('follows an unknown shipment ID to the search page once, with its session, and reads the notice there', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()).mockResolvedValueOnce(html(fixture('not-found.html')));
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[first, firstInit], [second, secondInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(String(first)).toBe(chitChatsJsonUrl(ABSENT));
    expect(new Headers(firstInit.headers).has('cookie')).toBe(false);
    expect(String(second)).toBe(CHIT_CHATS_SEARCH);
    expect(secondInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(secondInit.headers).get('cookie')).toBe(SESSION);
    const again = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect('/tracking')).mockResolvedValueOnce(html(fixture('not-found.html')));
    await expect(carrier(again).recognize!(ABSENT)).resolves.toEqual({ known: false });
  });

  it('keeps redirects elsewhere, missing sessions, other pages and HTTP errors apart from a missing shipment', async () => {
    const forbidden = '<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center><hr><center>nginx</center></body></html>';
    const cases: [Response, string][] = [
      [redirect('https://chitchats.com/login'), 'indeterminate'],
      [redirect('https://chitchats.example/tracking'), 'indeterminate'],
      [redirect('https://chitchats.com/tracking?page=2'), 'indeterminate'],
      [redirect(undefined, null), 'indeterminate'],
      [redirect(undefined, 'other_cookie=1; path=/'), 'indeterminate'],
      [json('Not Found', 404), 'indeterminate'],
      [json('Gone', 410), 'indeterminate'],
      [html(forbidden, 403), 'challenge'],
      [json('Busy', 429), 'rate_limited'],
      [json('Unavailable', 503), 'maintenance'],
      [html('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>'), 'challenge'],
      [html('<html><body>Something else</body></html>'), 'schema'],
      [json('   '), 'schema'],
    ];
    for (const [response, kind] of cases) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(carrier(fetcher).track({ number: TRANSIT }), kind).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const searches: [Response, string][] = [
      [html(fixture('not-found.html')), 'indeterminate'],
      [redirect(), 'indeterminate'],
      [html('Not Found', 404), 'indeterminate'],
      [html(forbidden, 403), 'challenge'],
      [html('Busy', 429), 'rate_limited'],
      [html('Error', 500), 'indeterminate'],
    ];
    for (const [response, kind] of searches) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()).mockResolvedValueOnce(response);
      const error = await carrier(fetcher).track({ number: TRANSIT }).catch((caught: unknown) => caught);
      expect(error, kind).toMatchObject({ kind });
      // The failure keeps no trace of the session that carried the notice.
      expect((error as { request?: unknown }).request).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain('SyntheticSession');
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('sends the lookup once more after a network failure, within the budget, without the session in the failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(payload('in-transit')));
    await expect(carrier(fetcher).track({ number: TRANSIT }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const dropped = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect()).mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(redirect()).mockRejectedValueOnce(new TypeError('fetch failed'));
    const error = await carrier(dropped).track({ number: TRANSIT }, { budgetMs: 2000 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'transport' });
    expect((error as { request?: unknown }).request).toBeUndefined();
    expect(dropped).toHaveBeenCalledTimes(4);
    const slow = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: TRANSIT }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('takes Chit Chats shipment IDs only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ABCDEFGHIJ', '1234567890', 'Z9X8W7V6U', 'Z9X8W7V6U5A', PIC, 'X'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a known shipment from plain HTTP, dated by Chit Chats\' own latest scan', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(payload('delivered'))).mockResolvedValueOnce(json(payload('pickup')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-09T23:29:51.551Z' });
    await expect(carrier(fetcher).recognize!(PICKUP)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-12T23:10:35.073Z' });
  });

  it('routes a Chit Chats shipment ID to the adapter through recognition, which detection leaves open', async () => {
    for (const number of [DELIVERED, PICKUP, TRANSIT]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['chit-chats']) });
      expect(recognitionAskedCarriers(number), number).toContain('chit-chats');
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(`${CHIT_CHATS_SEARCH}/`)
      ? json(payload('delivered')) : html('Not Found', 404)));
    // Recognition settles on recent shipments only: the fixture's week is the present.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-13T12:00:00Z') });
    try {
      const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
      expect(answer).toMatchObject({ carrier: 'chit-chats', source: 'chit-chats',
        result: { current_stage: 'delivered', delivery_carrier: 'usps', delivery_tracking_number: PIC } });
    } finally {
      vi.useRealTimers();
    }
    expect(fetcher.mock.calls.every(([url]) => String(url) === chitChatsJsonUrl(DELIVERED))).toBe(true);
  });

  it('names the partner that delivers the parcel and its own number for the hand-off', () => {
    expect(deliveryHandoff('chit-chats', DELIVERED, parseChitChats(payload('delivered'), DELIVERED)))
      .toEqual({ carrier: 'usps', number: PIC, basis: 'partner' });
    expect(deliveryHandoff('chit-chats', PICKUP, parseChitChats(payload('pickup'), PICKUP)))
      .toMatchObject({ carrier: 'canada-post', number: '9999000000000017', basis: 'partner' });
    expect(deliveryHandoff('chit-chats', TRANSIT, parseChitChats(payload('in-transit'), TRANSIT))).toBeNull();
  });
});

describe('Chit Chats status vocabulary', () => {
  it('records every status and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry ? entry.code ?? '' : '';
      const wording = 'wording' in entry ? entry.wording ?? '' : '';
      const label = `${code} ${wording}`;
      const staged = chitChatsStage(code, wording);
      expect(staged?.stage, label).toBe('stage' in entry ? entry.stage : undefined);
      // The app asks the map about what it stages itself and leaves the rest to the shared rules.
      expect(statusMap.stage(code || null, normalizeStatusWording(wording)), label)
        .toBe(staged?.source === 'carrier_map' ? staged.stage : undefined);
    }
    expect(chitChatsStage('', '  RECEIVED by  chit chats ')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    for (const [code, wording] of [['constructor', 'toString'], ['hasOwnProperty', '__proto__'], ['', '']]) {
      expect(chitChatsStage(code!, wording!), `${code} ${wording}`).toBeUndefined();
    }
    expect(statusMapAnswer({ carrier: 'chit-chats', providerCode: 'in_transit', description: 'Item available for pickup at Post Office' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'chit-chats', providerCode: 'in_transit', description: 'Arrived at USPS Facility' })).toEqual({ kind: 'unknown' });
  });
});
