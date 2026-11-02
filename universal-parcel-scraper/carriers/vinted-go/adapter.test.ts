import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, VINTED_GO_ENDPOINT, VintedGoTracker } from './adapter.js';
import { normalizeVintedGoNumber, parseVintedGo } from './parser.js';
import { statusMap, vintedGoStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1790000000000010';
const READY = '1790000000000028';
const RETURNED = '1790000000000036';
const HANDOVER = '1790000000000044';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Record<string, unknown> => JSON.parse(text(name));
const json = 'application/json; charset=utf-8';
const reply = (name: string, status = 200) => new Response(text(name), { status, headers: { 'Content-Type': json } });
const unknown = () => new Response(null, { status: 404, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (payload: Record<string, unknown>) => payload.tracking_events as Record<string, unknown>[];

describe('Vinted Go HTTP adapter', () => {
  it('asks the tracking service once for the whole number, in English, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new VintedGoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1790 0000 0000 0010 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://carrier.vintedgo.com/public/v3/tracking_events/${DELIVERED}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Accept-Language': 'en', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'vinted-go', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('asks the tracking service for a VGS number as printed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'));
    await expect(carrier(fetcher).track({ number: 'vgs 9000 0000 0000 01' })).resolves.toMatchObject({ status: 'delivered' });
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://carrier.vintedgo.com/public/v3/tracking_events/VGS90000000000001');
  });

  it('asks the tracking service for a VGS number of thirteen digits', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'));
    await expect(carrier(fetcher).track({ number: 'VGS9000000000001' })).resolves.toMatchObject({ status: 'delivered' });
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://carrier.vintedgo.com/public/v3/tracking_events/VGS9000000000001');
  });

  it('asks the tracking service for a code of sixteen capital letters and digits', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'));
    await expect(carrier(fetcher).track({ number: 'abc1de2fghijklmn' })).resolves.toMatchObject({ status: 'delivered' });
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://carrier.vintedgo.com/public/v3/tracking_events/ABC1DE2FGHIJKLMN');
  });

  it('reads a collected parcel newest first, with its locker but without its address, deadline or questions', () => {
    const result = parseVintedGo(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel was collected by the recipient', last_update: '2026-09-24T15:02:10.100Z',
      delivered_at: '2026-09-24T15:02:10.100Z', expected_delivery: null, pickup_point: 'Example Market' });
    // The bare "Delivered" written within a second of the collection is the same collection.
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-09-24T15:02:10.100Z', 'delivery/delivered', 'delivered', null],
      ['2026-09-23T10:15:00Z', 'delivery/ready_for_pickup', 'ready_for_pickup', null],
      ['2026-09-23T06:40:30.500Z', 'delivery/in_transit', 'in_transit', null],
      ['2026-09-22T21:05:12Z', 'delivery/in_transit', 'in_transit', 'Sampleville, FR'],
      ['2026-09-22T09:30:00Z', 'delivery/in_transit', 'in_transit', null],
      ['2026-09-21T18:45:00Z', 'delivery/in_transit', 'in_transit', 'Exampleton, FR'],
      ['2026-09-21T08:20:00Z', 'delivery/shipped', 'accepted', null],
      ['2026-09-20T17:00:00Z', 'delivery/created', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    const kept = JSON.stringify(result);
    for (const dropped of ['Example Street', '900001', '2026-09-30', 'Example question', 'Example answer']) expect(kept).not.toContain(dropped);
  });

  it('holds back a scan dated after the lookup until it is due', () => {
    // An hour before the sorting centre's scan, then just before it and after it.
    const early = parseVintedGo(fixture('delivered'), DELIVERED, Date.parse('2026-09-22T20:05:12Z'));
    expect(early).toMatchObject({ current_stage: 'in_transit', last_update: '2026-09-22T09:30:00Z' });
    expect(early.events!.map((event) => event.time)).toEqual(['2026-09-22T09:30:00Z', '2026-09-21T18:45:00Z', '2026-09-21T08:20:00Z', '2026-09-20T17:00:00Z']);
    for (const readAt of ['2026-09-22T21:01:00Z', '2026-09-22T22:00:00Z']) {
      expect(parseVintedGo(fixture('delivered'), DELIVERED, Date.parse(readAt)).events![0]).toMatchObject({ time: '2026-09-22T21:05:12Z', location: 'Sampleville, FR' });
    }
  });

  it('names the point a parcel waits at only when its scans send it there', () => {
    expect(parseVintedGo(fixture('ready'), READY)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Ready to collect at the parcel shop', pickup_point: 'Sample Bakery' });
    const redirected = fixture('ready');
    rows(redirected).splice(1, 0, { id: 9000000029, message: 'Parcel redirected to the locker', timestamp: '2026-09-25T09:00:00.000Z',
      metadata: { point_id: 900009 }, banner_message: null, group_header: null, group: 'redirected', state: 'delivery' });
    expect(parseVintedGo(redirected, READY).pickup_point).toBeUndefined();
    const mismatched = fixture('ready');
    rows(mismatched)[1]!.message = 'The parcel is on its way to the locker (Sample Bakery)';
    expect(parseVintedGo(mismatched, READY).pickup_point).toBeUndefined();
    const moving = fixture('ready');
    rows(moving).shift();
    expect(parseVintedGo(moving, READY)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(parseVintedGo(moving, READY).pickup_point).toBeUndefined();
  });

  it('reads every scan of the return leg as returned and a loss as an exception', () => {
    const result = parseVintedGo(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Return: At sorting center in Sampleville, FR' });
    expect(result.pickup_point).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['return/in_transit', 'returned', 'Sampleville, FR'],
      ['return/return', 'returned', null],
      ['delivery/ready_for_pickup', 'ready_for_pickup', null],
      ['delivery/in_transit', 'in_transit', null],
      ['delivery/redirected', 'in_transit', null],
      ['dispose/lost', 'exception', null],
      ['delivery/redirected', 'in_transit', null],
      ['delivery/in_transit', 'in_transit', 'Sampleville, FR'],
      ['delivery/created', 'registered', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Example Lane|Sample Avenue|selected point|lost in transit\./);
  });

  it('reads a town given with a space before its comma without it', () => {
    const payload = fixture('returned');
    const [first, ...rest] = rows(payload);
    const scan = { ...first, message: 'Return: At sorting center in Sampleville , FR' };
    const result = parseVintedGo({ ...payload, tracking_events: [scan, ...rest] }, RETURNED);
    expect(result.events?.[0]).toMatchObject({ description: scan.message, location: 'Sampleville, FR' });
  });

  it('reports the new tracking code a parcel left the network under, with the network its link names', () => {
    expect(parseVintedGo(fixture('handover'), HANDOVER)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Parcel left our network',
      delivery_tracking_number: '990000000001', delivery_carrier: 'mondial-relay' });
    const unlinked = fixture('handover');
    (rows(unlinked)[0]!.metadata as Record<string, unknown>).external_link = null;
    const result = parseVintedGo(unlinked, HANDOVER);
    expect(result.delivery_tracking_number).toBe('990000000001');
    expect(result.delivery_carrier).toBeUndefined();
  });

  it('leaves milestones the map does not know to the wording rules and keeps them visible', () => {
    const payload = fixture('handover');
    rows(payload)[0] = { id: 9000000059, message: 'Parcel weighed', timestamp: '2026-09-29T08:00:00.000Z', metadata: {},
      banner_message: null, group_header: null, group: 'weighed', state: 'delivery' };
    const result = parseVintedGo(payload, HANDOVER);
    expect(result.events![0]).toEqual({ time: '2026-09-29T08:00:00Z', description: 'Parcel weighed', provider_code: 'delivery/weighed' });
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
  });

  it('drops repeated scans, orders equal clocks as the reply does and rejects a changed reply', () => {
    expect(parseVintedGo(fixture('delivered'), DELIVERED).events).toHaveLength(8);
    const later = fixture('delivered');
    rows(later)[0]!.timestamp = '2026-09-24T15:02:11.100Z';
    expect(parseVintedGo(later, DELIVERED).events).toHaveLength(9);
    for (const change of [
      (payload: Record<string, unknown>) => { rows(payload)[2]!.timestamp = '2026-09-23 10:15'; },
      (payload: Record<string, unknown>) => { rows(payload)[2]!.message = ''; },
      (payload: Record<string, unknown>) => { rows(payload)[2]!.group = { name: 'ready_for_pickup' }; },
      (payload: Record<string, unknown>) => { payload.tracking_events = {}; },
    ]) {
      const payload = fixture('delivered');
      change(payload);
      expect(() => parseVintedGo(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseVintedGo({ tracking_events: [], meta: {} }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
  });

  it('keeps an unknown number, an expired history and a missing route apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: DELIVERED });
    await expect(lookup(unknown())).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(reply('expired', 404))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
    await expect(lookup(new Response('Not found', { status: 404 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response(null, { status: 404, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response('{"error_code":"unexpected"}', { status: 404, headers: { 'Content-Type': json } })))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(new Response(null, { status: 301, headers: { Location: 'https://example.invalid/' } }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status, headers: { 'Retry-After': '120' } }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps blocked HTTP 200 pages and malformed replies apart from missing parcels', async () => {
    for (const [body, kind] of [['<html><title>Just a moment...</title></html>', 'challenge'], ['<html>Maintenance</html>', 'schema'], ['{"events":[]}', 'schema']]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    }
  });

  it('recognizes a known parcel and the unknown-number answer, and asks nothing for a number Vinted Go does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('delivered')).mockResolvedValueOnce(unknown());
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-24T15:02:10.100Z' });
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('1790000000000011')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Vinted Go answers any old-looking number with an expired history, so that answer
    // never claims another carrier's sixteen digits.
    fetcher.mockResolvedValueOnce(reply('expired', 404));
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
  });

  it('rejects numbers Vinted Go does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1790000000000011', '179000000000001', '17900000000000104', '2790000000000018', 'VG90000000000010',
      'VGS900000000000', 'VGS900000000000001', 'VGT90000000000001', 'ABC1DE2FGHIJKLM', 'ABC1DE2FGHIJKLMNO']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeVintedGoNumber('1790-0000-0000-0010')).toBe(DELIVERED);
  });

  it('sends a read that failed to reach Vinted Go once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply('ready'));
    await expect(carrier(fetcher).track({ number: READY }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a parcel filed under Vinted Go to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('delivered'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'vinted-go' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'vinted-go', source: 'vinted-go', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${VINTED_GO_ENDPOINT}${DELIVERED}`)).toBe(true);
  });
});

describe('Vinted Go status vocabulary', () => {
  it('records every code the map knows with the stage the adapter gives it', () => {
    for (const entry of statuses.entries) {
      const [state, group] = entry.code.split('/');
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(vintedGoStage(state!, group!)).toBe(stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(stage);
    }
    expect(statusMapAnswer({ carrier: 'vinted-go', providerCode: 'return/in_transit', description: 'Return: At sorting center in Sampleville, FR' }))
      .toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'vinted-go', providerCode: 'delivery/oversized', description: 'Parcel is oversized' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(statusMap.stage('delivery/weighed', 'parcel weighed')).toBeUndefined();
    expect(statusMap.stage('delivery', 'delivered')).toBeUndefined();
  });
});
