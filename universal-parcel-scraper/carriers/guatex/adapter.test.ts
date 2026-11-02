import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GUATEX_API, GuatexTracker } from './adapter.js';
import { normalizeGuatexNumber, parseGuatex } from './parser.js';
import { guatexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'Z0000Z00001';
const IN_TRANSIT = 'Z0000Z00002';
const RETURNED = 'Z0000Z00003';
const UNKNOWN = 'Z0000Z00008';

type Row = Record<string, unknown>;
type Reply = Row & { informacionTracking: Row; tracking: Row[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(`${name}.json`)) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const answering = (body: unknown, init?: ResponseInit) => vi.fn<typeof fetch>(async () => reply(body, init));
const steps = (result: { events?: Row[] }) => result.events!.map((event) => [event.provider_code, event.stage]);
// The fixtures' routes, which the adapter does not read.
const ROUTES = /RUTA|LINEA|EJEMPLO|AAA-BBB/;

describe('Guatex HTTP adapter', () => {
  it('posts the guía as the tracker page does, through the supplied transport', async () => {
    const fetcher = answering(fixture('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GuatexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' z0000-z00001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(GUATEX_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'SyntheticHost/1.0', Origin: 'https://servicios.guatex.gt', Referer: 'https://servicios.guatex.gt/Guatex/RastreoTracking',
    } });
    expect(init.body).toBe(`noguia=${DELIVERED}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'guatex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered guía on Guatemala’s clock, with the courier’s delivery as the handover', () => {
    const result = parseGuatex(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Entregado en Agencia',
      // The agency's record is the newest row; the summary's clock is the courier's delivery.
      last_update: '2026-03-06T00:35:00Z', delivered_at: '2026-03-05T21:04:00Z', expected_delivery: null, timezone: 'America/Guatemala',
    });
    expect(result.events).toEqual([
      { time: '2026-03-06T00:35:00Z', description: 'Entregado en Agencia', stage: 'delivered', stage_source: 'carrier_map', provider_code: 'N' },
      { time: '2026-03-05T21:04:00Z', description: 'Entrega Móvil', stage: 'delivered', stage_source: 'carrier_map', provider_code: 'T' },
      { time: '2026-03-05T13:13:00Z', description: 'Egreso de Bodega', stage: 'out_for_delivery', stage_source: 'carrier_map', provider_code: 'E' },
      { time: '2026-03-02T20:04:00Z', description: 'Ingreso a Bodega', stage: 'in_transit', stage_source: 'carrier_map', provider_code: 'I' },
      { time: '2026-03-02T16:16:00Z', description: 'Egreso de Bodega', stage: 'in_transit', stage_source: 'carrier_map', provider_code: 'E' },
      { time: '2026-03-02T16:15:00Z', description: 'Ingreso a Bodega', stage: 'in_transit', stage_source: 'carrier_map', provider_code: 'I' },
      { time: '2026-03-02T15:10:00Z', description: 'Egreso de Agencia', stage: 'in_transit', stage_source: 'carrier_map', provider_code: 'G' },
      { time: '2026-03-02T14:14:00Z', description: 'Egreso de Bodega', stage: 'in_transit', stage_source: 'carrier_map', provider_code: 'E' },
      { time: '2026-03-02T14:10:00Z', description: 'Recolección Móvil', stage: 'accepted', stage_source: 'carrier_map', provider_code: 'R' },
    ]);
    expect(Object.keys(result).sort()).toEqual(['current_stage', 'current_stage_source', 'delivered_at', 'events', 'expected_delivery',
      'last_status_text', 'last_update', 'status', 'timezone']);
    expect(JSON.stringify(result)).not.toMatch(ROUTES);
  });

  it('keeps the courier’s delivery as the handover without the summary’s clock', () => {
    const result = parseGuatex(changed('delivered', (body) => { body.informacionTracking.hora = ''; }), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-05T21:04:00Z', last_update: '2026-03-06T00:35:00Z' });
    const agency = parseGuatex(changed('delivered', (body) => {
      body.tracking.splice(1, 1);
      body.informacionTracking.estado = 'Estado sintético';
    }), DELIVERED);
    // An agency delivery on its own is the delivery.
    expect(agency).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-06T00:35:00Z' });
    expect(agency.events![1]).toMatchObject({ provider_code: 'E', stage: 'in_transit' });
  });

  it('reads a guía between warehouses as in transit, whatever its summary says', () => {
    const result = parseGuatex(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Egreso de Bodega',
      last_update: '2026-04-07T12:30:00Z', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(steps(result)).toEqual([['E', 'in_transit'], ['I', 'in_transit'], ['G', 'in_transit'], ['R', 'accepted'], ['PR', 'registered']]);
    expect(JSON.stringify(result)).not.toMatch(/sintético|RUTA/);
  });

  it('reads failed attempts on their day, and a return under way and delivered back', () => {
    const result = parseGuatex(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Entrega Móvil Devolución', last_update: '2026-05-20T17:40:00Z' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(steps(result)).toEqual([['T', 'returned'], ['E', 'exception'], ['I', 'exception'], ['NE', 'exception'], ['NE', 'failed_attempt'],
      ['E', 'out_for_delivery'], ['I', 'in_transit'], ['R', 'accepted']]);
    expect(result.events![3]).toEqual({ local_time: '2026-05-15', description: 'Motivo sintético, DEVOLUCIÓN solicitada', stage: 'exception',
      stage_source: 'carrier_map', provider_code: 'NE' });
    // A summary that says received does not override a return.
    expect(parseGuatex(changed('returned', (body) => { body.tracking.shift(); body.informacionTracking.estado = 'ENTREGADO'; }), RETURNED))
      .toMatchObject({ current_stage: 'exception' });
    // A date-only newest row has no instant.
    const dated = parseGuatex(changed('returned', (body) => { body.tracking.splice(0, 3); }), RETURNED);
    expect(dated).toMatchObject({ current_stage: 'exception', last_update: null, last_update_local: '2026-05-15' });
  });

  it('takes the summary’s delivery when the rows lack it, and its status alone when there are no rows', () => {
    const lagging = parseGuatex(changed('delivered', (body) => { body.tracking.splice(0, 2); }), DELIVERED);
    expect(lagging).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADO', last_update: '2026-03-05T21:04:00Z', delivered_at: '2026-03-05T21:04:00Z' });
    expect(lagging.events![0]).toMatchObject({ provider_code: 'E', stage: 'in_transit' });
    for (const rows of [[], null]) {
      expect(parseGuatex(changed('delivered', (body) => { body.tracking = rows as never; }), DELIVERED)).toEqual({
        status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'ENTREGADO',
        last_update: '2026-03-05T21:04:00Z', expected_delivery: null, delivered_at: '2026-03-05T21:04:00Z', timezone: 'America/Guatemala',
        summary_only: true, events: [],
      });
      expect(() => parseGuatex(changed('in-transit', (body) => { body.tracking = rows as never; }), IN_TRANSIT))
        .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    }
  });

  it('leaves out the amount credited to the sender and repeated rows, and stages unnamed codes by their wording', () => {
    const result = parseGuatex(changed('delivered', (body) => {
      const [newest, oldest] = [body.tracking[0]!, body.tracking[8]!];
      body.tracking.push({ ...newest, pos: '0', hora: '19:00', estado: 'Acreditado', movimiento: 'Acreditado', descripcion: 'S' });
      body.tracking.push({ ...oldest, pos: '10' });
      body.tracking.push({ ...oldest, pos: '11', hora: '07:00', estado: 'Paquete en tránsito', movimiento: 'Paquete en tránsito', descripcion: 'X' });
      body.tracking.push({ ...oldest, pos: '12', hora: '06:00', estado: 'Sintético', movimiento: '', descripcion: 'Y' });
    }), DELIVERED);
    expect(result.events).toHaveLength(11);
    expect(result.events!.map((event) => event.description)).not.toContain('Acreditado');
    expect(result.events!.at(-2)).toEqual({ time: '2026-03-02T13:00:00Z', description: 'Paquete en tránsito', stage: 'in_transit',
      stage_source: 'wording:language', provider_code: 'X' });
    expect(result.events!.at(-1)).toEqual({ time: '2026-03-02T12:00:00Z', description: 'Sintético', provider_code: 'Y' });
    // Rows follow `pos`, newest first, whatever order the list has.
    const shuffled = parseGuatex(changed('delivered', (body) => { body.tracking.reverse(); }), DELIVERED);
    expect(shuffled.events).toEqual(parseGuatex(fixture('delivered'), DELIVERED).events);
    // A phone number in a wording is not kept.
    const reason = parseGuatex(changed('returned', (body) => { body.tracking[4]!.movimiento = 'Motivo sintético 5555-0000'; }), RETURNED);
    expect(reason.events![4]!.description).toBe('Motivo sintético');
  });

  it('reads only the lookup’s own answer for an unknown guía as not found', () => {
    expect(() => parseGuatex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const notFound = fixture('not-found');
    expect(() => parseGuatex({ ...notFound, codigo: 204 }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGuatex({ ...notFound, noguia: undefined }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // Any other code or answer is inconclusive, whatever the page makes of it.
    for (const body of [
      { ...notFound, respuesta: 'Servicio no disponible' },
      { ...notFound, codigo: '500', respuesta: 'Error interno' },
      { ...notFound, codigo: '400', respuesta: 'El número de guía no existe' },
      { ...notFound, codigo: '201', respuesta: 'Consulta exitosa' },
    ]) {
      expect(() => parseGuatex(body, UNKNOWN), String((body as Row).codigo)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('counts a guía only when every part of the reply names the one asked', () => {
    expect(() => parseGuatex(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Guatex answered for another guía' }));
    expect(() => parseGuatex(fixture('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const change of [
      (body: Reply) => { body.informacionTracking.noguia = IN_TRANSIT; },
      (body: Reply) => { body.tracking[3]!.noguia = IN_TRANSIT; },
      (body: Reply) => { body.tracking[3]!.noguia = `${DELIVERED}1`; },
    ]) {
      expect(() => parseGuatex(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseGuatex(changed('delivered', (body) => { body.noguia = ` ${DELIVERED.toLowerCase()} `; }), DELIVERED).events).toHaveLength(9);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.codigo; },
      (body: Reply) => { body.codigo = { value: '200' }; },
      (body: Reply) => { delete body.noguia; },
      (body: Reply) => { body.noguia = 1; },
      (body: Reply) => { body.informacionTracking = null as never; },
      (body: Reply) => { body.informacionTracking = 'ENTREGADO' as never; },
      (body: Reply) => { body.informacionTracking.estado = ['ENTREGADO']; },
      (body: Reply) => { body.informacionTracking.hora = '3 PM'; },
      (body: Reply) => { body.informacionTracking.fecha = '2026-03-05'; },
      (body: Reply) => { body.tracking = {} as never; },
      (body: Reply) => { body.tracking = Array.from({ length: 501 }, () => body.tracking[0]) as never; },
      (body: Reply) => { body.tracking[0] = 'Entregado' as never; },
      (body: Reply) => { body.tracking[0]!.fecha = '31/02/2026'; },
      (body: Reply) => { body.tracking[0]!.fecha = '5/3/2026'; },
      (body: Reply) => { body.tracking[0]!.hora = '24:00'; },
      (body: Reply) => { body.tracking[0]!.hora = '18:35:00'; },
      (body: Reply) => { body.tracking[0]!.fecha = 20260305; },
      (body: Reply) => { body.tracking[0]!.descripcion = 'Entregado'; },
      (body: Reply) => { body.tracking[0]!.descripcion = 1; },
      (body: Reply) => { body.tracking[0]!.pos = 'first'; },
      (body: Reply) => { body.tracking[0]!.movimiento = ''; body.tracking[0]!.estado = ''; },
      (body: Reply) => { body.tracking[0]!.movimiento = { text: 'Entregado' }; },
    ]) {
      expect(() => parseGuatex(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseGuatex('reply', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGuatex(null, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown guía, a moved route, a page, a rate limit and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(answering(body, init)).track({ number: UNKNOWN });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // A byte-order mark does not change the reply.
    await expect(lookup(`\uFEFF${text('not-found.json')}`)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('<html><title>404</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://servicios.guatex.gt/Guatex/' } })).rejects.toMatchObject({ kind: 'transport' });
    // A page in place of the reply is a challenge, even with HTTP 200.
    await expect(lookup('<!DOCTYPE html><html><head><title>Request Rejected</title></head></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('\n <html><body>Mantenimiento</body></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"noguia":', {})).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('System.NullReferenceException', { headers: { 'Content-Type': 'text/plain' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('Too Many Requests', { status: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '10' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>(async () => new Response('<html><body>blocked</body></html>', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('tries once more after a failure to reach Guatex, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GuatexTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'guatex', step: 'retry', outcome: 'ok' }));
  });

  it('sends no reply that came back once more', async () => {
    const fetcher = answering('{"noguia":', {});
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('recognizes a known guía and an unknown one, and asks nothing for a number its tracker does not take', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('delivered'))).mockResolvedValueOnce(reply(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('Z0000Z0000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers its tracker does not take and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['Z00', 'Z0000Z0000000001', 'Z0000_Z00001', 'Z0000Ñ00001', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGuatexNumber(' z0000-z00001 ')).toBe(DELIVERED);
  });

  it('tracks a guía filed under Guatex, and claims no number by its shape', async () => {
    const tracker = createTracker({ fetcher: answering(fixture('delivered')), providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'guatex' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'guatex', source: 'guatex', result: { current_stage: 'delivered' } });
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('guatex');
  });
});

describe('Guatex status vocabulary', () => {
  it('records every code with the stage the adapter gives it', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      if (!entry.code) continue;
      if (entry.code === 'E') {
        expect(statusMap.stage('E', entry.wording.toLowerCase())).toBeUndefined();
        expect(guatexStage('E', entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
        expect(guatexStage('E', entry.wording, 'T')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
        continue;
      }
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'guatex', providerCode: 'T', description: 'Entrega Móvil' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'guatex', providerCode: 'N', description: 'Entregado en Agencia' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'guatex', providerCode: 'T', description: 'Entrega Móvil Devolución' })).toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'guatex', providerCode: 'I', description: 'Ingreso a Bodega Devolución' })).toEqual({ kind: 'mapped', stage: 'exception' });
    expect(statusMapAnswer({ carrier: 'guatex', providerCode: 'NE', description: 'Motivo sintético' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    // A departure's stage depends on the next row, which the map does not see.
    expect(statusMapAnswer({ carrier: 'guatex', providerCode: 'E', description: 'Egreso de Bodega' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'guatex', providerCode: 'S', description: 'Acreditado' })).toEqual({ kind: 'intentional_gap', note: expect.any(String) });
  });
});
