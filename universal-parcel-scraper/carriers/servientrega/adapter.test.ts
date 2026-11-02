import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SERVIENTREGA_API, ServientregaTracker } from './adapter.js';
import { normalizeServientregaNumber, parseServientrega } from './parser.js';
import { servientregaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '9100000011';
const IN_TRANSIT = '9100000022';
const UNKNOWN = '9100000033';
const RETURNED = '9100000044';

type Row = Record<string, unknown>;
type Guide = Row & { movimientos: Row[] };
type Reply = Row & { Results: Guide[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (guide: Guide, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.Results[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Servientrega HTTP adapter', () => {
  it('posts the whole guide number to the tracker’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ServientregaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 910-000-0022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SERVIENTREGA_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ numeroGuia: IN_TRANSIT, idValidacionUsuario: '0', tipoDatoValidar: '0',
      datoRespuestaUsuario: '0', idpais: 1, lenguaje: 'es' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'servientrega', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery in Bogotá’s time, with the courier’s report as its time and a repeated movement once', () => {
    const result = parseServientrega(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entrega verificada', last_update: '2026-03-05T17:30:00-05:00', expected_delivery: null,
      delivered_at: '2026-03-05T14:42:00-05:00', service_name: 'Mercancia premier' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.description, event.location, event.stage ?? null]))
      .toEqual([
        // A movement logged after the delivery does not undo it.
        ['2026-03-05T17:30:00-05:00', '32', 'Envio para entrega a domicilio', 'San Muestra (Valle)', 'out_for_delivery'],
        ['2026-03-05T14:44:00-05:00', '11', 'Entrega verificada', 'San Muestra (Valle)', 'delivered'],
        ['2026-03-05T14:42:00-05:00', '24', 'Reportado entregado', 'San Muestra (Valle)', 'delivered'],
        ['2026-03-05T07:58:00-05:00', '9', 'En zona de distribucion', 'San Muestra (Valle)', 'out_for_delivery'],
        ['2026-03-04T03:12:00-05:00', '14', 'Ingreso al centro logistico', 'San Muestra (Valle)', 'in_transit'],
        ['2026-03-02T21:30:00-05:00', '12', 'Salio a ciudad destino', 'Villa Ejemplo (Antioquia)', 'in_transit'],
        ['2026-03-02T18:05:00-05:00', '6', 'Ingreso al centro logistico', 'Villa Ejemplo (Antioquia)', 'accepted'],
        ['2026-03-02T11:40:00-05:00', '2', 'Admision del envio en cds', 'Villa Ejemplo (Antioquia)', 'accepted'],
        ['2026-03-02T09:15:00-05:00', '1', 'Guia generada', 'Villa Ejemplo (Antioquia)', 'registered'],
      ]);
    // Names, addresses, contacts, the picture, the signatory, the courier and internal concepts stay out.
    expect(JSON.stringify(result)).not.toMatch(/MUESTRA SAS|DESTINATARIA|FALSA|example\.com|300000000|iVBOR|FIRMANTE|MENSAJERO|SALIDA A ZONA|ARTICULO/);
  });

  it('reads a guide on its way back as in transit, with the incidents in its wording', () => {
    const result = parseServientrega(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Ingreso al centro logistico', last_update: '2026-04-15T05:41:00-05:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.description, event.stage ?? null])).toEqual([
      ['14', 'Ingreso al centro logistico', 'in_transit'],
      ['12', 'Salio a ciudad destino', 'in_transit'],
      ['10', 'Ingreso al centro logistico por devolucion (DIRECCION ERRADA)', 'failed_attempt'],
      ['25', 'Notificacion de devolucion (DIRECCION ERRADA)', 'exception'],
      ['9', 'En zona de distribucion', 'out_for_delivery'],
      ['14', 'Ingreso al centro logistico', 'in_transit'],
      ['12', 'Salio a ciudad destino', 'in_transit'],
      ['6', 'Ingreso al centro logistico', 'accepted'],
      ['4', 'Alistamiento cds para entregar a recolecciones', 'accepted'],
      ['2', 'Admision del envio en cds', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/ASESOR|DIVISION|Respondida/);
  });

  it('reads a guide delivered back to its sender as returned, without a delivery time', () => {
    const result = parseServientrega(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Entrega verificada', last_update: '2026-05-12T11:37:00-05:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.time, event.description, event.stage ?? null]).slice(0, 7)).toEqual([
      ['2026-05-12T11:37:00-05:00', 'Entrega verificada', 'returned'],
      ['2026-05-12T08:53:00-05:00', 'En zona de distribucion', 'out_for_delivery'],
      ['2026-05-11T22:00:00-05:00', 'Ingreso al centro logistico', 'in_transit'],
      ['2026-05-08T02:42:00-05:00', 'Salio a ciudad destino', 'in_transit'],
      // Two reasons logged at once both stay, the later of the reply first.
      ['2026-05-06T23:00:00-05:00', 'Ingreso al centro logistico por devolucion (OTROS)', 'failed_attempt'],
      ['2026-05-06T23:00:00-05:00', 'Ingreso al centro logistico por devolucion (NO RESIDE)', 'failed_attempt'],
      ['2026-05-04T07:30:00-05:00', 'En zona de distribucion', 'out_for_delivery'],
    ]);
    expect(result.events!.at(-2)).toMatchObject({ provider_code: '3', stage: 'registered', location: 'Cerro Ejemplo (Antioquia)' });
  });

  it('takes the delivered state over the movements, and keeps the wall clocks of a guide that crosses a border', () => {
    const late = parseServientrega(changed('delivered', (guide) => {
      guide.movimientos = guide.movimientos.filter((row) => !['11', '24'].includes(String(row.IdProceso)));
      guide.fechaRealEntrega = '';
    }), DELIVERED);
    expect(late).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADO' });
    expect(late).not.toHaveProperty('delivered_at');
    const abroad = parseServientrega(changed('delivered', (guide) => { guide.IdPaisDestino = 2; }), DELIVERED);
    expect(abroad).toMatchObject({ last_update: null, last_update_local: '2026-03-05T17:30', current_stage: 'delivered' });
    expect(abroad).not.toHaveProperty('delivered_at');
    expect(abroad.events![1]).toEqual({ local_time: '2026-03-05T14:44', description: 'Entrega verificada', location: 'San Muestra (Valle)',
      provider_code: '11', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads a guide without movements as a summary of its state', () => {
    expect(parseServientrega(changed('in-transit', (guide) => { guide.movimientos = null as never; }), IN_TRANSIT)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'EN PROCESAMIENTO',
      last_update: null, expected_delivery: null, service_name: 'Mercancia premier', summary_only: true, events: [] });
    expect(parseServientrega(changed('in-transit', (guide) => { guide.movimientos = []; guide.estadoActual = 'EN BODEGA'; }), IN_TRANSIT))
      .toMatchObject({ status: 'unknown', last_status_text: 'EN BODEGA', summary_only: true });
  });

  it('reads the empty result as not found, another guide as inconclusive and a verification step as a challenge', () => {
    expect(() => parseServientrega(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseServientrega(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Servientrega answered for another guide' }));
    // A guide number that only shares the start of the one asked is another guide.
    expect(() => parseServientrega(changed('delivered', (guide) => { guide.numeroGuia = `${DELIVERED}0`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseServientrega(changed('delivered', (guide) => { guide.numeroGuia = Number(DELIVERED); }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
    // The service reads the number as a decimal: leading zeros name the same guide.
    expect(parseServientrega(fixture('delivered'), `0${DELIVERED}`)).toMatchObject({ current_stage: 'delivered' });
    for (const step of [1, 2, 3]) {
      expect(() => parseServientrega({ ValidationNumber: step, ValidationResponse: 1, Code: 1, message: null, Results: [] }, DELIVERED), `step ${step}`)
        .toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('rejects a changed reply', () => {
    for (const [index, body] of [
      null,
      [],
      { Results: fixture('delivered').Results },
      changed('delivered', (_guide, reply) => { reply.ValidationNumber = 5; }),
      changed('delivered', (_guide, reply) => { reply.Code = 0; }),
      changed('delivered', (_guide, reply) => { reply.Results = []; }),
      changed('delivered', (guide, reply) => { reply.Results = [guide, guide]; }),
      changed('delivered', (_guide, reply) => { reply.Results = {} as never; }),
      changed('delivered', (_guide, reply) => { reply.Results = ['9100000011' as never]; }),
      changed('delivered', (guide) => { guide.numeroGuia = ''; }),
      changed('delivered', (guide) => { guide.numeroGuia = { guia: DELIVERED }; }),
      changed('delivered', (guide) => { guide.estadoActual = 4; }),
      changed('delivered', (guide) => { guide.movimientos = {} as never; }),
      changed('delivered', (guide) => { guide.movimientos = []; guide.estadoActual = ''; }),
      changed('delivered', (guide) => { guide.movimientos[0] = 'Guia generada' as never; }),
      changed('delivered', (guide) => { guide.movimientos[0]!.IdProceso = ''; }),
      changed('delivered', (guide) => { guide.movimientos[0]!.IdProceso = 'X1'; }),
      changed('delivered', (guide) => { guide.movimientos[0]!.movimiento = ' '; }),
      changed('delivered', (guide) => { guide.movimientos[0]!.Novedad = ['OTROS']; }),
      changed('delivered', (guide) => { guide.movimientos[0]!.fecha = '2026-03-02 09:15'; }),
      changed('delivered', (guide) => { guide.movimientos[0]!.fecha = '30/02/2026 09:15'; }),
      changed('delivered', (guide) => { guide.movimientos[0]!.fecha = '02/03/2026 24:00'; }),
      changed('delivered', (guide) => { guide.movimientos[0]!.fecha = '02/03/2026'; }),
      changed('delivered', (guide) => { guide.movimientos[0]!.fecha = null; }),
      changed('delivered', (guide) => { guide.fechaRealEntrega = '05/03/2026'; }),
      changed('delivered', (guide) => { guide.IdPaisOrigen = '1'; }),
      changed('delivered', (guide) => { guide.movimientos.push(...Array.from({ length: 300 }, () => guide.movimientos[0]!)); }),
    ].entries()) {
      expect(() => parseServientrega(body, DELIVERED), `change ${index}`).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown guide, a moved route, a refused request, a firewall page and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The gateway answers an unknown route with 404; the service answers an unknown guide with HTTP 200.
    await expect(lookup({ statusCode: 404, message: 'Resource not found' }, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.servientrega.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ title: 'One or more validation errors occurred.', status: 400, errors: { lenguaje: ['The lenguaje field is required.'] } },
      { status: 400 })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Web Application Firewall</title></head><body>This transfer is blocked.</body></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Servientrega</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a guide with movements, and neither an unknown guide nor a number Servientrega does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-05T22:30:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('91000000111')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Servientrega does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['91000001', '91000000111', '0091000001', 'AB123456789CO', '91000000O1', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeServientregaNumber(' 910-000-0011 ')).toBe(DELIVERED);
    expect(normalizeServientregaNumber('0910000005')).toBe('910000005');
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 60 })).rejects.toThrow());
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a number filed under Servientrega to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'servientrega' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'servientrega', source: 'servientrega', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === SERVIENTREGA_API)).toBe(true);
  });
});

describe('Servientrega status vocabulary', () => {
  it('records every code and state the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string; confirmedBy: string }[]) {
      // A merchant guide's names for the states are not the tracker's wording.
      if (entry.confirmedBy === 'source') continue;
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      if (entry.code) expect(servientregaStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'servientrega', providerCode: '10', description: 'Ingreso al centro logistico por devolucion (NO RESIDE)' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'servientrega', providerCode: '99', description: 'Movimiento sintético' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(servientregaStage('98', 'ENTREGADO')).toMatchObject({ stage: 'delivered', source: expect.stringMatching(/^wording:/) });
    expect(servientregaStage('99', 'Movimiento sintético')).toBeNull();
  });
});
