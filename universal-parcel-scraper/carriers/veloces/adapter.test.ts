import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, VELOCES_API, VelocesTracker } from './adapter.js';
import { normalizeVelocesNumber, parseVeloces } from './parser.js';
import { statusMap, velocesStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = 'V0000000001';
const DELIVERED = 'V0000000002';
const UNKNOWN = 'V0000000003';

type Row = Record<string, unknown>;
type Shipment = Row & { shipment_status: Row; shipment_status_history: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Shipment;
const changed = (name: string, change: (shipment: Shipment) => void) => {
  const shipment = fixture(name);
  change(shipment);
  return shipment;
};
// A history row of the fixtures' shape, with another status and clock.
const status = (shipment: Shipment, id: number, name: string, at: string, attempt: number | null = 1): Row => ({
  ...shipment.shipment_status_history.at(-1)!, created_at: at, shipment_status_id: id, shipment_try: attempt,
  shipment_status: { ...shipment.shipment_status, id, name }, shipment_return_reason: null,
});
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Veloces HTTP adapter', () => {
  it('asks the tracker’s lookup for the whole guide once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new VelocesTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' v 0000-000001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${VELOCES_API}${IN_TRANSIT}/tracking`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'X-White-Label': 'false', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'veloces', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a delivered history on its UTC instants, with the courier’s reason, and none of the shipment’s people or papers', () => {
    const result = parseVeloces(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: '2026-05-13T19:42:07Z', delivered_at: '2026-05-13T19:42:07Z' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.description])).toEqual([
      ['2026-05-13T19:42:07Z', '4', 'delivered', 'Entregado'],
      ['2026-05-13T15:00:00Z', '8', 'out_for_delivery', 'En Camino'],
      ['2026-05-13T14:30:00Z', '3', 'in_transit', 'En Ruta'],
      // The destination warehouse logged twice in one attempt is kept once, as the tracker shows it.
      ['2026-05-13T14:00:00Z', '13', 'in_transit', 'Bodega Destino'],
      ['2026-05-13T13:00:00Z', '17', 'exception', 'Novedad (En bodega)'],
      ['2026-05-12T21:45:30Z', '5', 'failed_attempt', 'Novedad: No hay quien reciba'],
      ['2026-05-12T15:30:00Z', '8', 'out_for_delivery', 'En Camino'],
      ['2026-05-12T13:10:00Z', '3', 'in_transit', 'En Ruta'],
      ['2026-05-11T22:05:10Z', '2', 'accepted', 'Bodega Origen'],
      ['2026-05-11T16:20:40Z', '11', 'accepted', 'Recogido por transportadora'],
      ['2026-05-11T14:00:05Z', '1', 'registered', 'Guía Generada'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.location === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample|300 000|ID-SAMPLE|Calle|SAMPLE|example\.invalid|\.jpg|Flete|AAA000|Veloces|aaaaaaaa/);
  });

  it('reads a parcel on its way, and takes the summary’s status over the newest row', () => {
    expect(parseVeloces(fixture('in-transit'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'En Ruta', last_update: '2026-06-03T13:40:00Z' });
    expect(parseVeloces(fixture('in-transit'), IN_TRANSIT)).not.toHaveProperty('delivered_at');
    const out = parseVeloces(changed('in-transit', (shipment) => {
      shipment.shipment_status_history.push(status(shipment, 8, 'En Camino', '2026-06-04T14:05:00Z'));
      shipment.shipment_status = { ...shipment.shipment_status, id: 8, name: 'En Camino' };
    }), IN_TRANSIT);
    expect(out).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'En Camino' });
    // A summary ahead of the history names the status itself.
    const ahead = parseVeloces(changed('in-transit', (shipment) => {
      shipment.shipment_status = { ...shipment.shipment_status, id: 13, name: 'Bodega Destino' };
    }), IN_TRANSIT);
    expect(ahead).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Bodega Destino', last_update: '2026-06-03T13:40:00Z' });
  });

  it('reads a return to the shop', () => {
    const result = parseVeloces(changed('delivered', (shipment) => {
      const rows = shipment.shipment_status_history;
      rows.splice(rows.length - 5, 5,
        status(shipment, 16, 'En Proceso de Devolución', '2026-05-13T16:00:00Z'),
        status(shipment, 21, 'Devolución en Bodega', '2026-05-13T20:00:00Z'),
        status(shipment, 22, 'Devolución en ruta', '2026-05-14T13:00:00Z'),
        status(shipment, 9, 'Devolución Proveedor', '2026-05-14T21:00:00Z'));
      shipment.shipment_status = { ...shipment.shipment_status, id: 9, name: 'Devolución Proveedor', is_return: true };
    }), DELIVERED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Devolución Proveedor', last_update: '2026-05-14T21:00:00Z' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.slice(0, 4).map((event) => event.stage)).toEqual(['returned', 'returned', 'returned', 'returned']);
  });

  it('stages a status id it does not know by its name, else leaves it and keeps the last staged one', () => {
    const named = parseVeloces(changed('in-transit', (shipment) => {
      shipment.shipment_status_history.push(status(shipment, 99, 'Entregado en oficina', '2026-06-04T14:05:00Z'));
      shipment.shipment_status = { ...shipment.shipment_status, id: 99, name: 'Entregado en oficina' };
    }), IN_TRANSIT);
    expect(named.events![0]).toMatchObject({ provider_code: '99', stage: 'delivered', stage_source: 'wording:language' });
    const unnamed = parseVeloces(changed('in-transit', (shipment) => {
      shipment.shipment_status_history.push(status(shipment, 98, 'Synthetic status', '2026-06-04T14:05:00Z'));
      shipment.shipment_status = { ...shipment.shipment_status, id: 98, name: 'Synthetic status' };
    }), IN_TRANSIT);
    expect(unnamed).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic status', last_update: '2026-06-04T14:05:00Z' });
    expect(unnamed.events![0]).not.toHaveProperty('stage');
  });

  it('puts the history newest first by instant, keeping the reply’s order on one clock', () => {
    const reversed = parseVeloces(changed('delivered', (shipment) => { shipment.shipment_status_history.reverse(); }), DELIVERED);
    expect(reversed.events!.map((event) => event.provider_code)).toEqual(parseVeloces(fixture('delivered'), DELIVERED).events!
      .map((event) => event.provider_code));
    const tied = parseVeloces(changed('in-transit', (shipment) => {
      shipment.shipment_status_history.push(status(shipment, 8, 'En Camino', '2026-06-03T13:40:00Z'));
    }), IN_TRANSIT);
    expect(tied.events!.slice(0, 2).map((event) => event.provider_code)).toEqual(['8', '3']);
    // An offset other than UTC keeps its own.
    const offset = parseVeloces(changed('in-transit', (shipment) => {
      shipment.shipment_status_history.at(-1)!.created_at = '2026-06-03T08:40:00-05:00';
    }), IN_TRANSIT);
    expect(offset.last_update).toBe('2026-06-03T08:40:00-05:00');
  });

  it('reads a shipment without rows from its summary, and nothing at all as no history', () => {
    expect(parseVeloces(changed('in-transit', (shipment) => { shipment.shipment_status_history = []; }), IN_TRANSIT)).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'En Ruta', last_update: null, provider_code: '3', summary_only: true, events: [],
    });
    expect(() => parseVeloces(changed('in-transit', (shipment) => {
      shipment.shipment_status_history = [];
      (shipment as Row).shipment_status = null;
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads the service’s own error as not found', () => {
    expect(() => parseVeloces(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('counts a shipment only when it names the guide asked', () => {
    expect(() => parseVeloces(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Veloces answered for another shipment' }));
    expect(parseVeloces(changed('in-transit', (shipment) => { shipment.tracking_number = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(5);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (shipment: Shipment) => { delete shipment.tracking_number; },
      (shipment: Shipment) => { shipment.tracking_number = 1; },
      (shipment: Shipment) => { shipment.shipment_status = 'En Ruta' as never; },
      (shipment: Shipment) => { shipment.shipment_status = { id: '3', name: 'En Ruta' }; },
      (shipment: Shipment) => { shipment.shipment_status = { id: 3, name: ' ' }; },
      (shipment: Shipment) => { shipment.shipment_status_history = 'history' as never; },
      (shipment: Shipment) => { shipment.shipment_status_history = Array.from({ length: 501 }, () => shipment.shipment_status_history[0]!); },
      (shipment: Shipment) => { shipment.shipment_status_history[0] = 'row' as never; },
      (shipment: Shipment) => { shipment.shipment_status_history[0]!.shipment_status = null; },
      (shipment: Shipment) => { shipment.shipment_status_history[0]!.shipment_status_id = 2; },
      (shipment: Shipment) => { shipment.shipment_status_history[0]!.created_at = '2026-06-01T15:00:00'; },
      (shipment: Shipment) => { shipment.shipment_status_history[0]!.created_at = '01-06-2026 15:00:00Z'; },
      (shipment: Shipment) => { shipment.shipment_status_history[0]!.created_at = 1780326000000; },
      (shipment: Shipment) => { shipment.shipment_status_history[0]!.shipment_try = 'first'; },
      (shipment: Shipment) => { shipment.shipment_status_history[0]!.shipment_return_reason = 'Sample reason'; },
    ]) {
      expect(() => parseVeloces(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [null, [], 'shipment']) {
      expect(() => parseVeloces(body, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown guide, a moved route, a browser check, a rate limit and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'not_found' });
    // Only the service's own error is an unknown guide: a bare 404 page or another error is a moved route.
    await expect(lookup('<!DOCTYPE html><title>404: This page could not be found.</title>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ message: 'Not Found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 307, headers: { Location: 'https://tracking.veloces.app/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Vercel Security Checkpoint</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    // Ten lookups every ten seconds; the reply says when its window opens, on its own clock.
    await expect(lookup({ code: 'rate_limit_exceeded', message: 'rate limit exceeded try again in 5 seconds' }, { status: 429, headers: {
      Date: 'Mon, 01 Jun 2026 15:00:00 GMT', 'X-RateLimit-Limit': '10', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Date.parse('2026-06-01T15:00:05Z') / 1000),
    } })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 5000 });
    await expect(lookup({ code: 'rate_limit_exceeded' }, { status: 429 })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: undefined });
    await expect(lookup('<html><title>Veloces</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('null')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects guides Veloces does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['V12121212', 'V12121212121', 'X1212121212', '12121212121', `V${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeVelocesNumber('v 0000-000-002')).toBe(DELIVERED);
  });

  it('retries a read that fails to reach the site once, within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a guide filed under Veloces to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'veloces' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'veloces', source: 'veloces', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${VELOCES_API}${DELIVERED}/tracking`)).toBe(true);
  });
});

describe('Veloces numbers', () => {
  it('claims no guide shape: V and ten digits stays with the carriers whose rules already offer it', () => {
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('veloces');
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('veloces');
  });
});

describe('Veloces status vocabulary', () => {
  it('records every status id the map knows with the stage it gives', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string }[];
    for (const entry of entries.filter((item) => item.code)) {
      expect(statusMap.stage(entry.code!, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(velocesStage(entry.code!, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'veloces', providerCode: '5', description: 'Novedad: No hay quien reciba' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'veloces', providerCode: '98', description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
    expect(velocesStage('98', 'Synthetic status')).toBeNull();
  });
});
