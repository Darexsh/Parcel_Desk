import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SKYKING_KEY_URL, SKYKING_TRACK_URL, SkykingTracker } from './adapter.js';
import { normalizeSkykingNumber, parseSkyking, skykingWording } from './parser.js';
import { skykingStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000011';
const IN_TRANSIT = '300000022';
const UNKNOWN = '900000055';
const OLDER = '11000066';
const KEY = 'U3ludGhldGljS2V5'.repeat(8);

type Row = Record<string, unknown>;

const fixture = (name: string): Row[] => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const edited = (name: string, edit: (rows: Row[]) => void) => {
  const rows = fixture(name);
  edit(rows);
  return rows;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html' } });
/** A transport that issues the page key and answers each lookup with the reply given. */
const site = (lookup: (url: string) => Response) => vi.fn<typeof fetch>().mockImplementation(async (url) =>
  String(url) === SKYKING_KEY_URL ? json(KEY) : lookup(String(url)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookupUrl = (number: string) => `${SKYKING_TRACK_URL}?cnote=${number}&key=skm&Email=skm%40flyking.co.in`;

describe('SkyKing HTTP adapter', () => {
  it('asks for the page key, then looks the whole number up with it as the tracking page does, through the supplied transport', async () => {
    const fetcher = site(() => json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SkykingTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 000 11 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[keyUrl, keyInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(keyUrl).toBe('https://live.skyking.co/api/Track/GetAPIKeyValue');
    expect(keyInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(keyInit.headers).not.toHaveProperty('KeyValue');
    expect(url).toBe(lookupUrl(DELIVERED));
    expect(url).toBe('https://live.skyking.co/api/Track/ConsignmentMTrack_WebSite_AuthNew?cnote=100000011&key=skm&Email=skm%40flyking.co.in');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', KeyValue: KEY, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'skyking', step: 'direct', outcome: 'ok' }));
  });

  it('reads Indian wall clocks at UTC+5:30 and stages each scan by its wording, newest first', () => {
    const result = parseSkyking(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-09-14T10:48:09Z', delivered_at: '2026-09-14T10:48:09Z',
      expected_delivery: null, timezone: 'Asia/Kolkata' });
    expect(result.events!.map((event) => [event.time, event.location, event.stage, event.description])).toEqual([
      ['2026-09-14T10:48:09Z', 'MARKET ROAD, SAMPLEPUR', 'delivered', 'Delivered'],
      ['2026-09-14T04:32:31Z', 'MARKET ROAD, SAMPLEPUR', 'out_for_delivery', 'Out For Delivery'],
      // The repeated forwarding scan is kept once; its wording keeps the place it names.
      ['2026-09-12T07:45:44Z', 'SAMPLEPUR HUB FACILITY', 'in_transit', 'FORWARDED TO MARKET ROAD, SAMPLEPUR'],
      ['2026-09-12T03:10:03Z', 'SAMPLEPUR HUB FACILITY', 'in_transit', 'INBOUND SCAN DONE'],
      ['2026-09-11T13:35:12Z', 'NORTHPUR HUB FACILITY', 'in_transit', 'FORWARDED TO SAMPLEPUR HUB FACILITY'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !event.local_time && !event.provider_code)).toBe(true);
    expect(result).not.toHaveProperty('history_truncated');
  });

  it('keeps no courier, delivery area, signing detail, phone number, reference, id or image link', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      const text = JSON.stringify(parseSkyking(fixture(name), number));
      expect(text, name).not.toMatch(/ASHA|RAVI|SAMPLE"|Area|Boy|GREEN PARK|LAKE VIEW|Stamp|Signature|Item|98765|43210|SMPL|0412|MNF|DRS|pod\.example|BKG|View POD/);
    }
    expect(skykingWording('Out For Delivery, Area Name: SAMPLE AREA., Delivery Boy: SAMPLE NAME')).toBe('Out For Delivery');
    expect(skykingWording('Delivered,Stamp/Signature (Item No.: 12)', 'delivered')).toBe('Delivered');
    expect(skykingWording('Delivered, RECEIVED BY SAMPLE NAME', 'delivered')).toBe('Delivered');
    expect(skykingWording('Un-Delivered, DOOR LOCKED, CALL +91 98765-43210', 'failed_attempt')).toBe('Un-Delivered, DOOR LOCKED, CALL');
    expect(skykingWording('FORWARDED TO MARKET ROAD, SAMPLEPUR', 'in_transit')).toBe('FORWARDED TO MARKET ROAD, SAMPLEPUR');
  });

  it('reads a consignment out for delivery again after a failed delivery the shared rules would call delivered', () => {
    const result = parseSkyking(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Out For Delivery', last_update: '2026-10-17T04:42:40Z', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.location, event.stage, event.description])).toEqual([
      ['2026-10-17T04:42:40Z', 'OLD TOWN, EASTMOOR', 'out_for_delivery', 'Out For Delivery'],
      ['2026-10-16T11:50:30Z', 'OLD TOWN, EASTMOOR', 'failed_attempt', 'Un-Delivered'],
      ['2026-10-16T04:28:00Z', 'OLD TOWN, EASTMOOR', 'out_for_delivery', 'Out For Delivery'],
      ['2026-10-15T06:51:48Z', 'EASTMOOR HUB FACILITY', 'in_transit', 'INBOUND SCAN DONE'],
      ['2026-10-13T19:34:13Z', 'WESTBROOK HUB, WESTBROOK', 'in_transit', 'FORWARDED TO EASTMOOR HUB FACILITY'],
      ['2026-10-13T16:00:45Z', 'WESTBROOK HUB', 'in_transit', 'INBOUND SCAN DONE'],
    ]);
    const failed = parseSkyking(edited('in-transit', (rows) => { rows.pop(); }), IN_TRANSIT);
    expect(failed).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Un-Delivered' });
  });

  it('reads a return delivered to the sender as returned, and one under way as an exception', () => {
    expect(skykingStage('RTO DELIVERED TO SHIPPER')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(skykingStage('RTO IN TRANSIT')).toEqual({ stage: 'exception', source: 'carrier_map' });
    const returned = parseSkyking(edited('delivered', (rows) => { rows.at(-1)!.Status = 'RTO Delivered, Stamp/Signature (Item No.: 3)'; }), DELIVERED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'RTO Delivered' });
    expect(returned).not.toHaveProperty('delivered_at');
  });

  it('keeps an unknown wording without a stage, orders scans on one second as listed and caps a long history', () => {
    const unknown = parseSkyking(edited('in-transit', (rows) => { rows.at(-1)!.Status = 'SAMPLE NOTE'; }), IN_TRANSIT);
    expect(unknown.events![0]).toMatchObject({ description: 'SAMPLE NOTE' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    expect(unknown).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'SAMPLE NOTE' });
    expect(skykingStage('SAMPLE NOTE')).toBeNull();
    const sameSecond = parseSkyking(edited('delivered', (rows) => { rows.at(-1)!.DateTime = rows.at(-2)!.DateTime; }), DELIVERED);
    expect(sameSecond.events!.slice(0, 2).map((event) => event.description)).toEqual(['Delivered', 'Out For Delivery']);
    const reversed = parseSkyking(edited('delivered', (rows) => { rows.reverse(); }), DELIVERED);
    expect(reversed.events![0]).toMatchObject({ description: 'Delivered' });
    const long = parseSkyking(edited('in-transit', (rows) => {
      rows.splice(0, rows.length, ...Array.from({ length: 120 }, (_, index) => ({ ...fixture('in-transit')[2]!,
        DateTime: `15/10/2026 - ${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00` })));
    }), IN_TRANSIT);
    expect(long).toMatchObject({ history_truncated: true, last_update: '2026-10-14T20:29:00Z' });
    expect(long.events).toHaveLength(100);
  });

  it('reads the empty list as not found', () => {
    expect(() => parseSkyking(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('counts a consignment only when every scan names the whole number asked', () => {
    expect(() => parseSkyking(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SkyKing answered for another consignment' }));
    for (const cnote of ['30000002', '3000000221', '300000023', '300000022 x', '0300000022', '']) {
      expect(() => parseSkyking(edited('in-transit', (rows) => { rows[2]!.CNote = cnote; }), IN_TRANSIT), cnote)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const cnote of [null, 300000022, { value: IN_TRANSIT }]) {
      expect(() => parseSkyking(edited('in-transit', (rows) => { rows[2]!.CNote = cnote; }), IN_TRANSIT), String(cnote))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects a changed reply', () => {
    for (const reply of [
      null, '', 'No Tracking Information Available.', {}, { Status: 'Delivered' },
      edited('in-transit', (rows) => { rows[0] = 'scan' as never; }),
      edited('in-transit', (rows) => { rows[0]!.Status = ''; }),
      edited('in-transit', (rows) => { rows[0]!.Status = ', Area Name: SAMPLE'; }),
      edited('in-transit', (rows) => { rows[0]!.Status = { text: 'SAMPLE' }; }),
      edited('in-transit', (rows) => { rows[0]!.Location = 7; }),
      edited('in-transit', (rows) => { rows[0]!.DateTime = '31/09/2026 - 10:00:00'; }),
      edited('in-transit', (rows) => { rows[0]!.DateTime = '15/10/2026 - 24:00:00'; }),
      edited('in-transit', (rows) => { rows[0]!.DateTime = '15/10/2026 10:00:00'; }),
      edited('in-transit', (rows) => { rows[0]!.DateTime = '2026-10-15T10:00:00'; }),
      edited('in-transit', (rows) => { rows[0]!.DateTime = null; }),
      edited('in-transit', (rows) => { rows.splice(0, rows.length, ...Array.from({ length: 501 }, () => rows[0]!)); }),
    ]) {
      expect(() => parseSkyking(reply, IN_TRANSIT), JSON.stringify(reply)?.slice(0, 160)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a block page and a broken reply apart', async () => {
    const lookup = (reply: Response) => carrier(site(() => reply)).track({ number: UNKNOWN });
    await expect(lookup(json([]))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers a request it has no route for with HTTP 404.
    await expect(lookup(json({ Message: 'No HTTP resource was found that matches the request URI.' }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('', { status: 302, headers: { Location: 'https://skyking.co/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(html('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><title>Request Rejected</title><body>The requested URL was rejected.</body></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><title>SkyKing</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(new Response('[{"DateTime":', { headers: { 'Content-Type': 'application/json' } }))).rejects.toMatchObject({ kind: 'schema' });
    // A non-digit number gets an empty string, which the adapter never asks for.
    await expect(lookup(json(''))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('needs a key before it asks, and keeps a key failure apart from an unknown number', async () => {
    const keyed = async (reply: Response) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply);
      const error = await carrier(fetcher).track({ number: IN_TRANSIT }).catch((caught: unknown) => caught);
      expect(fetcher).toHaveBeenCalledTimes(1);
      return error;
    };
    for (const body of ['', 'not a key!', 7, { Message: 'An error has occurred.' }, [KEY]]) {
      expect(await keyed(json(body)), JSON.stringify(body)).toMatchObject({ kind: 'schema' });
    }
    expect(await keyed(new Response('', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await keyed(new Response('', { status: 301, headers: { Location: 'https://skyking.co/' } }))).toMatchObject({ kind: 'transport' });
    expect(await keyed(html('<html><title>Access Denied</title></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await keyed(new Response('', { status: 429, headers: { 'Retry-After': '30' } }))).toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(await keyed(new Response('', { status: 403 }))).toMatchObject({ kind: 'challenge' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s on the lookup as %s during retrieval and recognition, without the key', async (status, kind) => {
      const fetcher = site(() => new Response('', { status }));
      const error = await carrier(fetcher).track({ number: IN_TRANSIT }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind, status });
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(KEY);
      expect((error as { request?: unknown }).request).toBeUndefined();
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(4);
    });

  it('tries once more after a network failure, with a fresh key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(KEY)).mockResolvedValueOnce(json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([SKYKING_KEY_URL, SKYKING_KEY_URL, lookupUrl(DELIVERED)]);
  });

  it('recognizes a known consignment with its last scan and the empty list, and asks nothing for a number SkyKing does not issue', async () => {
    const fetcher = site((url) => json(url === lookupUrl(DELIVERED) ? fixture('delivered') : []));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-14T10:48:09.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('1000000011')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects numbers SkyKing does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '1234567', '1000000011', 'M10000011', 'A00000011', '100000011,300000022', '10000001%', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSkykingNumber('100-000-011')).toBe(DELIVERED);
    expect(normalizeSkykingNumber(' 1100 0066 ')).toBe(OLDER);
  });

  it('ends a hanging lookup inside the caller’s budget', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('routes a number filed under SkyKing to the adapter', async () => {
    const fetcher = site(() => json(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: '1000 000 11', carrier: 'skyking' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'skyking', source: 'skyking', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === lookupUrl(DELIVERED))).toBe(true);
  });

  it('leaves consignment numbers to the caller: no rule claims eight or nine digits', () => {
    for (const number of [DELIVERED, IN_TRANSIT, OLDER]) expect(detectCarrierMatch(number).carrier, number).not.toBe('skyking');
  });
});

describe('SkyKing status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      if (!entry.stage) continue;
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(skykingStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'skyking', providerCode: null, description: 'Un-Delivered' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'skyking', providerCode: null, description: 'Out For Delivery, Area Name: SAMPLE AREA., Delivery Boy: SAMPLE NAME' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'skyking', providerCode: null, description: 'SAMPLE NOTE' })).toEqual({ kind: 'unknown' });
  });
});
