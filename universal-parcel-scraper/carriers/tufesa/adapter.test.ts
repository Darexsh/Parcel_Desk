import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TUFESA_API, TufesaTracker, tufesaLookupUrl } from './adapter.js';
import { normalizeTufesaNumber, parseTufesa } from './parser.js';
import { statusMap, tufesaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '10000000';
const IN_TRANSIT = '20000000';
const UNKNOWN = 'ZZZZ000000';

type Row = Record<string, unknown>;
type Shipment = Row & { historial: Row[]; entrega: Row };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Shipment[];
const changed = (name: string, change: (shipment: Shipment, reply: Shipment[]) => void) => {
  const reply = fixture(name);
  change(reply[0]!, reply);
  return reply;
};
const scan = (mov: string, wording: string, date: string, time: string, place = 'Villa Muestra, Sinaloa'): Row => ({
  code: IN_TRANSIT, movimiento: 'SINTETICO', ubicacion: 'VILLA MUESTRA', fechamov: date, horamov: time, msgnum: 0,
  msgtxt: 'RESULTADO EXITOSO', mov, fchlegible: '', UbicacionLegible: place, MensageCliente: wording,
});
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TufesaPack HTTP adapter', () => {
  it('asks the tracker’s lookup for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(changed('in-transit', (body) => { body.code = UNKNOWN; })));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TufesaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zzzz 000000 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TUFESA_API}?codigo=${UNKNOWN}&push=-`);
    expect(tufesaLookupUrl(DELIVERED)).toBe(`${TUFESA_API}?codigo=${DELIVERED}&push=-`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tufesa', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each shown scan’s wall clock, place and code, newest first', () => {
    const result = parseTufesa(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Envío En Tránsito', last_update: null, last_update_local: '2026-06-11T02:35:00', expected_delivery: null });
    expect(result.events).toEqual([
      { local_time: '2026-06-11T02:35:00', location: 'Ciudad Prueba, Sinaloa', description: 'Envío En Tránsito', provider_code: 'TK',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-06-10T21:00:00', location: 'Villa Muestra, Sinaloa', description: 'Envío En Tránsito', provider_code: 'EM',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-06-10T09:05:00', location: 'Villa Muestra, Sinaloa', description: 'Envío Documentado', provider_code: 'RG',
        stage: 'accepted', stage_source: 'carrier_map' },
    ]);
  });

  it('keeps the delivery without the receiver’s line, the delivery block, the parties or the price', () => {
    const result = parseTufesa(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Envío Entregado', last_update_local: '2026-03-04T16:40:00' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-03-04T16:40:00', 'EN', 'Envío Entregado', 'Villa Muestra, Sinaloa', 'delivered'],
      // Collected at the branch, so the parcel waited there.
      ['2026-03-03T12:00:00', 'RC', 'Recibido En Sucursal Destino', 'Villa Muestra, Sinaloa', 'ready_for_pickup'],
      ['2026-03-03T07:45:00', 'DS', 'Envío En Tránsito', 'Villa Muestra, Sinaloa', 'in_transit'],
      ['2026-03-03T05:20:00', 'TK', 'Envío En Tránsito', 'Ciudad Prueba, Sinaloa', 'in_transit'],
      ['2026-03-03T04:10:00', 'TK', 'Envío En Tránsito', 'Ciudad Prueba, Sinaloa', 'in_transit'],
      ['2026-03-02T18:30:00', 'EM', 'Envío En Tránsito', 'Pueblo Ejemplo, Sonora', 'in_transit'],
      ['2026-03-02T10:15:00', 'RG', 'Envío Documentado', 'Pueblo Ejemplo, Sonora', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.point === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PERSONA|EMPRESA|RECIBIDO|ENTREGA"|10\.0000|-100|AAAA|0\.00|SOBRE|PAGADO|OCURRE/);
  });

  it('reads the destination branch’s receipt by the delivery type, and the recorded delivery over a later line', () => {
    const arrived = (type: string) => changed('in-transit', (body) => {
      body.TipoServicio = type;
      body.historial.push(scan('RC', 'Recibido En Sucursal Destino', '12/06/2026', '08:00'));
    });
    expect(parseTufesa(arrived('OCURRE'), IN_TRANSIT)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    expect(parseTufesa(arrived('SINTETICO'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    // A line recorded after the delivery does not undo it, as on the page.
    const late = parseTufesa(changed('delivered', (body) => {
      body.historial.push({ ...scan('DS', 'Envío En Tránsito', '05/03/2026', '08:00', 'Ciudad Prueba, Sinaloa'), code: DELIVERED });
    }), DELIVERED);
    expect(late).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Envío En Tránsito', last_update_local: '2026-03-05T08:00:00' });
    // Without a recorded delivery the newest staged scan decides.
    expect(parseTufesa(changed('delivered', (body) => { body.entrega.msgnum = -1; body.historial.splice(6); }), DELIVERED))
      .toMatchObject({ current_stage: 'ready_for_pickup' });
  });

  it('keeps an unknown code to the wording rules, a repeated line once and a receiver out of a shown line', () => {
    const result = parseTufesa(changed('in-transit', (body) => {
      body.historial.push(scan('ZZ', 'Línea Sintética', '11/06/2026', '03:00'), scan('ZZ', 'Línea Sintética', '11/06/2026', '03:00'),
        scan('', 'Envío Entregado, recibido por Persona Ejemplo', '11/06/2026', '04:00', '-'));
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 2)).toEqual([
      { local_time: '2026-06-11T04:00:00', description: 'Envío Entregado', stage: 'delivered', stage_source: 'wording:language' },
      { local_time: '2026-06-11T03:00:00', location: 'Villa Muestra, Sinaloa', description: 'Línea Sintética', provider_code: 'ZZ' },
    ]);
    expect(result.events).toHaveLength(5);
    expect(tufesaStage('ZZ', 'Línea Sintética', false)).toBeNull();
  });

  it('reads the unknown-code answer and an empty array as not found, and a shipment without shown lines as no history', () => {
    expect(() => parseTufesa(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTufesa([], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTufesa(changed('delivered', (body) => { body.historial = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseTufesa(changed('delivered', (body) => { body.historial.forEach((row) => { row.MensageCliente = ''; }); }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // Another answer number is a lookup that did not finish.
    expect(() => parseTufesa(changed('not-found', (body) => { body.msgnum = 1; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TufesaPack did not complete the lookup' }));
  });

  it('counts a reply only when it echoes the number asked and, for a shipment number, is that shipment', () => {
    expect(() => parseTufesa(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TufesaPack answered for another number' }));
    expect(() => parseTufesa(fixture('not-found'), 'YYYY000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The lookup also finds a shipment by another reference, which then has its own number.
    expect(() => parseTufesa(changed('delivered', (body) => { body.Rastreo = IN_TRANSIT; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TufesaPack answered for another shipment' }));
    expect(() => parseTufesa(changed('delivered', (body, all) => { all.push(structuredClone(body)); }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TufesaPack answered with several shipments' }));
    // A code of letters and digits is bound by the echo alone.
    expect(parseTufesa(changed('in-transit', (body) => { body.code = UNKNOWN.toLowerCase(); }), UNKNOWN).events).toHaveLength(3);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_body: Shipment, all: Shipment[]) => { all[0] = 'shipment' as never; },
      (body: Shipment) => { delete body.code; },
      (body: Shipment) => { body.code = 10000000; },
      (body: Shipment) => { delete body.msgnum; },
      (body: Shipment) => { body.msgnum = '0'; },
      (body: Shipment) => { body.Rastreo = 10000000; },
      (body: Shipment) => { body.historial = 'scans' as never; },
      (body: Shipment) => { body.historial[0] = 'scan' as never; },
      (body: Shipment) => { body.historial[0]!.fechamov = '2026-03-02'; },
      (body: Shipment) => { body.historial[0]!.fechamov = '31/02/2026'; },
      (body: Shipment) => { body.historial[0]!.horamov = '10:15:00'; },
      (body: Shipment) => { body.historial[0]!.horamov = '24:00'; },
      (body: Shipment) => { delete body.historial[0]!.horamov; },
      (body: Shipment) => { body.historial[0]!.MensageCliente = ['Envío Documentado']; },
      (body: Shipment) => { body.historial[0]!.mov = 1; },
      (body: Shipment) => { body.historial = Array.from({ length: 501 }, () => body.historial[0]!); },
    ]) {
      expect(() => parseTufesa(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTufesa({ msgnum: 0 }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown code, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The page reads a missing parcel from a 200 reply: a 404 or a redirect is a moved route.
    await expect(lookup('<html><title>404 - File or directory not found.</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://tufesapack.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Web Page Blocked</title><body>Attack ID: 00000000</body></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><script>window._cf_chl_opt = {}</script></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>TufesaPack</title></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-code answer, and asks nothing for a number TufesaPack does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-04T16:40:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('0000000000')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers TufesaPack does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000000', '00000000', '01000000', '100000', '100000000', 'ZZZ000000', 'ZZZZ0000000', 'ZZZZZ00000', 'ZZZZ/000000']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTufesaNumber('zzzz 000-000')).toBe(UNKNOWN);
    expect(normalizeTufesaNumber('1000000')).toBe('1000000');
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under TufesaPack to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'tufesa' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'tufesa', source: 'tufesa', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === tufesaLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('TufesaPack numbers', () => {
  it('leaves its shapes to other carriers’ rules', () => {
    for (const number of [DELIVERED, '1000000', UNKNOWN]) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('tufesa');
    }
  });
});

describe('TufesaPack status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(tufesaStage(entry.code, entry.wording, true)?.stage, entry.code).toBe(entry.stage);
      if (entry.code === 'RC') {
        // Its stage comes from the delivery type, which the map does not see.
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBeUndefined();
        expect(tufesaStage(entry.code, entry.wording, false)?.stage).toBe('in_transit');
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'tufesa', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'tufesa', providerCode: 'RC', description: 'Recibido En Sucursal Destino' })).toEqual({ kind: 'unknown' });
    expect(statusMap.stage(null, 'envío entregado')).toBeUndefined();
  });
});
