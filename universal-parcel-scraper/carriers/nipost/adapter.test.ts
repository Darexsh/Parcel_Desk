import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { actionId, discoverActionId, lookupCall, MAX_CHUNKS, pageChunks } from './action.js';
import { adapter, NIPOST_ACTION, NIPOST_PAGE, NipostTracker } from './adapter.js';
import { normalizeNipostNumber, parseNipost, UnknownActionError } from './parser.js';
import { nipostKeyStage, nipostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ000000014NG';
const IN_TRANSIT = 'ZZ000000028NG';
const UNKNOWN = 'ZZ000000031NG';
const INBOUND = 'ZZ000000045CN';
const RSC = 'text/x-component';
const HEAD = '0:["$@1",["SampleBuild0000000000",null]]';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
type Scan = Record<string, unknown>;
type Item = Record<string, unknown> & { events: Scan[] };
type Result = { data: Item[] | null; error: unknown };
const rows = (name: string) => text(name).trimEnd().split('\n');
const resultOf = (name: string) => JSON.parse(rows(name).find(row => row.startsWith('1:'))!.slice(2)) as Result;
const flight = (result: unknown, ...extra: string[]) => `${[HEAD, `1:${JSON.stringify(result)}`, ...extra].join('\n')}\n`;
/** A fixture with its result row changed; its other rows stay. */
const edited = (name: string, change: (item: Item, result: Result) => void) => {
  const result = resultOf(name);
  change(result.data![0]!, result);
  return flight(result, ...rows(name).filter(row => !/^[01]:/.test(row)));
};
const parse = (body: string, number: string) => parseNipost(body, RSC, number);
const reply = (body: string, status = 200, type = RSC) => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('NIPOST tracking adapter', () => {
  it('calls the tracking page’s server action for the whole code once, as the page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered.txt')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NipostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 ng ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${NIPOST_PAGE}${DELIVERED}`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: JSON.stringify([DELIVERED]),
      headers: { Accept: RSC, 'Content-Type': 'text/plain;charset=UTF-8', 'Next-Action': NIPOST_ACTION, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'nipost', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a domestic delivery newest first, with the reply’s Dates as instants and its outlined scan once', () => {
    const result = parse(text('delivered.txt'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Item delivered to the addressee', last_update: '2026-05-06T10:41:07Z', expected_delivery: null,
      delivered_at: '2026-05-06T10:41:07Z', destination_country: 'NG' });
    expect(result.events!.map(event => [event.time, event.location, event.description, event.provider_code, event.stage, event.stage_source])).toEqual([
      ['2026-05-06T10:41:07Z', 'Example City Post Office', 'Item delivered to the addressee', 'DELIVERED', 'delivered', 'carrier_map'],
      ['2026-05-06T07:30:00Z', 'Example City Post Office', 'Out for delivery', 'OUT_FOR_DELIVERY', 'out_for_delivery', 'carrier_map'],
      ['2026-05-05T06:02:00Z', 'Sample Mail Processing Centre', 'Dispatched to the delivery office', 'IN_TRANSIT', 'in_transit', 'carrier_map'],
      ['2026-05-04T16:40:00Z', 'Sample Mail Processing Centre', 'Arrived at the sorting hub', 'AT_HUB', 'in_transit', 'carrier_map'],
      // The page's first status leaves the stage to the wording.
      ['2026-05-04T08:15:00Z', 'Sample Town Post Office', 'Shipment created', 'PENDING', 'registered', 'wording:language'],
    ]);
    expect(result.events!.every(event => event.local_time === undefined)).toBe(true);
    expect(result).not.toHaveProperty('last_update_local');
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE-0001|Sample State|Example State|Location:|SAMPLE TOWN/);
  });

  it('keeps clocks without an offset as wall clocks, to the second, and dates no delivery from them', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit.txt')));
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Dispatched to Example City',
      last_update: null, last_update_local: '2026-06-02T18:40:00', destination_country: 'NG' });
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-06-02T18:40:00', 'IN_TRANSIT', 'in_transit'],
      ['2026-06-02T14:05:10', 'AT_HUB', 'in_transit'],
      ['2026-06-01T09:05:12', 'PENDING', 'accepted'],
    ]);
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
    const wall = parse(edited('delivered.txt', (item) => {
      item.events = item.events.slice(0, 4).map((scan, index) => ({ ...scan, timestamp: `2026-05-0${index + 4}T09:00` }));
      item.events.push({ ...item.events[3]!, status: { key: 'DELIVERED', value: 'Delivered' }, description: 'Delivered', timestamp: '2026-05-08T09:00' });
      item.date_delivered = '2026-05-08T09:00:00';
    }), DELIVERED);
    expect(wall).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-05-08T09:00' });
    expect(wall).not.toHaveProperty('delivered_at');
  });

  it('reads mail from abroad held for customs at each scan’s own offset, without its customs payment', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('inbound.txt')));
    const result = await carrier(fetcher).track({ number: INBOUND });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Presented to customs',
      last_update: '2026-03-09T10:15:00+01:00', destination_country: 'NG' });
    expect(result.events!.map(event => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-03-09T10:15:00+01:00', 'CUSTOMS_CLEARANCE', 'customs'],
      ['2026-03-09T07:45:00+01:00', 'AT_HUB', 'in_transit'],
      ['2026-03-02T11:20:00+08:00', 'IN_TRANSIT', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/example\.invalid|SAMPLE-LINK|Unpaid|12500|NGN|China/);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('turns any order round, keeps a repeated scan once and leaves unknown keys and wordings to the wording rules', () => {
    const reference = parse(text('delivered.txt'), DELIVERED).events!.map(event => event.time);
    const reversed = parse(edited('delivered.txt', (item) => { item.events.reverse(); }), DELIVERED);
    expect(reversed.events!.map(event => event.time)).toEqual(reference);
    const repeated = parse(edited('delivered.txt', (item) => { item.events.splice(1, 0, item.events[1]!); }), DELIVERED);
    expect(repeated.events).toHaveLength(5);
    const later = (scan: Scan): Scan => ({ ...scan, timestamp: '2026-06-03T08:00' });
    const unknown = parse(edited('in-transit.txt', (item) => {
      item.events.push(later({ ...item.events[2]!, status: { key: 'sample_key', value: 'Sample' }, description: 'Sample wording', location_description: null }));
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Sample wording',
      last_update_local: '2026-06-03T08:00' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-06-03T08:00', description: 'Sample wording', provider_code: 'SAMPLE_KEY' });
    const alone = parse(edited('in-transit.txt', (item) => {
      item.events = [{ ...item.events[0]!, status: { key: 'PENDING', value: 'Pending' }, description: null }];
    }), IN_TRANSIT);
    expect(alone).toMatchObject({ status: 'unknown', last_status_text: 'Pending' });
    expect(alone.current_stage).toBeUndefined();
    const keyOnly = parse(edited('in-transit.txt', (item) => {
      item.events.push(later({ ...item.events[2]!, status: { key: 'delivery_attempted', value: null }, description: '' }));
    }), IN_TRANSIT);
    expect(keyOnly).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Delivery Attempted' });
    expect(keyOnly.events![0]!.provider_code).toBe('DELIVERY_ATTEMPTED');
    // Scans at one clock show the reply's later one first, as the page lists them.
    const tied = parse(edited('in-transit.txt', (item) => {
      item.events.push({ ...item.events[2]!, status: { key: 'OUT_FOR_DELIVERY', value: 'Out For Delivery' }, description: 'Out for delivery' });
    }), IN_TRANSIT);
    expect(tied.events!.slice(0, 2).map(event => event.provider_code)).toEqual(['OUT_FOR_DELIVERY', 'IN_TRANSIT']);
    const explicit = parse(edited('in-transit.txt', (item) => {
      item.events.push({ ...item.events[2]!, timestamp: '2026-06-02T19:41:00.250Z', description: '$$5 duty noted' });
    }), IN_TRANSIT);
    expect(explicit).toMatchObject({ last_update: '2026-06-02T19:41:00.250Z', last_status_text: '$5 duty noted' });
    expect(explicit).not.toHaveProperty('last_update_local');
  });

  it('reads text rows and references, and the item by either of its codes', () => {
    const description = 'Arrived at the sorting hub ✓';
    const outlined = edited('in-transit.txt', (item) => { item.events[1]!.description = '$3'; });
    const bytes = new TextEncoder().encode(description).length.toString(16);
    expect(parse(`${outlined}3:T${bytes},${description}`, IN_TRANSIT).events![1]!.description).toBe(description);
    expect(parse(edited('in-transit.txt', (item) => { item.tracking_number = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(3);
    expect(parse(edited('delivered.txt', (item) => { item.tracking_number = null; }), DELIVERED).events).toHaveLength(5);
    expect(parse(edited('delivered.txt', (item) => { item.destination = null; }), DELIVERED)).not.toHaveProperty('destination_country');
    expect(parse(edited('delivered.txt', (item) => { item.destination = { country: { code: 'Nigeria' } }; }), DELIVERED))
      .not.toHaveProperty('destination_country');
  });

  it('reads the lookup’s not-found answer as missing, and its other answers as inconclusive', async () => {
    expect(() => parse(text('not-found.txt'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const lookup = (body: string, status = 200, type = RSC) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type)))
      .track({ number: UNKNOWN });
    await expect(lookup(text('not-found.txt'))).rejects.toMatchObject({ kind: 'not_found' });
    for (const result of [{ data: null, error: 'Failed to fetch tracking information' }, { data: [], error: null }, { data: null, error: null },
      { data: [{ tracking_number: UNKNOWN }], error: 'Tracking number not found' }]) {
      await expect(lookup(flight(result)), JSON.stringify(result)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    await expect(lookup(flight({ data: null, error: 'Too many requests, please try again later' }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(`${HEAD}\n1:E{"digest":"1234567890"}\n`)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(`${HEAD}\n1:E{"digest":"NEXT_REDIRECT;replace;/;307;"}\n`)).rejects.toMatchObject({ kind: 'schema' });
    expect(() => parse(edited('in-transit.txt', (item) => { item.events = []; }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CHECK, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Request blocked</body></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    // An action id the page no longer has gets the page itself, with HTTP 200.
    await expect(lookup(text('page.html'), 200, 'text/html; charset=utf-8')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"data":null,"error":"Tracking number not found"}', 200, 'application/json')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds the reply to the whole requested code and rejects changed replies', () => {
    expect(() => parse(text('delivered.txt'), 'ZZ000000045NG'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'NIPOST answered for a different item' }));
    const scan = (change: (scan: Scan) => void) => edited('in-transit.txt', (item) => { change(item.events[1]!); });
    for (const body of [
      `${HEAD}\n`, `0:["x",[]]\n1:{"data":null,"error":null}\n`, `${HEAD}\n2:{"data":null,"error":null}\n`, flight([]), flight({ error: null }),
      flight({ data: {}, error: null }), flight({ data: null, error: 7 }), `${HEAD}\n1:"$1"\n`, `${HEAD}\n1:{"data":"$2","error":null}\n`,
      `${HEAD}\nzz:{}\n`, `${HEAD}\n1:T10,short\n`,
      edited('delivered.txt', (_item, result) => { result.data!.push(result.data![0]!); }),
      edited('delivered.txt', (item) => { item.tracking_number = null; item.code = null; }),
      edited('delivered.txt', (item) => { item.tracking_number = 7; }),
      edited('delivered.txt', (item) => { (item as Record<string, unknown>).events = {}; }),
      edited('delivered.txt', (item) => { item.destination = 'Nigeria'; }),
      edited('delivered.txt', (item) => { item.events = Array.from({ length: 501 }, () => item.events[0]!); }),
      edited('in-transit.txt', (item) => { (item.events as unknown[])[1] = 'scan'; }),
      scan((row) => { row.status = 'AT_HUB'; }),
      scan((row) => { row.status = { key: 'AT HUB!' }; }),
      scan((row) => { row.status = null; row.description = null; }),
      scan((row) => { row.description = ['Arrived']; }),
      scan((row) => { row.description = '$Sreact.element'; }),
      scan((row) => { row.location_description = 7; }),
      scan((row) => { row.timestamp = '02/06/2026 14:05'; }),
      scan((row) => { row.timestamp = '2026-02-30T14:05:10'; }),
      scan((row) => { row.timestamp = '2026-06-02T24:05:10'; }),
      scan((row) => { row.timestamp = '2026-06-02'; }),
      scan((row) => { row.timestamp = '$Dnot a date'; }),
      scan((row) => { row.timestamp = 1780000000000; }),
      scan((row) => { row.timestamp = null; }),
    ]) {
      expect(() => parse(body, IN_TRANSIT), body.slice(0, 160)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseNipost(new Uint8Array([0x30, 0x3a, 0x22, 0xff, 0x22, 0x0a]), RSC, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes S10 codes with a valid check digit, from any post, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ000000015NG', 'ZZ00000001NG', 'ZZ000000014NGX', `${DELIVERED},${IN_TRANSIT}`, '1234567890123', 'SAMPLETRACKING',
      `ZZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeNipostNumber(' zz-000-000-045 cn ')).toBe(INBOUND);
  });

  it('recognizes a known item and an unknown code from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered.txt'))).mockResolvedValueOnce(reply(text('in-transit.txt')))
      .mockResolvedValueOnce(reply(text('not-found.txt')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-06T10:41:07.000Z' });
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-06-02T18:40:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Too Many Requests',
      { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'transport'], [405, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found.txt'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered.txt')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered.txt')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes an item filed under NIPOST to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered.txt')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'nipost' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'nipost', source: 'nipost', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${NIPOST_PAGE}${DELIVERED}`)).toBe(true);
  });

  it('is asked about Nigerian S10 codes, which detection leaves with the postal fallback, and is not yet handed mail bound for Nigeria', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers(DELIVERED)[0]).toBe('nipost');
    expect(recognitionAskedCarriers('ZZ000000015NG')).not.toContain('nipost');
    expect(recognitionAskedCarriers(INBOUND)).not.toContain('nipost');
    expect(parseTrackingInput(`https://tracking.nipost.gov.ng/${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'nipost', source: 'link' });
    const bound: CarrierResult = { status: 'in_transit', last_status_text: 'Dispatched from the origin country', destination_country: 'NG', events: [] };
    // No inbound item has answered yet, so a result naming Nigeria hands nothing over.
    expect(deliveryHandoff('intl-post', INBOUND, bound)).toBeNull();
  });
});

const FRESH = '0123456789abcdef0123456789abcdef01234567';
const HTML = 'text/html; charset=utf-8';
const PAGE = `${NIPOST_PAGE}${DELIVERED}`;
const chunkUrl = (path: string) => `https://tracking.nipost.gov.ng/_next/static/chunks/${path}`;
const PAGE_CHUNK = chunkUrl('app/%5Bid%5D/page-0a0a0a0a0a0a0a0a.js');
const LAYOUT_CHUNK = chunkUrl('app/layout-1b1b1b1b1b1b1b1b.js');
const ACTION_CHUNK = chunkUrl('101-0c0c0c0c0c0c0c0c.js');
const SHARED_CHUNK = chunkUrl('202-0d0d0d0d0d0d0d0d.js');
const LAYOUT = '(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[185],{9000:function(e,t,n){Promise.resolve().then(n.bind(n,9100))}},function(e){e.O(0,[744],function(){return e(e.s=9000)}),_N_E=e.O()}]);';
// Another module of the same chunk set exports a reference under the page's name.
const DECOY = '(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[202],{6000:function(e,t,n){n.d(t,{Q7:function(){return r}});var s=n(4100),r=(0,s.$)("5555555555555555555555555555555555555555")}}]);';
type Site = { live: string; unknown: () => Response; page: () => Response; chunks: Record<string, string> };
const headerOf = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name];

/** NIPOST's site after a release: only `live` answers, and the page's chunks name `FRESH`. */
function site(change: Partial<Site> = {}) {
  const state: Site = { live: FRESH, unknown: () => reply(text('page.html'), 200, HTML), page: () => reply(text('page.html'), 200, HTML),
    ...change,
    chunks: { [PAGE_CHUNK]: text('route-chunk.js'), [LAYOUT_CHUNK]: LAYOUT, [ACTION_CHUNK]: text('action-chunk.js'), [SHARED_CHUNK]: DECOY, ...change.chunks } };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') return headerOf(init, 'Next-Action') === state.live ? reply(text('delivered.txt')) : state.unknown();
    if (url === PAGE) return state.page();
    const chunk = state.chunks[url];
    return chunk === undefined ? new Response('Not Found', { status: 404 }) : reply(chunk, 200, 'application/javascript');
  });
  const calls = () => fetcher.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}${init?.method === 'POST' ? ` ${headerOf(init, 'Next-Action')}` : ''}`);
  return { state, fetcher, calls };
}

const stepsOf = (step: ReturnType<typeof vi.fn>) => step.mock.calls.map(([event]) => {
  const { step: id, outcome } = event as { step: string; outcome: string };
  return [id, outcome];
});

describe('NIPOST action discovery', () => {
  it('reads the id the page binds to its lookup when the tracker no longer has its own, tries it once and starts there next time', async () => {
    const { fetcher, calls } = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new NipostTracker({ fetcher, recorder });
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    // The route's chunks first, then only the shared chunks the route loads; never runtime, vendor, foreign or unlisted ones.
    expect(calls()).toEqual([`POST ${PAGE} ${NIPOST_ACTION}`, `GET ${PAGE}`, `GET ${PAGE_CHUNK}`, `GET ${LAYOUT_CHUNK}`,
      `GET ${SHARED_CHUNK}`, `GET ${ACTION_CHUNK}`, `POST ${PAGE} ${FRESH}`]);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal && init.redirect === 'manual')).toBe(true);
    expect(stepsOf(recorder.step))
      .toEqual([['direct', 'schema'], ['action', 'ok']]);
    fetcher.mockClear();
    await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(calls()).toEqual([`POST ${PAGE} ${FRESH}`]);
  });

  it('goes back to its own id when the one it read expires or stops answering', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { state, fetcher, calls } = site();
      const tracker = new NipostTracker({ fetcher });
      await tracker.fetch(DELIVERED);
      vi.setSystemTime(Date.now() + 6 * 3_600_000 + 1);
      fetcher.mockClear();
      await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
      expect(calls()[0]).toBe(`POST ${PAGE} ${NIPOST_ACTION}`);
      // A release that brings the old id back.
      state.live = NIPOST_ACTION;
      state.chunks[ACTION_CHUNK] = text('action-chunk.js').replace(FRESH, NIPOST_ACTION);
      fetcher.mockClear();
      await expect(tracker.fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
      expect(calls().filter(call => call.startsWith('POST'))).toEqual([`POST ${PAGE} ${FRESH}`, `POST ${PAGE} ${NIPOST_ACTION}`]);
      fetcher.mockClear();
      await tracker.fetch(DELIVERED);
      expect(calls()).toEqual([`POST ${PAGE} ${NIPOST_ACTION}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes Next’s 404 for an unknown action as a changed id, not as a missing item', async () => {
    const { fetcher, calls } = site({ unknown: () => new Response('Server action not found.',
      { status: 404, headers: { 'Content-Type': 'text/plain', 'x-nextjs-action-not-found': '1' } }) });
    await expect(carrier(fetcher).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(calls().at(-1)).toBe(`POST ${PAGE} ${FRESH}`);
    expect(() => parseNipost('Server action not found.', 'text/plain', DELIVERED)).toThrow(UnknownActionError);
    // A missing page is the tracker being away, never a missing item.
    const gone = site({ unknown: () => new Response('Not Found', { status: 404 }), page: () => new Response('Not Found', { status: 404 }) });
    await expect(carrier(gone.fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(carrier(gone.fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'transport' });
    expect(gone.calls()).toEqual([`POST ${PAGE} ${NIPOST_ACTION}`, `GET ${PAGE}`, `POST ${PAGE} ${NIPOST_ACTION}`, `GET ${PAGE}`]);
  });

  it('fails as a changed lookup, never as a missing item, when the page binds no new id to it', async () => {
    const route = text('route-chunk.js');
    const action = text('action-chunk.js');
    for (const change of [
      { chunks: { [PAGE_CHUNK]: route.replace('x(e.data),h(e.error)', 'x(e.items)') } },
      { chunks: { [PAGE_CHUNK]: route.replace('k(!1)})()', 'k(!1);let o=await (0,c.R2)(t);x(o.data),h(o.error)})()') } },
      { chunks: { [ACTION_CHUNK]: action.replace(`var i=(0,s.$)("${FRESH}")`, 'var i=s.$') } },
      { chunks: { [ACTION_CHUNK]: action.replace('{createServerReference:t}', '{callServer:t}') } },
      { chunks: { [ACTION_CHUNK]: action.replace('4200:function', '4299:function') } },
      { chunks: { [ACTION_CHUNK]: action.replace(FRESH, NIPOST_ACTION) } },
      { page: () => reply(text('page.html').replace(/<script src="\/_next\/static\/chunks\/app\/[^>]*><\/script>/g, ''), 200, HTML) },
      { live: '' },
    ] satisfies Partial<Site>[]) {
      const { fetcher, calls } = site(change);
      const lookup = carrier(fetcher).track({ number: DELIVERED });
      await expect(lookup, JSON.stringify(change)).rejects.toMatchObject({ kind: 'schema', message: expect.stringContaining('the tracking lookup changed') });
      expect(calls().filter(call => call.startsWith('POST')).length).toBeLessThanOrEqual(2);
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('keeps a browser check, a failed connection and an oversized page or chunk as they are', async () => {
    const checked = site({ page: () => reply(CHECK, 200, 'text/html') });
    await expect(carrier(checked.fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    // A page that fails to load is read again by the retry, which then asks with the new id.
    const flaky = site();
    let failed = false;
    const page = flaky.state.page;
    flaky.state.page = () => {
      if (failed) return page();
      failed = true;
      throw new TypeError('fetch failed');
    };
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NipostTracker({ fetcher: flaky.fetcher, recorder }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(stepsOf(recorder.step))
      .toEqual([['direct', 'schema'], ['action', 'transport'], ['retry', 'ok']]);
    expect(flaky.calls().at(-1)).toBe(`POST ${PAGE} ${FRESH}`);
    const large = site({ chunks: { [PAGE_CHUNK]: text('route-chunk.js').padEnd(600_000) } });
    await expect(carrier(large.fetcher).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
    const bulky = site({ page: () => reply('<html>'.padEnd(400_000), 200, HTML) });
    await expect(carrier(bulky.fetcher).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('reads the page and its chunks inside the lookup’s budget and signal', async () => {
    const { fetcher } = site();
    const hanging = vi.fn<typeof fetch>((input, init) => init?.method === 'GET'
      ? new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); })
      : fetcher(input, init));
    await expect(carrier(hanging).track({ number: DELIVERED }, { budgetMs: 40.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(hanging.mock.calls.filter(([, init]) => init?.method === 'GET').every(([, init]) => init?.signal?.aborted)).toBe(true);
    const cancelled = new AbortController();
    const stop = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'GET') cancelled.abort(new Error('cancelled'));
      return fetcher(input, init);
    });
    await expect(carrier(stop).track({ number: DELIVERED }, { signal: cancelled.signal })).rejects.toThrow();
    expect(stop.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('binds only the id the lookup call’s export is built from, and reads a few chunks at most', async () => {
    const route = text('route-chunk.js');
    const call = lookupCall([route]);
    expect(call).toEqual({ module: '4200', name: 'Q7', chunks: new Set(['101', '202', '744']) });
    expect(actionId([text('action-chunk.js')], call!)).toBe(FRESH);
    expect(actionId([DECOY], call!)).toBeUndefined();
    expect(actionId([text('action-chunk.js')], { ...call!, name: 'Z' })).toBeUndefined();
    // Next 15 calls createServerReference in the action's module, with arrow functions.
    const direct = `{4200:(e,t,a)=>{"use strict";a.d(t,{Q7:()=>i});var s=a(8600);let i=(0,s.createServerReference)("00${FRESH}",s.callServer,void 0,s.findSourceMapURL,"trackItem")},4300:(e,t,a)=>{}}`;
    expect(actionId([direct], call!)).toBe(`00${FRESH}`);
    expect(pageChunks(text('page.html'), PAGE)).toEqual([chunkUrl('aa11bb22-0e0e0e0e0e0e0e0e.js'), SHARED_CHUNK, ACTION_CHUNK,
      chunkUrl('303-0b0b0b0b0b0b0b0b.js'), LAYOUT_CHUNK, PAGE_CHUNK]);
    const many = Array.from({ length: 12 }, (_, index) => chunkUrl(`${index + 1}-0f0f0f0f0f0f0f0f.js`));
    const html = [...many, PAGE_CHUNK].map(url => `<script src="${url}" async=""></script>`).join('');
    const read = vi.fn(async (url: string) => url === PAGE_CHUNK
      ? route.replace('[101,202,744]', `[${many.map((_, index) => index + 1).join(',')}]`) : DECOY);
    await expect(discoverActionId(html, PAGE, read)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(MAX_CHUNKS);
  });
});

describe('NIPOST status vocabulary', () => {
  it('maps every key and wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry && typeof entry.code === 'string' ? entry.code : null;
      if (code !== null) {
        expect(nipostKeyStage(code), code).toBe(entry.stage);
        expect(statusMap.stage(code, 'synthetic wording'), code).toBe(entry.stage);
      }
      expect(nipostStage(code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'nipost', providerCode: code, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'nipost', providerCode: 'PENDING', description: 'Pending' })).toMatchObject({ kind: 'intentional_gap' });
    expect(nipostStage(' in_transit ', '')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    for (const key of ['constructor', 'toString', 'PENDING', 'SAMPLE_KEY', '']) expect(nipostKeyStage(key), key).toBeUndefined();
    expect(nipostStage('', '')).toBeNull();
  });
});
