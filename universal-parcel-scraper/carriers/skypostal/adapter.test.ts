import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, openSkypostalText, SKYPOSTAL_API, SkypostalTracker, sealSkypostalText, skypostalRequest } from './adapter.js';
import { normalizeSkypostalNumber, readSkypostal, skypostalSummaryNames } from './parser.js';
import { skypostalStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Key derivation a test can hold, as a busy host's thread pool does: the next `allowed` keys, then none.
const derivation = vi.hoisted(() => ({ allowed: Infinity, held: () => {} }));
vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, pbkdf2: (...args: Parameters<typeof crypto.pbkdf2>) => {
    if (derivation.allowed-- > 0) crypto.pbkdf2(...args); else derivation.held();
  } };
});
const held = () => new Promise<void>((resolve) => { derivation.held = resolve; });

const DELIVERED = 'SKAMZUS0000000001';
const IN_TRANSIT = 'SKAMZUS0000000002';
const UNKNOWN = 'SKAMZUS0000000000';
const DELIVERED_WAYBILL = 10000000;
const IN_TRANSIT_WAYBILL = 20000000;

type Row = Record<string, unknown>;
type Reply = { shipmentSearchSingle: Row & { data: Row[] }; shipmentSearchSingleCargo: unknown };

const fixture = <T = Reply>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const changed = (name: string, change: (rows: Row[], reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.shipmentSearchSingle.data, reply);
  return reply;
};
const sealed = async (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify({ payload: await sealSkypostalText(JSON.stringify(body)) }),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const plain = (body: string, init: ResponseInit = {}) => new Response(body, init);
const opened = async (init: RequestInit | undefined) => JSON.parse(await openSkypostalText(JSON.parse(String(init?.body)).payload)) as Row;
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SkyPostal sealed lookup', () => {
  it('seals one lookup for the whole number in capitals as the page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => sealed(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SkypostalTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' skamzus 0000000001 ', { budgetMs: 5000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SKYPOSTAL_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    const lookup = await opened(init);
    expect(lookup).toMatchObject({ action: 'asyncSingleTracking', trackingSearch: DELIVERED, lngCode: 'ENG' });
    // The visitor's details and the guest account are sealed under half the visitor id's MD5.
    const headers = init!.headers as Record<string, string>;
    const visitor = createHash('md5').update(headers['x-guid']!).digest('hex').slice(0, 16);
    await expect(openSkypostalText(headers['x-skpdata']!, visitor)).resolves.toMatch(new RegExp(`^${headers['x-guid']}\\|\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z\\|127\\.0\\.0\\.1$`));
    await expect(openSkypostalText(headers['x-sdata']!, visitor)).resolves.toBe('127.0.0.1');
    const account = lookup.userInfo as Record<string, string>;
    await expect(openSkypostalText(account.userCode!, visitor)).resolves.toBe('1897');
    expect(await openSkypostalText(account.userKey!, visitor)).toBe(await openSkypostalText(account.appKey!, visitor));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'skypostal', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('builds a fresh visitor for every request and opens only what it sealed', async () => {
    const [first, second] = await Promise.all([skypostalRequest('asyncSingleTracking', DELIVERED), skypostalRequest('asyncSingleTracking', DELIVERED)]);
    expect(first.headers['x-guid']).not.toBe(second.headers['x-guid']);
    await expect(openSkypostalText(await sealSkypostalText('texto'), 'otra')).rejects.toThrow();
    await expect(openSkypostalText('a.b.c')).rejects.toThrow(TypeError);
  });

  it('keeps each scan’s wall clock, place, wording and code, newest first, without the comments, proof or labels', () => {
    const { result, waybill, named } = readSkypostal(fixture('delivered'), DELIVERED);
    expect({ waybill, named }).toEqual({ waybill: DELIVERED_WAYBILL, named: true });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2026-05-20T16:40:12', expected_delivery: null });
    expect(result.events!.slice(0, 5)).toEqual([
      { local_time: '2026-05-20T16:40:12', location: 'VILLA MUESTRA', description: 'DELIVERED', provider_code: 'DEL', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-05-20T08:05:40', location: 'VILLA MUESTRA', description: 'OUT FOR DELIVERY', provider_code: 'OFD', stage: 'out_for_delivery',
        stage_source: 'carrier_map' },
      { local_time: '2026-05-19T21:10:00', location: 'CIUDAD PRUEBA', description: 'PACKAGE RECEIVED AT TRANSFER HUB', provider_code: 'PRH',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-05-19T06:30:00', location: 'CIUDAD PRUEBA', description: 'TENDERED TO LOCAL CARRIER', provider_code: 'TTC', stage: 'in_transit',
        stage_source: 'carrier_map' },
      // Without the partner's town, SkyPostal's station.
      { local_time: '2026-05-18T17:25:00', location: 'SAO', description: 'CUSTOMS CLEARED', provider_code: 'CCH', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(result.events).toHaveLength(19);
    // The fuel surcharge moves nothing.
    expect(result.events!.find((event) => event.provider_code === 'FSC')).toEqual({ local_time: '2026-05-16T10:30:00', location: 'MIA',
      description: 'FUEL SURCHARGE', provider_code: 'FSC' });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-05-12T01:46:50', provider_code: 'DRC', stage: 'registered' });
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Persona|example\.invalid|operador|postrac|MANIFEST|BAG|em rota|SP0+1BR|SKAMZUS|10000000|GMT/);
  });

  it('reads a history whose scans carry only SkyPostal’s label, named by the page’s summary view', async () => {
    const reading = readSkypostal(fixture('in-transit'), IN_TRANSIT);
    expect(reading).toMatchObject({ waybill: IN_TRANSIT_WAYBILL, named: false,
      result: { status: 'in_transit', current_stage: 'customs', last_status_text: 'CUSTOMS ENTRY', last_update_local: '2026-06-04T09:10:00' } });
    // The airline's handover at the destination airport is no delivery.
    expect(reading.result.events![1]).toMatchObject({ provider_code: 'DTP', stage: 'in_transit' });
    expect(skypostalSummaryNames(fixture('summary'), IN_TRANSIT, IN_TRANSIT_WAYBILL)).toBe(true);
    expect(skypostalSummaryNames(fixture('summary'), IN_TRANSIT, DELIVERED_WAYBILL)).toBe(false);
    expect(skypostalSummaryNames(fixture('summary'), DELIVERED, IN_TRANSIT_WAYBILL)).toBe(false);
    // The summary's echo of the number asked names nothing.
    expect(skypostalSummaryNames([{ ...fixture<Row[]>('summary')[0], external_tracking: '', order_label: '' }], IN_TRANSIT, IN_TRANSIT_WAYBILL)).toBe(false);

    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => sealed(fixture('in-transit')))
      .mockImplementationOnce(async () => sealed(fixture('summary')));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await opened(fetcher.mock.calls[1]![1])).toMatchObject({ action: 'shipmentSearchMultipleSkp', trackingSearch: [IN_TRANSIT], lngCode: 'ENG' });

    const other = vi.fn<typeof fetch>().mockImplementationOnce(async () => sealed(fixture('in-transit')))
      .mockImplementationOnce(async () => sealed([{ ...fixture<Row[]>('summary')[0], trck_nmr_fol: DELIVERED_WAYBILL }]));
    await expect(carrier(other).track({ number: IN_TRANSIT }))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'SkyPostal answered for another shipment' });
  });

  it('binds a history to a scan’s label or the waybill, and only to one shipment', () => {
    // The waybill is a number the tracker answers too.
    expect(readSkypostal(fixture('in-transit'), String(IN_TRANSIT_WAYBILL)).named).toBe(true);
    expect(readSkypostal(fixture('delivered'), 'SP000000000001BR').named).toBe(true);
    expect(readSkypostal(fixture('delivered'), IN_TRANSIT).named).toBe(false);
    expect(() => readSkypostal(changed('delivered', (rows) => { rows[3]!.trck_nmr_fol = IN_TRANSIT_WAYBILL; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SkyPostal answered with several shipments' }));
  });

  it('keeps a delivery over a later scan of an earlier stage, but not over a later problem', () => {
    const late = (code: string, wording: string) => changed('delivered', (rows) => {
      rows.unshift({ ...structuredClone(rows[1]!), track_cdg: code, track_description: wording, entry_date_str: '2026-05-20 20:05:40' });
    });
    expect(readSkypostal(late('OFD', 'OUT FOR DELIVERY'), DELIVERED).result).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      last_status_text: 'OUT FOR DELIVERY', last_update_local: '2026-05-20T20:05:40' });
    expect(readSkypostal(late('ICA', 'INCORRECT / INCOMPLETE ADDRESS'), DELIVERED).result).toMatchObject({ status: 'exception', current_stage: 'exception' });
  });

  it('keeps an unknown code to the wording rules, billing without a stage and a repeated scan once', () => {
    const { result } = readSkypostal(changed('in-transit', (rows) => {
      rows.unshift({ ...structuredClone(rows[0]!), track_cdg: 'ZZZ', track_description: 'AVAILABLE FOR PICKUP', entry_date_str: '2026-06-05 10:00:00' },
        { ...structuredClone(rows[0]!), track_cdg: 'PAY', track_description: 'BILLED', entry_date_str: '2026-06-05 09:00:00' });
      rows.push(structuredClone(rows.at(-1)!));
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 2)).toEqual([
      { local_time: '2026-06-05T10:00:00', location: 'SAO', description: 'AVAILABLE FOR PICKUP', provider_code: 'ZZZ', stage: 'ready_for_pickup',
        stage_source: 'wording:language' },
      { local_time: '2026-06-05T09:00:00', location: 'SAO', description: 'BILLED', provider_code: 'PAY' },
    ]);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(result.events).toHaveLength(16);
    expect(skypostalStage('ZZZ', 'Línea sintética')).toBeNull();
  });

  it('reads error 10001 as not found and anything else without scans as an unfinished lookup', () => {
    expect(() => readSkypostal(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const change of [
      (rows: Row[]) => { (rows[0]!.error as Row).error_code = '10002'; },
      (rows: Row[]) => { rows.push(structuredClone(rows[0]!)); },
      (rows: Row[]) => { rows.length = 0; },
      (_rows: Row[], reply: Reply) => { reply.shipmentSearchSingle.error = { error_code: '1', error_description: 'Error' }; },
    ]) {
      expect(() => readSkypostal(changed('not-found', change), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // A scan beside an error row is no complete answer either.
    expect(() => readSkypostal(changed('delivered', (rows) => { rows.push(fixture('not-found').shipmentSearchSingle.data[0]!); }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The page opens its cargo view for a number with only an air consignment behind it.
    expect(() => readSkypostal(changed('not-found', (_rows, reply) => { reply.shipmentSearchSingleCargo = [{ awb: '1' }]; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SkyPostal knows the number as an air consignment, not a parcel' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_rows: Row[], reply: Reply) => { reply.shipmentSearchSingle = 'reply' as never; },
      (_rows: Row[], reply: Reply) => { reply.shipmentSearchSingle.data = 'scans' as never; },
      (rows: Row[]) => { rows[0] = 'scan' as never; },
      (rows: Row[]) => { rows[0]!.error = 'none'; },
      (rows: Row[]) => { delete rows[0]!.trck_nmr_fol; },
      (rows: Row[]) => { rows[0]!.trck_nmr_fol = String(DELIVERED_WAYBILL); },
      (rows: Row[]) => { rows[0]!.track_description = ''; },
      (rows: Row[]) => { rows[0]!.track_description = ['DELIVERED']; },
      (rows: Row[]) => { rows[0]!.track_cdg = 1; },
      (rows: Row[]) => { rows[0]!.entry_date_str = '2026-05-20T16:40:12'; },
      (rows: Row[]) => { rows[0]!.entry_date_str = '2026-02-30 16:40:12'; },
      (rows: Row[]) => { rows[0]!.entry_date_str = '2026-05-20 24:00:00'; },
      (rows: Row[]) => { delete rows[0]!.entry_date_str; },
      (rows: Row[]) => { rows[0]!.event_locality = 1; },
      (rows: Row[]) => { rows.push(...Array.from({ length: 501 }, () => rows[0]!)); },
    ]) {
      expect(() => readSkypostal(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => readSkypostal([], DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => skypostalSummaryNames({}, IN_TRANSIT, IN_TRANSIT_WAYBILL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => skypostalSummaryNames(['row'], IN_TRANSIT, IN_TRANSIT_WAYBILL)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check, a refused seal and a broken reply apart', async () => {
    const lookup = (response: () => Promise<Response> | Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: UNKNOWN });
    await expect(lookup(() => sealed(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup(() => plain('{"statusCode":404,"message":"Cannot POST /api/secure","error":"Not Found"}', { status: 404 })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => plain('', { status: 302, headers: { Location: 'https://www.skypostal.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => plain('<html><script>window._cf_chl_opt = {}</script></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => plain('<html><title>Attention Required! | Cloudflare</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // The gateway's own refusal of a request sealed another way.
    await expect(lookup(() => plain('{"statusCode":403,"message":"Illegal argument undefined","error":"Forbidden"}', { status: 403 })))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => plain('<html><title>Tracking | Skypostal</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => plain('{"data":[]}'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => plain('{"payload":"a.b.c.d"}'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(async () => plain(JSON.stringify({ payload: await sealSkypostalText('not json') })))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
        status === 429 ? '{"statusCode":429,"message":"ThrottlerException: Too Many Requests"}' : '', { status, headers: status === 429 ? { 'Retry-After': '49' } : {} }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('waits as long as the gateway’s throttle asks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"statusCode":429}', { status: 429, headers: { 'Retry-After': '49' } }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 49_000 });
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number SkyPostal does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => sealed(fixture('delivered')))
      .mockImplementationOnce(async () => sealed(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-20T16:40:12' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('0000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers SkyPostal does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000', 'SKAMZUS', 'SKAMZUS/000000001', 'Ñ0000000000', '0'.repeat(41)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSkypostalNumber('skamzus-0000000002')).toBe(IN_TRANSIT);
    expect(normalizeSkypostalNumber('20000000')).toBe('20000000');
  });

  it('ends a hanging read inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }]);
    let requested!: () => void;
    const sent = new Promise<void>((resolve) => { requested = resolve; });
    const lookup = expect(carrier((input, init) => { requested(); return fetcher(input, init); })
      .track({ number: IN_TRANSIT }, { budgetMs: 200 })).rejects.toThrow();
    // Sealing takes real time but none on the faked clock.
    await sent;
    await vi.advanceTimersByTimeAsync(200);
    await lookup;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(ended).toEqual([200]);
  });

  it('stops waiting for a key it derives once the lookup ends', async () => {
    const reply = await sealed(fixture('delivered'));
    fakeBudgetClock();
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply);
      derivation.allowed = 0;
      let holding = held();
      const sealing = expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 200 })).rejects.toMatchObject({ name: 'TimeoutError' });
      await holding;
      await vi.advanceTimersByTimeAsync(200);
      await sealing;
      expect(fetcher).not.toHaveBeenCalled();
      // The request's two keys, then the reply's.
      derivation.allowed = 2;
      holding = held();
      const controller = new AbortController();
      const opening = expect(carrier(fetcher).track({ number: DELIVERED }, { signal: controller.signal })).rejects.toThrow('cancelled');
      await holding;
      controller.abort(new Error('cancelled'));
      await opening;
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      derivation.allowed = Infinity;
    }
  });

  it('routes a number filed under SkyPostal to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => sealed(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'skypostal' }, { budgetMs: 5000 }))
      .resolves.toMatchObject({ carrier: 'skypostal', source: 'skypostal', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === SKYPOSTAL_API)).toBe(true);
  });
});

describe('SkyPostal numbers', () => {
  it('claims its own prefix', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'skypostal' });
  });
});

describe('SkyPostal status vocabulary', () => {
  it('records every code the map knows with the stage it gives, and the codes it leaves out on purpose', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string }[]) {
      if (!entry.stage) {
        expect(skypostalStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'skypostal', providerCode: entry.code, description: entry.wording }), entry.code)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(skypostalStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'skypostal', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
  });
});
