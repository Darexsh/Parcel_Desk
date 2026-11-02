import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, COORDINADORA_API, CoordinadoraTracker } from './adapter.js';
import { normalizeCoordinadoraNumber, parseCoordinadora } from './parser.js';
import { coordinadoraStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '12300000011';
const IN_TRANSIT = '12300000022';
const UNKNOWN = '12300000033';
const SHORT = '12300000044';

type Row = Record<string, unknown>;
type Guide = Row & { estado: Row[]; novedad: Row[] };
type Reply = Row & { data: Guide[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (guide: Guide, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Coordinadora HTTP adapter', () => {
  it('posts the whole guide number to the tracker’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CoordinadoraTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 123 0000 0022 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(COORDINADORA_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ guias: [IN_TRANSIT] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'coordinadora', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery in Bogotá’s time with its incidents, a receipt dated without a clock and a repeated visit once', () => {
    const result = parseCoordinadora(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADA', last_update: '2026-05-08T16:42:05-05:00', expected_delivery: null,
      delivered_at: '2026-05-08T16:42:05-05:00' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.description, event.stage ?? null]))
      .toEqual([
        ['2026-05-08T16:42:05-05:00', '6', 'ENTREGADA', 'delivered'],
        ['2026-05-08T09:15:31-05:00', '5', 'EN REPARTO', 'out_for_delivery'],
        ['2026-05-07T15:07:44-05:00', '701', 'Se visita, no se logra entrega', 'failed_attempt'],
        // A route delay moves nothing.
        ['2026-05-06T07:31:02-05:00', '500', 'Novedad en ruta nacional por infraestructura', null],
        ['2026-05-06T05:02:47-05:00', '4', 'EN TERMINAL DESTINO', 'in_transit'],
        ['2026-05-05T22:38:10-05:00', '3', 'EN TRANSPORTE', 'in_transit'],
        ['2026-05-05T14:20:56-05:00', '2', 'EN TERMINAL ORIGEN', 'accepted'],
        ['2026-05-05', '1', 'A RECIBIR POR COORDINADORA', 'registered'],
      ]);
    expect(result.events!.at(-1)).not.toHaveProperty('time');
    // Towns, the pickup point and the complaints stay out.
    expect(JSON.stringify(result)).not.toMatch(/MUESTRA|EJEMPLO|droop|reporte|solucion/i);
  });

  it('keeps the last state’s stage under a delay notice and drops a state without a date', () => {
    const result = parseCoordinadora(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Afectación del tiempo de entrega, guía continuará en el proceso de distribución',
      last_update: '2026-06-03T17:25:08-05:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null])).toEqual([
      ['733', null], ['4', 'in_transit'], ['3', 'in_transit'], ['734', 'exception'], ['2', 'accepted'],
    ]);
  });

  it('reads a closed guide as an exception, and a delivery over an incident reported after it', () => {
    const closed = parseCoordinadora(changed('in-transit', (guide) => {
      guide.estado.unshift({ hora: '08:00:00', fecha: '2026-06-09', codigo: '8', descripcion: 'CERRADO POR INCIDENCIA, VER CAUSA', internacional: false });
    }), IN_TRANSIT);
    expect(closed).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'CERRADO POR INCIDENCIA, VER CAUSA' });
    const late = parseCoordinadora(changed('delivered', (guide) => {
      guide.novedad.unshift({ hora: '10:00:00', fecha: '2026-05-09', codigo: '699', descripcion: 'Dirección incompleta' });
    }), DELIVERED);
    expect(late).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'ENTREGADA',
      last_update: '2026-05-09T10:00:00-05:00', delivered_at: '2026-05-08T16:42:05-05:00' });
    expect(late.events![0]).toMatchObject({ provider_code: '699', stage: 'exception' });
  });

  it('keeps the wall clock of a state marked international', () => {
    const result = parseCoordinadora(changed('in-transit', (guide) => {
      guide.estado[0]!.internacional = true;
    }), IN_TRANSIT);
    expect(result.events![1]).toEqual({ local_time: '2026-06-03T06:12:19', description: 'EN TERMINAL DESTINO', provider_code: '4',
      stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('reads the short record of an old guide, which does not name it, and an undated state alone as a bare summary', () => {
    expect(parseCoordinadora(fixture('short'), SHORT)).toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', last_status_text: 'A RECIBIR POR COORDINADORA', last_update: null,
      last_update_local: '2025-09-14', expected_delivery: null,
      events: [{ local_time: '2025-09-14', description: 'A RECIBIR POR COORDINADORA', provider_code: '1', stage: 'registered', stage_source: 'carrier_map' }] });
    const undated = changed('short', (guide) => {
      guide.estado[0]!.fecha = null;
    });
    expect(parseCoordinadora(undated, SHORT)).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'A RECIBIR POR COORDINADORA', provider_code: '1', last_update: null, expected_delivery: null, summary_only: true, events: [] });
  });

  it('reads the unknown-guide state as not found, a failed lookup as inconclusive and another guide as inconclusive', () => {
    expect(() => parseCoordinadora(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCoordinadora({ isError: true, message: 'Error interno', code: 'INTERNAL_ERROR' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCoordinadora(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Coordinadora answered for another guide' }));
    // A guide number that only shares the start of the one asked is another guide.
    expect(() => parseCoordinadora(changed('delivered', (guide) => { guide.codigo_remision = `${DELIVERED}0`; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseCoordinadora(changed('delivered', (guide) => { guide.codigo_remision = Number(DELIVERED); }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed reply', () => {
    for (const [index, body] of [
      null,
      [],
      { data: fixture('delivered').data },
      fixture('bad-message'),
      changed('delivered', (_guide, reply) => { reply.data = []; }),
      changed('delivered', (guide, reply) => { reply.data = [guide, guide]; }),
      changed('delivered', (_guide, reply) => { reply.data = {} as never; }),
      changed('delivered', (guide) => { guide.estado = []; }),
      changed('delivered', (guide) => { guide.estado = {} as never; }),
      changed('delivered', (guide) => { guide.novedad = 'none' as never; }),
      changed('delivered', (guide) => { guide.codigo_remision = { guia: DELIVERED }; }),
      changed('delivered', (guide) => { guide.codigo_remision = ''; }),
      changed('not-found', (guide) => { guide.estado.push({ hora: null, fecha: '2026-01-01', codigo: '1', descripcion: 'A RECIBIR POR COORDINADORA' }); }),
      changed('delivered', (guide) => { guide.estado[0]!.codigo = null; }),
      changed('delivered', (guide) => { guide.estado[0]!.codigo = { codigo: '6' }; }),
      changed('delivered', (guide) => { guide.estado[0]!.descripcion = ' '; }),
      changed('delivered', (guide) => { guide.estado[0]!.descripcion = ['ENTREGADA']; }),
      changed('delivered', (guide) => { guide.estado[0]!.internacional = 'no'; }),
      changed('delivered', (guide) => { guide.estado[0]!.fecha = '08/05/2026'; }),
      changed('delivered', (guide) => { guide.estado[0]!.fecha = '2026-02-30'; }),
      changed('delivered', (guide) => { guide.estado[0]!.fecha = null; }),
      changed('delivered', (guide) => { guide.estado[0]!.hora = '24:00:00'; }),
      changed('delivered', (guide) => { guide.estado[0]!.hora = '16:42'; }),
      changed('delivered', (guide) => { guide.estado[0]!.hora = 1642; }),
      changed('delivered', (guide) => { guide.novedad[0]!.hora = '15:07:44.'; }),
      changed('delivered', (guide) => { guide.novedad.push(...Array.from({ length: 300 }, (_, minute) => ({ ...guide.novedad[2]!, hora: `07:${String(minute % 60).padStart(2, '0')}:00` }))); }),
    ].entries()) {
      expect(() => parseCoordinadora(body, DELIVERED), `change ${index}`).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown guide, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // The service answers an unknown guide with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.coordinadora.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Rastrear guía ~ Coordinadora</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(fixture('bad-message'))).rejects.toMatchObject({ kind: 'schema' });
    // The service's own failure, as it answers a request it cannot read.
    await expect(lookup({ isError: true, message: 'Syntax error', code: 'SYNTAX_ERROR', statusCode: 500 }, { status: 500 }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a dated guide, and neither the unknown-guide state, an undated guide nor a number Coordinadora does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered')))
      .mockResolvedValueOnce(reply(fixture('not-found')))
      .mockResolvedValueOnce(reply(changed('short', (guide) => { guide.estado[0]!.fecha = null; })));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-05-08T21:42:05.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(SHORT)).resolves.toEqual({ known: false, lastActivityAt: null });
    await expect(carrier(fetcher).recognize!('1230000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Coordinadora does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1230000001', '123000000111', 'AB123456789CO', '12300000O11', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeCoordinadoraNumber(' 123-0000-0011 ')).toBe(DELIVERED);
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

  it('routes a number filed under Coordinadora to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'coordinadora' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'coordinadora', source: 'coordinadora', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === COORDINADORA_API)).toBe(true);
  });
});

describe('Coordinadora numbers', () => {
  it('suggests eleven digits and is asked about them only for a lookup in Colombia', () => {
    const number = '12345678901';
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(number).candidates).toContain('coordinadora');
    expect(recognitionAskedCarriers(number, { countryHint: 'CO' })[0]).toBe('coordinadora');
    for (const countryHint of [undefined, 'DE', 'FR', 'BE', 'IT', 'US', 'EC']) {
      expect(recognitionAskedCarriers(number, { countryHint }), `${countryHint}`).not.toContain('coordinadora');
    }
    expect(recognitionAskedCarriers(number, { countryHint: 'DE' })[0]).toBe('gls-de');
    for (const other of ['1234567890', '123456789012', 'A1234567890']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('coordinadora');
    }
  });
});

describe('Coordinadora status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        if (entry.code !== '0') expect(coordinadoraStage(entry.code, entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'coordinadora', providerCode: entry.code, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(coordinadoraStage(entry.code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'coordinadora', providerCode: '701', description: 'Se visita, no se logra entrega' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'coordinadora', providerCode: '999', description: 'Novedad sintética' })).toEqual({ kind: 'unknown' });
    // A code the map does not know falls to the shared wording rules.
    expect(coordinadoraStage('998', 'ENTREGADO')).toMatchObject({ stage: 'delivered', source: expect.stringMatching(/^wording:/) });
    expect(coordinadoraStage('999', 'Novedad sintética')).toBeNull();
  });
});
