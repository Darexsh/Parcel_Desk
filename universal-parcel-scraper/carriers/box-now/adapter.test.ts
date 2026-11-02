import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BOX_NOW_ENDPOINT, BoxNowTracker } from './adapter.js';
import { parseBoxNow } from './parser.js';
import { boxNowStatus, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '9000000001';
const IN_TRANSIT = '9000000002';
const READY = '9000000003';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): unknown => JSON.parse(text(name));
const reply = (name: string) => new Response(text(name), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('BOX NOW HTTP adapter', () => {
  it('posts the whole parcel id once through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BoxNowTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 900 000 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api-production.boxnow.cy/api/v1/parcels:track');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ parcelId: DELIVERED }), signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'box-now', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a collected parcel newest first, without the sender, postcodes or the locker address', () => {
    const result = parseBoxNow(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has been delivered', last_update: '2026-03-04T17:05:00Z', delivered_at: '2026-03-04T17:05:00Z',
      expected_delivery: null, pickup_point: 'BOX NOW Example Kiosk', destination_country: 'GR' });
    expect(result.events!.map(event => [event.time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-03-04T17:05:00Z', 'delivered', 'delivered', null],
      ['2026-03-04T09:50:00Z', 'final-destination', 'ready_for_pickup', 'BOX NOW Example Kiosk'],
      ['2026-03-03T21:40:00Z', 'in-depot', 'in_transit', 'EXAMPLE DEPOT'],
      ['2026-03-03T15:30:00Z', 'in-depot', 'in_transit', 'SAMPLE HUB'],
      ['2026-03-02T12:20:00Z', 'accepted-to-locker', 'accepted', 'BOX NOW STORE - Sample Square'],
      ['2026-03-02T08:10:00Z', 'new', 'registered', null],
    ]);
    const kept = JSON.stringify(result);
    for (const dropped of ['Example Shop Warehouse', 'Example Avenue', '11111', '22222', '33333', 'Next to', '37.0', 'locker.jpg', 'prepaid']) {
      expect(kept).not.toContain(dropped);
    }
  });

  it('reads a delivery into a transfer hub as a hand-over to the next network, not a delivery', () => {
    const hub = { id: '300', title: null, name: 'BOX NOW - EXAMPLE PARTNER HUB', addressLine1: 'transfer', addressLine2: 'EXAMPLE PARTNER',
      postalCode: '66666', country: 'HR', image: null, note: '', type: 'warehouse', deliveryPartnerParcelId: null };
    const handed = (destination: Record<string, unknown>) => {
      const payload = fixture('delivered') as { data: [{ destination: unknown; etaDate?: string; events: Record<string, unknown>[] }] };
      payload.data[0].destination = destination;
      payload.data[0].etaDate = '2026-03-04T00:00:00Z';
      payload.data[0].events.splice(4, 2, { type: 'delivered', locationDisplayName: String(destination.name), createTime: '2026-03-04T17:05:00.000Z' });
      return parseBoxNow(payload, DELIVERED);
    };
    for (const destination of [hub, { ...hub, addressLine1: 'Transfer', name: 'Example Transfer Point' }, { ...hub, addressLine1: '1 Sample Road' }]) {
      const result = handed(destination);
      expect(result, destination.name).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', expected_delivery: null,
        last_status_text: 'Parcel has been handed over at a transfer hub for onward delivery' });
      expect(result.events![0]).toMatchObject({ provider_code: 'delivered', stage: 'in_transit', location: destination.name });
      // The hub's country is not where the parcel is going, and nothing was delivered.
      for (const field of ['delivered_at', 'destination_country', 'pickup_point']) expect(result, field).not.toHaveProperty(field);
    }
    // A merchant's warehouse, where a return ends, takes the delivery.
    const merchant = handed({ ...hub, name: 'Example Shop Warehouse', addressLine1: '1 Sample Road', addressLine2: 'Sampletown' });
    expect(merchant).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-03-04T17:05:00Z', destination_country: 'HR' });
  });

  it('keeps the estimate as an Athens day only while the parcel is on its way', () => {
    const moving = parseBoxNow(fixture('in-transit'), IN_TRANSIT);
    expect(moving).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Parcel is in one of our warehouses',
      expected_delivery: '2026-03-13', destination_country: 'BG' });
    expect(moving.pickup_point).toBeUndefined();
    const waiting = parseBoxNow(fixture('ready'), READY);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', expected_delivery: null,
      pickup_point: 'BOX NOW Example Pharmacy', last_status_text: 'Parcel has reached its final destination, waiting for pickup' });
    expect(JSON.stringify(waiting)).not.toMatch(/Sample Logistics|"cod"|12\.00|2026-03-20/);
  });

  it('shows the newest scan while the state only says the parcel is on its way, and keeps unknown types visible', () => {
    const payload = fixture('in-transit') as { data: [{ events: unknown[]; state: string }] };
    payload.data[0].events = payload.data[0].events.slice(0, 1);
    expect(parseBoxNow(payload, IN_TRANSIT)).toMatchObject({ status: 'pending', current_stage: 'registered', expected_delivery: '2026-03-13' });
    payload.data[0].events.push({ type: 'parcel-weighed', createTime: '2026-03-09T07:00:00Z' });
    payload.data[0].state = 'parcel-weighed';
    const unknown = parseBoxNow(payload, IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'parcel-weighed', expected_delivery: null });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ time: '2026-03-09T07:00:00Z', description: 'parcel-weighed', provider_code: 'parcel-weighed' });
  });

  it('answers a state without scans as an identity-bound summary', () => {
    const payload = fixture('ready') as { data: [{ events?: unknown[] }] };
    delete payload.data[0].events;
    expect(parseBoxNow(payload, READY)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      provider_code: 'in-final-destination', summary_only: true, events: [] });
  });

  it('binds the reply to the whole requested parcel id', () => {
    expect(() => parseBoxNow(fixture('delivered'), '9000000009')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const twice = fixture('delivered') as { data: unknown[] };
    twice.data.push(twice.data[0]);
    expect(() => parseBoxNow(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const undated = fixture('delivered') as { data: [{ events: { createTime?: string }[] }] };
    undated.data[0].events[2]!.createTime = '2026-03-03 15:30';
    expect(() => parseBoxNow(undated, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBoxNow({ data: {} }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('suggests BOX NOW for ten digits, and recognition asks it first from its countries', () => {
    expect(detectCarrierMatch(IN_TRANSIT)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['box-now']) });
    expect(detectCarrierMatch('900000001').candidates).not.toContain('box-now');
    for (const countryHint of ['GR', 'SI']) {
      expect(recognitionCandidates(IN_TRANSIT, { countryHint })[0]?.carrier).toBe('box-now');
    }
  });

  it('recognizes a known parcel and the explicit empty list without a browser or recipient inputs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('delivered')).mockResolvedValueOnce(reply('not-found'));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T17:05:00.000Z' });
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('900000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const absent = vi.fn<typeof fetch>().mockResolvedValue(reply('not-found'));
    await expect(carrier(absent).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [400, 'transport'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"code":"C400"}', { status, headers: { 'Retry-After': '120' } }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps blocked HTTP 200 pages and malformed replies apart from missing parcels', async () => {
    for (const [body, kind] of [['<html><title>Just a moment...</title></html>', 'challenge'], ['<html>Maintenance</html>', 'schema'], ['{"items":[]}', 'schema']]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    }
  });

  it('rejects ids BOX NOW does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['900000001', '90000000011', 'BN90000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a parcel filed under BOX NOW to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('delivered'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'box-now' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'box-now', source: 'box-now', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === BOX_NOW_ENDPOINT)).toBe(true);
  });
});

describe('BOX NOW status vocabulary', () => {
  it('records every code the map knows with the wording and stage the adapter gives it', () => {
    for (const entry of statuses.entries) {
      expect(boxNowStatus(entry.code)).toEqual({ wording: entry.wording, ...('stage' in entry ? { stage: entry.stage } : {}) });
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe('stage' in entry ? entry.stage : undefined);
    }
    expect(statusMapAnswer({ carrier: 'box-now', providerCode: 'final-destination', description: 'Parcel has reached its final destination, waiting for pickup' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'box-now', providerCode: 'accepted-for-return', description: 'The parcel has been placed in the locker' }))
      .toMatchObject({ kind: 'intentional_gap' });
  });
});
