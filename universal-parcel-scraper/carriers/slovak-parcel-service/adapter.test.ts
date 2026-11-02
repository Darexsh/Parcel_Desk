import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SlovakParcelServiceTracker, SPS_API } from './adapter.js';
import { normalizeSpsNumber, parseSpsShipment } from './parser.js';
import { spsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '70399000000011';
const BARCODE = '7039900000001112';
const RETURNED = 'SKZZZZ99900001ZZZZ';
const PENDING = '70399000000022';
const UNKNOWN = '70399999999999';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Record<string, unknown> => JSON.parse(text(name));
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } });
const reply = (name: string, status = 200) => json(text(name), status);
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (payload: Record<string, unknown>) => payload.statuses as Record<string, unknown>[];
const parcels = (payload: Record<string, unknown>) => payload.parcels as Record<string, unknown>[];
const shipment = (payload: Record<string, unknown>) => payload.shipment as Record<string, unknown>;
/** A transport answering each of the service's three requests by its path. */
const service = (answers: { shipment?: () => Response; search?: () => Response; scans?: () => Response }) =>
  vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const path = String(input).slice(SPS_API.length);
    const answer = path.startsWith('shipment?') ? answers.shipment : path.startsWith('find-shipment?') ? answers.search
      : path.startsWith('parcel-status?') ? answers.scans : undefined;
    if (!answer) throw new Error(`unexpected request ${path}`);
    return answer();
  });
const missing = () => service({ shipment: () => reply('upstream-error', 502), search: () => reply('not-found', 404) });

describe('Slovak Parcel Service HTTP adapter', () => {
  it('asks the shipment service once for the compact number, in Slovak, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SlovakParcelServiceTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 703-990-00000011 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://backend.sps-sro.sk/api/tracking/shipment?shipment_id=${DELIVERED}`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Accept-Language': 'sk', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'slovak-parcel-service', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel on wall clocks, keeps its cash steps after the delivery and reads none of the shipment’s parties', () => {
    const result = parseSpsShipment(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Dobierka odoslaná zákaznikoví', last_update: null, last_update_local: '2026-09-19T07:50:09', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-09-19T07:50:09', '68', null],
      ['2026-09-17T15:42:48', '41', null],
      ['2026-09-16T12:29:57', '40', 'delivered'],
      ['2026-09-16T12:26:10', '42', null],
      ['2026-09-16T08:55:53', '30', 'out_for_delivery'],
      ['2026-09-15T16:08:23', '20', 'in_transit'],
      ['2026-09-15T16:05:37', '10', 'accepted'],
      ['2026-09-15T14:58:51', '44', 'accepted'],
      ['2026-09-14T12:06:38', '8', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    expect(result.weight_kg).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    const kept = JSON.stringify(result);
    for (const dropped of ['Example', 'Sampleville', 'ORDER', 'remark', '48123456', '17123456', '2026-09-14T00']) expect(kept).not.toContain(dropped);
  });

  it('reads a refused parcel’s depots and its return, which a later delivery to the sender keeps', () => {
    const result = parseSpsShipment(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'Návrat odosielateľovi',
      last_update_local: '2026-09-20T14:26:16', weight_kg: 0.04 });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['260', 'returned', 'SPS Sampleville'],
      ['60', 'exception', 'SPS Sampleville'],
      ['100', 'exception', 'SPS Sampleville'],
      ['30', 'out_for_delivery', 'SPS Sampleville'],
      ['10', 'accepted', 'SPS Exampleton'],
      ['44', 'accepted', 'SPS Exampleton'],
      ['8', 'registered', null],
    ]);
    const back = fixture('returned');
    rows(back).unshift({ ...rows(back)[0], date: '2026-09-22', time: '10:00:00.000', statusCodeX: 40, status: 'Doručenie' });
    expect(parseSpsShipment(back, RETURNED)).toMatchObject({ current_stage: 'returned', last_status_text: 'Doručenie' });
  });

  it('orders scans of one second by their fraction and keeps the carrier’s order for equal clocks', () => {
    const payload = fixture('returned');
    rows(payload).reverse();
    rows(payload)[0] = { ...rows(payload)[0], date: '2026-09-20', time: '14:26:16.100' };
    rows(payload).push({ ...rows(payload)[1], date: '2026-09-20', time: '14:26:16.100', statusCodeX: 20, status: 'Vstup' });
    expect(parseSpsShipment(payload, RETURNED).events!.slice(0, 3).map((event) => event.provider_code)).toEqual(['260', '20', '8']);
  });

  it('binds the reply to the requested parcel through its barcode and its short forms only', () => {
    for (const number of [DELIVERED, '99000000011', BARCODE, '703 990 000 000 11']) {
      expect(parseSpsShipment(fixture('delivered'), number).current_stage).toBe('delivered');
    }
    for (const number of ['70399000000012', '7039900000001113', '99000000012', RETURNED]) {
      expect(() => parseSpsShipment(fixture('delivered'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const label = fixture('returned');
    shipment(label).shipmentNumber = 'SKZZZZ99900002ZZZZ';
    shipment(label).barcode = null;
    parcels(label)[0]!.parcelNumber = 'SKZZZZ99900002ZZZZ';
    expect(() => parseSpsShipment(label, RETURNED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a parcel’s own scans in a shipment of several and drops repeated rows', () => {
    const OTHER = '7039900000003314';
    const payload = fixture('delivered');
    parcels(payload).push({ ...parcels(payload)[0], parcelNumber: OTHER });
    rows(payload).splice(4, 0, { ...rows(payload)[4], parcelNumber: OTHER, date: '2026-09-18', statusCodeX: 72, status: 'Uložený v balíkomate' });
    rows(payload).push({ ...rows(payload).at(-1)! });
    expect(parseSpsShipment(payload, DELIVERED).events!.map((event) => event.provider_code)).toEqual(['68', '41', '40', '42', '30', '20', '10', '44', '8']);
    expect(parseSpsShipment(payload, '70399000000033').events!.map((event) => event.provider_code)).toEqual(['72']);
  });

  it('leaves codes the map does not know without a stage and keeps them visible', () => {
    const payload = fixture('returned');
    rows(payload)[0] = { ...rows(payload)[0], statusCodeX: 50, status: 'Neznámy krok' };
    const result = parseSpsShipment(payload, RETURNED);
    expect(result.events![0]).toEqual({ description: 'Neznámy krok', local_time: '2026-09-20T14:26:16', location: 'SPS Sampleville', provider_code: '50' });
    expect(result.current_stage).toBe('exception');
    const unmapped = fixture('returned');
    rows(unmapped).splice(0, rows(unmapped).length, { ...rows(unmapped)[0], statusCodeX: '41', status: 'Editor hotovosti' });
    expect(parseSpsShipment(unmapped, RETURNED)).toMatchObject({ status: 'unknown', last_status_text: 'Editor hotovosti' });
    expect(parseSpsShipment(unmapped, RETURNED).current_stage).toBeUndefined();
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (payload: Record<string, unknown>) => { rows(payload)[2]!.date = '16.09.2026'; },
      (payload: Record<string, unknown>) => { rows(payload)[2]!.date = '2026-02-30'; },
      (payload: Record<string, unknown>) => { rows(payload)[2]!.time = '24:00:00'; },
      (payload: Record<string, unknown>) => { rows(payload)[2]!.statusCodeX = null; },
      (payload: Record<string, unknown>) => { rows(payload)[2]!.status = ''; },
      (payload: Record<string, unknown>) => { rows(payload)[2]!.center = { name: 'SPS' }; },
      (payload: Record<string, unknown>) => { payload.statuses = {}; },
      (payload: Record<string, unknown>) => { payload.ok = 'yes'; },
      (payload: Record<string, unknown>) => { shipment(payload).shipmentNumber = null; },
    ]) {
      const payload = fixture('delivered');
      change(payload);
      expect(() => parseSpsShipment(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('asks for the scans of a shipment that comes without them under its dashed parcel number, as the page does', async () => {
    const fetcher = service({ shipment: () => reply('pending'), scans: () => reply('parcel-status') });
    const result = await carrier(fetcher).track({ number: PENDING });
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'Uložený v balíkomate', weight_kg: 1.5 });
    expect(result.events!.map((event) => event.provider_code)).toEqual(['72', '30', '20', '10']);
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${SPS_API}parcel-status?parcel_id=703-990-00000022`);
    expect(JSON.stringify(result)).not.toMatch(/Example/);
    const empty = await carrier(service({ shipment: () => reply('pending'), scans: () => json({ ok: true, statuses: [] }) })).track({ number: PENDING });
    expect(empty).toMatchObject({ summary_only: true, current_stage: 'ready_for_pickup', last_status_text: 'Uložený v balíkomate', provider_code: '72', events: [] });
    const foreign = fixture('parcel-status');
    rows(foreign)[1]!.parcelNumber = '7039900000004415';
    await expect(carrier(service({ shipment: () => reply('pending'), scans: () => json(foreign) })).track({ number: PENDING }))
      .rejects.toMatchObject({ kind: 'schema' });
    for (const failed of [json('{}', 500), json({ message: 'Not Found' }, 404)]) {
      await expect(carrier(service({ shipment: () => reply('pending'), scans: () => failed })).track({ number: PENDING }))
        .rejects.toMatchObject({ kind: 'indeterminate' });
    }
  });

  it('calls a number unknown only when the search gives its not-found notice', async () => {
    const lookup = (fetcher: typeof fetch) => carrier(fetcher).track({ number: UNKNOWN });
    const fetcher = missing();
    await expect(lookup(fetcher)).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${SPS_API}shipment?shipment_id=${UNKNOWN}`, `${SPS_API}find-shipment?shipment_id=${UNKNOWN}&source=tracking`]);
    const failed = (search: () => Response) => lookup(service({ shipment: () => reply('upstream-error', 502), search }));
    await expect(failed(() => json({ url: `https://mysps.sk/tracking/${UNKNOWN}` }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(failed(() => json({ title: 'Iná chyba', message: '' }, 404))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(failed(() => new Response('<html>Not Found</html>', { status: 404 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(failed(() => json('{}', 429))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(service({ shipment: () => new Response('<html>502 Bad Gateway</html>', { status: 502 }) }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(service({ shipment: () => json({ ok: true }, 502) }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(service({ shipment: () => json({ message: 'Not Found' }, 404) }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status, headers: { 'Retry-After': '120' } }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps blocked HTTP 200 pages and malformed replies apart from missing parcels', async () => {
    for (const [body, kind] of [['<!doctype html><title>Access denied</title>', 'challenge'], ['Service unavailable', 'schema'], ['{"ok":false}', 'schema']]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    }
  });

  it('recognizes a known parcel and the unknown-number answer, and asks nothing for a number SPS does not issue', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'))).recognize!(DELIVERED))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-09-19T07:50:09' });
    await expect(carrier(missing()).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('70299000000011')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers SPS does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['70299000000011', '7039900000001152', '703990000000111', '9900000001', 'SKZZZZ9990000IZZZZ', 'SKZZZZ99900001ZZZZ1', '7'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSpsNumber('703-990-00000011')).toBe(DELIVERED);
    expect(normalizeSpsNumber('skzzzz99900001zzzz')).toBe(RETURNED);
  });

  it('sends a read that failed to reach SPS once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply('returned'));
    await expect(carrier(fetcher).track({ number: RETURNED }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'returned' });
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

  it('routes a parcel filed under Slovak Parcel Service to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('delivered'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'slovak-parcel-service' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'slovak-parcel-service', source: 'slovak-parcel-service', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === `${SPS_API}shipment?shipment_id=${DELIVERED}`)).toBe(true);
  });
});

describe('Slovak Parcel Service status vocabulary', () => {
  it('records every code the map knows with the stage the adapter gives it', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(spsStage(Number(entry.code))).toBe(stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(stage);
    }
    expect(statusMapAnswer({ carrier: 'slovak-parcel-service', providerCode: '260', description: 'Návrat odosielateľovi' }))
      .toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'slovak-parcel-service', providerCode: '41', description: 'Editor hotovosti' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(statusMap.stage('50', 'neznámy krok')).toBeUndefined();
    expect(statusMap.stage('40 ', 'doručenie')).toBeUndefined();
  });
});
