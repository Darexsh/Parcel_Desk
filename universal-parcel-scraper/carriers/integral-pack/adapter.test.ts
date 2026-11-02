import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, INTEGRAL_PACK_API, IntegralPackTracker, integralPackLookupUrl } from './adapter.js';
import { normalizeIntegralPackGuide, parseIntegralPack } from './parser.js';
import { integralPackStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '1234P00000001';
const MOVING = '1234B00000002';
const UNKNOWN = '1234A00000003';

type Row = Record<string, unknown>;
type Reply = Row & { EstadoActual: Row; DatosEnvio: Row & { AgenciaDestino: Row; DetalleBultos: Row }; VentaEventos: Row[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (fetcher: typeof fetch, number = DELIVERED) => carrier(fetcher).track({ number });
const answering = (...responses: Response[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return fetcher;
};
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// The site's own page for an address it does not have.
const MISSING_PAGE = '<!doctype html><html lang="es"><head><title>Integral Pack - Página no encontrada</title></head><body></body></html>';

describe('Integral Pack HTTP adapter', () => {
  it('asks the tracking page’s lookup once for the whole guide, padded and prefixed as the page sends it, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new IntegralPackTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1234 - b - 2 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${INTEGRAL_PACK_API}?codigo=IPE-1234-B-00000002`);
    expect(String(url)).toBe(integralPackLookupUrl(MOVING));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'integral-pack', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel collected at the destination agency with its wall clocks, the agency and the weight, without the people or the address', () => {
    const result = parseIntegralPack(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregada', last_update: null, last_update_local: '2026-05-12T11:40:05', expected_delivery: null,
      pickup_point: 'VILLA EJEMPLO CENTRO\nAvenida Muestra 100', weight_kg: 3.5,
      events: [
        { local_time: '2026-05-12T11:40:05', location: 'VILLA EJEMPLO', description: 'Entregada', stage: 'delivered', stage_source: 'carrier_map' },
        // The repeated event is kept once.
        { local_time: '2026-05-10T17:31:23', location: 'VILLA EJEMPLO', description: 'En destino', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-05-08T18:25:44', location: 'PUEBLO MUESTRA', description: 'Creada', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Sample|calle falsa|Telefono|-30\.12|-60\.76|Tu paquete|00000001-1/);
  });

  it('reads a parcel at the destination branch for the door without a pickup point or a weight', () => {
    const result = parseIntegralPack(fixture('in-transit'), MOVING);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'En destino', last_update: null, last_update_local: '2026-06-03T09:02:10' });
    expect(result).not.toHaveProperty('pickup_point');
    expect(result).not.toHaveProperty('weight_kg');
    expect(result.events!.map((event) => [event.local_time, event.location, event.stage])).toEqual([
      ['2026-06-03T09:02:10', 'CIUDAD PRUEBA', 'in_transit'],
      ['2026-06-01T10:15:00', 'PUEBLO MUESTRA', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample Shop|Persona|calle de muestra|Calle Ejemplo|000-0000000/);
  });

  it('lets the current state settle the status, orders events by wall clock and leaves out an event without a name', () => {
    // The state is newer than the events it lists.
    const ahead = parseIntegralPack(changed('in-transit', (body) => { body.EstadoActual.EstadoActualNombre = 'Entregada'; }), MOVING);
    expect(ahead).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'En destino' });
    // A state the map does not know falls to the newest staged event.
    const unknown = parseIntegralPack(changed('in-transit', (body) => { body.EstadoActual.EstadoActualNombre = 'Synthetic state'; }), MOVING);
    expect(unknown).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    const stateless = parseIntegralPack(changed('in-transit', (body) => { delete (body as Partial<Reply>).EstadoActual; }), MOVING);
    expect(stateless).toMatchObject({ current_stage: 'in_transit' });
    const listed = parseIntegralPack(changed('delivered', (body) => {
      body.VentaEventos.reverse();
      // A later row in the same second is the newer event.
      body.VentaEventos.push({ FechaYHora: '2026-05-12T11:40:05', LocalidadNombre: null, NombreEvento: 'Synthetic note' });
      body.VentaEventos.push({ FechaYHora: '2026-05-13T08:00:00', LocalidadNombre: 'VILLA EJEMPLO', NombreEvento: null });
      body.VentaEventos.push({ FechaYHora: '2026-05-13T09:00:00', LocalidadNombre: 'VILLA EJEMPLO', NombreEvento: '  ' });
    }), DELIVERED);
    expect(listed.events!.map((event) => event.description)).toEqual(['Synthetic note', 'Entregada', 'En destino', 'Creada']);
    expect(listed).toMatchObject({ status: 'delivered', last_status_text: 'Synthetic note', last_update_local: '2026-05-12T11:40:05' });
    expect(listed.events![0]).not.toHaveProperty('stage');
  });

  it('keeps no pickup point for a door delivery, an agency without a name or an unknown delivery type', () => {
    for (const change of [
      (body: Reply) => { body.DatosEnvio.TipoEntrega = 1; },
      (body: Reply) => { body.DatosEnvio.TipoEntrega = '2'; },
      (body: Reply) => { body.DatosEnvio.AgenciaDestino.Nombre = ''; },
      (body: Reply) => { body.DatosEnvio.AgenciaDestino = null as unknown as Row; },
    ]) {
      expect(parseIntegralPack(changed('delivered', change), DELIVERED)).not.toHaveProperty('pickup_point');
    }
    expect(parseIntegralPack(changed('delivered', (body) => { body.DatosEnvio.AgenciaDestino.Direccion = null; }), DELIVERED))
      .toMatchObject({ pickup_point: 'VILLA EJEMPLO CENTRO' });
    for (const kg of [-1, '3.5', null]) {
      expect(parseIntegralPack(changed('delivered', (body) => { body.DatosEnvio.DetalleBultos.PesoTotalKg = kg; }), DELIVERED)).not.toHaveProperty('weight_kg');
    }
  });

  it('reads the empty list as not found, an error notice as inconclusive and a guide without events as no history', async () => {
    expect(() => parseIntegralPack(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(lookup(answering(reply(fixture('not-found'))), UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseIntegralPack({ Error: 'Synthetic failure' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const VentaEventos of [[], null, [{ FechaYHora: '2026-05-08T18:25:44', LocalidadNombre: 'PUEBLO MUESTRA', NombreEvento: null }]]) {
      expect(() => parseIntegralPack({ ...fixture('delivered'), VentaEventos }, DELIVERED))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('binds the answer to the whole guide asked', async () => {
    expect(() => parseIntegralPack(fixture('delivered'), MOVING))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Integral Pack answered for another guide' }));
    await expect(lookup(answering(reply(fixture('delivered'))), '1234P00000011')).rejects.toMatchObject({ kind: 'indeterminate' });
    for (const change of [
      (body: Reply) => { body.DatosEnvio.Serie = 1235; },
      (body: Reply) => { body.DatosEnvio.Tipo = 'B'; },
      (body: Reply) => { body.DatosEnvio.Numero = 10; },
    ]) {
      expect(() => parseIntegralPack(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // The tracker's padding and the letter's case do not change the guide.
    expect(parseIntegralPack(changed('delivered', (body) => { body.DatosEnvio.Tipo = ' p '; }), 'IPE-1234-P-1')).toMatchObject({ status: 'delivered' });
  });

  it('keeps a browser check, a moved route and a changed reply apart from a missing guide', async () => {
    await expect(lookup(answering(reply(CHECK, { headers: { 'Content-Type': 'text/html' } })))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(answering(reply(CHECK, { status: 403, headers: { 'Content-Type': 'text/html' } })))).rejects.toMatchObject({ kind: 'challenge' });
    for (const moved of [reply({ error: 'Not found' }, { status: 404 }), reply(MISSING_PAGE, { status: 404, headers: { 'Content-Type': 'text/html' } }),
      reply('', { status: 410 }), new Response(null, { status: 302, headers: { Location: 'https://www.integralpack.com.ar/' } })]) {
      await expect(lookup(answering(moved))).rejects.toMatchObject({ kind: 'transport' });
    }
    // The tracking page in place of the lookup is a changed route, not a missing guide.
    await expect(lookup(answering(reply('<html><title>Integral Pack - Seguimiento</title></html>', { headers: { 'Content-Type': 'text/html' } }))))
      .rejects.toMatchObject({ kind: 'schema' });
    for (const change of [
      (body: Reply) => { body.VentaEventos = 'none' as unknown as Row[]; },
      (body: Reply) => { body.VentaEventos[0]!.FechaYHora = '2026-05-08 18:25:44'; },
      (body: Reply) => { body.VentaEventos[0]!.FechaYHora = '2026-05-08T18:25:44-03:00'; },
      (body: Reply) => { body.VentaEventos[0]!.FechaYHora = '2026-02-30T18:25:44'; },
      (body: Reply) => { body.VentaEventos[0]!.FechaYHora = '2026-05-08T24:00:00'; },
      (body: Reply) => { body.VentaEventos[0]!.FechaYHora = null; },
      (body: Reply) => { body.VentaEventos[0]!.NombreEvento = 7; },
      (body: Reply) => { body.VentaEventos[0]!.LocalidadNombre = { nombre: 'PUEBLO' }; },
      (body: Reply) => { body.VentaEventos[1] = 'event' as unknown as Row; },
      (body: Reply) => { body.VentaEventos = Array.from({ length: 301 }, () => body.VentaEventos[0]!); },
      (body: Reply) => { body.EstadoActual = 'Entregada' as unknown as Row; },
      (body: Reply) => { body.EstadoActual.EstadoActualNombre = 4; },
      (body: Reply) => { delete (body as Partial<Reply>).DatosEnvio; },
      (body: Reply) => { body.DatosEnvio.Serie = '1234'; },
      (body: Reply) => { body.DatosEnvio.Numero = 1.5; },
      (body: Reply) => { body.DatosEnvio.Numero = -1; },
      (body: Reply) => { delete body.DatosEnvio.Tipo; },
      (body: Reply) => { body.DatosEnvio.Tipo = ['P']; },
    ]) {
      expect(() => parseIntegralPack(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of ['reply', null, 7, [fixture('delivered')], {}]) {
      expect(() => parseIntegralPack(body, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance'], [400, 'transport']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ Error: 'Synthetic failure' }, { status }));
      await expect(lookup(fetcher)).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known guide and the empty list, and asks nothing about a guide Integral Pack does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-12T11:40:05' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(MOVING)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('1234X00000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('takes a point of sale, a letter and a number, with or without the tracker’s padding and prefix, without a request otherwise', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12345P00000001', '1234P000000001', '1234X00000001', '1234PB00000001', 'P00000001', '1234P', '0000P00000001',
      '1234P00000000', 'IPE1234', 'XPE1234P00000001', `1234P${'1'.repeat(70)}`]) {
      await expect(lookup(fetcher, number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeIntegralPackGuide('1234-P-00000001')).toEqual({ pointOfSale: 1234, letter: 'P', number: 1, code: 'IPE-1234-P-00000001' });
    for (const typed of ['ipe-1234-p-00000001', 'IPE 1234 P 1', '1234 - P - 1', '1234P1', 'IPE-1234-P-00000001']) {
      expect(normalizeIntegralPackGuide(typed).code, typed).toBe('IPE-1234-P-00000001');
    }
    expect(normalizeIntegralPackGuide('1a1').code).toBe('IPE-0001-A-00000001');
    expect(normalizeIntegralPackGuide('9999C99999999').code).toBe('IPE-9999-C-99999999');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(fixture('delivered')));
    await expect(lookup(flaky)).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>();
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    await expect(lookup(answering(new Response(new Uint8Array(300_000))))).rejects.toThrow('unexpectedly large');
  });

  it('routes a guide the caller names Integral Pack’s to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: '1234-P-00000001', carrier: 'integral-pack' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'integral-pack', source: 'integral-pack', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === integralPackLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Integral Pack guides', () => {
  it('claims no guide layout, and reads the guide from the tracking page’s link', () => {
    for (const number of [DELIVERED, MOVING, 'IPE1234P00000001']) {
      expect(detectCarrierMatch(number).candidates ?? []).not.toContain('integral-pack');
      expect(recognitionAskedCarriers(number)).not.toContain('integral-pack');
    }
    for (const host of ['www.integralpack.com.ar', 'integralpack.com.ar']) {
      const link = `https://${host}/seguimiento?codigo=1234-P-00000001`;
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: '1234-P-00000001', carrier: 'integral-pack', source: 'link' });
    }
  });
});

type Entry = { wording: string; stage?: string };

describe('Integral Pack status vocabulary', () => {
  it('maps every wording recorded to its stage, and every event the adapter writes is recorded', () => {
    for (const entry of statuses.entries as Entry[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'integral-pack', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'unknown' });
    }
    const recorded = new Set((statuses.entries as Entry[]).map((entry) => normalizeStatusWording(entry.wording)));
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', MOVING]] as const) {
      for (const event of parseIntegralPack(fixture(name), number).events!) {
        expect(recorded.has(normalizeStatusWording(event.description!)), event.description).toBe(true);
      }
    }
    expect(integralPackStage('EN DESTINO')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(integralPackStage('Synthetic status')).toBeNull();
    expect(statusMapAnswer({ carrier: 'integral-pack', providerCode: null, description: 'Synthetic status' })).toEqual({ kind: 'unknown' });
  });
});
