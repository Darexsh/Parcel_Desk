import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MONGOL_INFINITY_POST_CUSTOMS_API, MONGOL_INFINITY_POST_SEARCH_API, MongolInfinityPostTracker } from './adapter.js';
import {
  normalizeMongolInfinityPostNumber, parseMongolInfinityPostCustoms, parseMongolInfinityPostCustomsRefusal, parseMongolInfinityPostHistory,
} from './parser.js';
import { mongolInfinityPostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED_ORDER = '1000001';
const DELIVERED = 'RR00000001MN';
const IN_TRANSIT_ORDER = '1000002';
const IN_TRANSIT = 'RR00000002MN';
const UNKNOWN = '0000000';
const CUSTOMS = 'YC000000002CN';
const CUSTOMS_UNKNOWN = 'YC000000000CN';

type Row = Record<string, unknown>;
type Hit = { _index: string; _id: string; _score: null; _source: Row & { shipmentStatus: Row } };
type Search = { result: { hits: Hit[] } };
type Customs = { result: { item: Row & { STATUS_LIST: Row[] } } };

const fixture = <T = Search>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const changed = (name: string, change: (hits: Hit[]) => void): Search => {
  const reply = fixture(name);
  change(reply.result.hits);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Mongol Infinity Post HTTP adapter', () => {
  it('sends the whole number to the home page’s search once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MongolInfinityPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rr 0000-0002 mn ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${MONGOL_INFINITY_POST_SEARCH_API}?q=${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'mongol-infinity-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads each scan as the page shows it, at its UTC instant, newest first', () => {
    const result = parseMongolInfinityPostHistory(fixture('delivered'), DELIVERED_ORDER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Хүргэлт дууссан', last_update: '2026-03-04T07:42:10.115Z', delivered_at: '2026-03-04T07:42:10.115Z',
      expected_delivery: null, canonical_tracking_number: DELIVERED });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      // The page leaves the branch out once the parcel is with the courier.
      ['2026-03-04T07:42:10.115Z', 'EMI', 'delivered', 'Ulaanbaatar, Mongolia'],
      ['2026-03-04T02:05:33.020Z', 'EM3', 'out_for_delivery', 'Ulaanbaatar, Mongolia'],
      // The repeated hit is kept once.
      ['2026-03-03T09:30:00.500Z', 'EMH', 'failed_attempt', 'Ulaanbaatar, Mongolia'],
      ['2026-03-03T01:58:12.700Z', 'EM3', 'out_for_delivery', 'Ulaanbaatar, Mongolia'],
      ['2026-03-02T08:41:14.829Z', 'EMG', 'in_transit', 'Central branch, Ulaanbaatar, Mongolia'],
      ['2026-03-02T08:40:20.597Z', 'EMB', 'in_transit', 'Central branch, Ulaanbaatar, Mongolia'],
    ]);
    // The failed attempt keeps its reason without the phone number in it.
    expect(result.events![2]!.description).toBe('Үл хүргэсэн: Утсаа аваагүй, дугаараар залгасан');
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps nobody’s name, phone, address, position, signature or goods', () => {
    const text = JSON.stringify(parseMongolInfinityPostHistory(fixture('delivered'), DELIVERED));
    for (const kept of ['Synthetic', '00000000', '0000 0000', 'street', '47.9', 'signature', 'example.invalid', 'Жижиг', 'SYNTHETIC-REF']) {
      expect(text, kept).not.toContain(kept);
    }
  });

  it('finds a parcel by its order id or its barcode, and reports the barcode for an order id', () => {
    const byOrder = parseMongolInfinityPostHistory(fixture('in-transit'), IN_TRANSIT_ORDER);
    const byBarcode = parseMongolInfinityPostHistory(fixture('in-transit'), IN_TRANSIT);
    expect(byOrder).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', canonical_tracking_number: IN_TRANSIT,
      last_update: '2026-04-11T04:15:00.001Z', last_status_text: 'Илгээмжийг хүргэлтийн салбар хүлээн авсан' });
    expect(byBarcode.canonical_tracking_number).toBeUndefined();
    expect(byBarcode.delivered_at).toBeUndefined();
    // The search's hit on another parcel is left out.
    for (const result of [byOrder, byBarcode]) {
      expect(result.events!.map((event) => [event.provider_code, event.location])).toEqual([
        ['EMG', 'Darkhan branch, Darkhan-Uul, Mongolia'],
        ['EMB', 'Central branch, Ulaanbaatar, Mongolia'],
      ]);
    }
  });

  it('counts a hit only when it names the number asked, and an order with several barcodes as several parcels', () => {
    expect(() => parseMongolInfinityPostHistory(fixture('in-transit'), 'RR00000003MN')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A seven-digit number is an order id, never part of a barcode.
    expect(() => parseMongolInfinityPostHistory(changed('in-transit', (hits) => {
      for (const hit of hits) hit._source.orderId = 1000003;
    }), '0000002')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const split = changed('in-transit', (hits) => {
      hits[2]!._source.barcode = 'RR00000004MN';
    });
    expect(() => parseMongolInfinityPostHistory(split, IN_TRANSIT_ORDER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    expect(parseMongolInfinityPostHistory(split, IN_TRANSIT).events).toHaveLength(1);
    // A row without a barcode yet belongs to its order's one parcel.
    const unlabelled = changed('in-transit', (hits) => {
      hits[2]!._source.barcode = null;
    });
    expect(parseMongolInfinityPostHistory(unlabelled, IN_TRANSIT_ORDER).events).toHaveLength(2);
  });

  it('reads no hit as not found and rejects a changed reply', () => {
    expect(() => parseMongolInfinityPostHistory(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [null, [], { result: {} }, { result: { hits: {} } }, { hits: [] }, { result: { hits: [null] } }, { result: { hits: [{}] } }]) {
      expect(() => parseMongolInfinityPostHistory(payload, IN_TRANSIT), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const broken: ((source: Row & { shipmentStatus: Row }) => void)[] = [
      (source) => { source.scanDate = '2026-04-11 12:15:00'; },
      (source) => { source.scanDate = null; },
      (source) => { source.shipmentStatus = null as unknown as Row; },
      (source) => { source.shipmentStatus.name = ''; },
      (source) => { source.reason = { text: 'x' }; },
      (source) => { source.orderId = 1.5; },
      (source) => { source.barcode = 7; },
    ];
    for (const change of broken) {
      expect(() => parseMongolInfinityPostHistory(changed('in-transit', (hits) => change(hits[0]!._source)), IN_TRANSIT))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const oversized = { result: { hits: Array.from({ length: 501 }, () => fixture('in-transit').result.hits[0]) } };
    expect(() => parseMongolInfinityPostHistory(oversized, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('dates a row the page dates by its stamp, and words a scan in English when it has no Mongolian name', () => {
    const result = parseMongolInfinityPostHistory(changed('in-transit', (hits) => {
      delete hits[0]!._source.scanDate;
      hits[0]!._source.timestamp = '2026-04-11T05:00:00.000Z';
      hits[0]!._source.shipmentStatus = { cd: 'EMX', name: '', enName: 'Synthetic step' };
    }), IN_TRANSIT);
    expect(result.events![0]).toEqual({ time: '2026-04-11T05:00:00Z', location: 'Darkhan branch, Darkhan-Uul, Mongolia',
      description: 'Synthetic step', provider_code: 'EMX' });
    // The newest scan without a stage leaves the stage to the one before.
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic step' });
  });

  it('sends a number holding YC to the customs lookup, as the page does, and reads its statuses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('customs')));
    const result = await carrier(fetcher).track({ number: 'yc 000 000 002 cn' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${MONGOL_INFINITY_POST_CUSTOMS_API}${CUSTOMS}`);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Customs released',
      last_update: '2026-05-07T06:45:18.450Z' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.description])).toEqual([
      ['2026-05-07T06:45:18.450Z', 'CUSTOMS_RELEASED', 'in_transit', 'Customs released'],
      ['2026-05-07T02:05:09.300Z', 'CUSTOMS_CLEARANCE_CHECKED', 'customs', 'Customs clearance checked'],
      ['2026-05-06T03:30:00Z', 'CUSTOMS_CLEARANCE_STARTED', 'customs', 'Customs clearance started'],
      ['2026-05-06T01:12:40.120Z', 'CUSTOMS_PICK_UP_BY_PROVIDER', 'in_transit', 'Picked by provider'],
    ]);
    const text = JSON.stringify(result);
    for (const reference of ['SYNTHETIC-MAIL', 'SYNTHETIC-ORDER', 'SYNTHETICBAG', 'SYNTHETICBL']) expect(text).not.toContain(reference);
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const body = fixture<Customs>('customs');
    body.result.item.STATUS_LIST[2]!.CREATED_DATE = body.result.item.STATUS_LIST[1]!.CREATED_DATE;
    expect(parseMongolInfinityPostCustoms(body, CUSTOMS).events!.map((event) => event.provider_code))
      .toEqual(['CUSTOMS_RELEASED', 'CUSTOMS_CLEARANCE_CHECKED', 'CUSTOMS_CLEARANCE_STARTED', 'CUSTOMS_PICK_UP_BY_PROVIDER']);
  });

  it('reads the customs lookup’s own 404 as not found, binds its item to the number and rejects a changed one', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: CUSTOMS_UNKNOWN });
    await expect(lookup(fixture('customs-not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup({ status: 'error', message: `Item with TRACKING_NUMBER ${CUSTOMS} not found` }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><pre>Cannot GET</pre></html>', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    expect(() => parseMongolInfinityPostCustomsRefusal(undefined, CUSTOMS)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseMongolInfinityPostCustoms(fixture('customs'), CUSTOMS_UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const customs = (change: (item: Customs['result']['item']) => void) => {
      const body = fixture<Customs>('customs');
      change(body.result.item);
      return body;
    };
    expect(() => parseMongolInfinityPostCustoms(customs((item) => { item.STATUS_LIST = []; }), CUSTOMS))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    for (const change of [
      (item: Row) => { delete item.TRACKING_NUMBER; },
      (item: Row) => { item.STATUS_LIST = {}; },
      (item: Customs['result']['item']) => { item.STATUS_LIST[0]!.CREATED_DATE = '2026-05-06 09:12:40'; },
      (item: Customs['result']['item']) => { item.STATUS_LIST[0]!.STATUS_DESC = ''; },
    ]) expect(() => parseMongolInfinityPostCustoms(customs(change), CUSTOMS)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMongolInfinityPostCustoms({ result: { item: null } }, CUSTOMS)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The search reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://mypost.mn/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Инфинити Шуудан</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(fixture('in-transit'))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries a read that failed to reach the site once more, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes a known number and the unknown-number answers, and asks nothing for a number it does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('customs-not-found'), { status: 404 }));
    await expect(carrier(fetcher).recognize!(DELIVERED_ORDER)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T07:42:10.115Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(CUSTOMS_UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('RR000000001MN')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Mongol Infinity Post does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['100000', '10000001', 'RR000000001MN', 'RR00000001CN', 'SAMPLETRACKING', 'YCYCYCYC', `YC${'0'.repeat(40)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMongolInfinityPostNumber('rr 0000-0001 mn')).toBe(DELIVERED);
    expect(normalizeMongolInfinityPostNumber(' 1000 001 ')).toBe(DELIVERED_ORDER);
  });

  it('ends a hanging read inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(80);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([40, 80]);
  });

  it('routes a number filed under Mongol Infinity Post to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'mongol-infinity-post' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'mongol-infinity-post', source: 'mongol-infinity-post', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(MONGOL_INFINITY_POST_SEARCH_API))).toBe(true);
  });
});

describe('Mongol Infinity Post status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.code) continue;
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(mongolInfinityPostStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'mongol-infinity-post', providerCode: 'EMH', description: 'Үл хүргэсэн' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'mongol-infinity-post', providerCode: 'ZZZ', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(mongolInfinityPostStage('CUSTOMS_SYNTHETIC', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(mongolInfinityPostStage('ZZZ', 'Synthetic note')).toBeNull();
  });
});
