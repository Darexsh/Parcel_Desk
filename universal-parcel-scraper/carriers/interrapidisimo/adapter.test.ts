import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import {
  adapter, INTERRAPIDISIMO_MILESTONES, INTERRAPIDISIMO_SEARCH, INTERRAPIDISIMO_SUMMARY, InterrapidisimoTracker,
} from './adapter.js';
import { interrapidisimoSession, normalizeInterrapidisimoNumber, parseInterrapidisimo } from './parser.js';
import { interrapidisimoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = '700000000017';
const IN_TRANSIT = '3000000000020';
const UNKNOWN = '700000000000';
const SESSION = '00000000-0000-4000-8000-000000000001';

type Row = Record<string, unknown>;
type Reply = Row & { resultado: Row };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(`${name}.json`)) as Reply;
const changed = (name: string, change: (result: Row, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.resultado, reply);
  return reply;
};
const guideOf = (reply: Reply) => (reply.resultado.guias as Row[])[0]!;
const rowsOf = (reply: Reply) => reply.resultado.tracking as Row[];
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

/** A gateway that answers each of the tracker's three requests. */
function gateway(replies: { search?: Response; summary?: Response; milestones?: Response } = {}, name = 'delivered') {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.startsWith(INTERRAPIDISIMO_SEARCH)) return replies.search ?? reply(fixture('search'));
    if (url.startsWith(INTERRAPIDISIMO_SUMMARY)) return replies.summary ?? reply(fixture(`${name}-summary`));
    if (url.startsWith(INTERRAPIDISIMO_MILESTONES)) return replies.milestones ?? reply(fixture(`${name}-milestones`));
    throw new Error(`unexpected request ${url}`);
  });
}

describe('Inter Rapidísimo HTTP adapter', () => {
  it('searches the whole guide, then reads its summary and milestones under the search’s session, through the supplied transport', async () => {
    const fetcher = gateway({}, 'in-transit');
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new InterrapidisimoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 3000 0000 00020 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [search, summary, milestones] = fetcher.mock.calls;
    expect(String(search![0])).toBe(`${INTERRAPIDISIMO_SEARCH}?NumerosGuias=${IN_TRANSIT}&altchaPayload=`);
    expect(search![1]).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(summary![0])).toBe(INTERRAPIDISIMO_SUMMARY);
    expect(summary![1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(summary![1]!.body))).toEqual({ idConsulta: SESSION });
    expect(String(milestones![0])).toBe(`${INTERRAPIDISIMO_MILESTONES}?numeroGuia=${IN_TRANSIT}`);
    expect(milestones![1]).toMatchObject({ method: 'GET', headers: { Authorization: SESSION, idaplicacion: '39', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'interrapidisimo', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the milestones on Colombia’s clock, newest first, and places the warehouse ones', () => {
    const result = parseInterrapidisimo(fixture('delivered-summary'), fixture('delivered-milestones'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregamos tu envío', last_update: '2026-03-04T11:52:40-05:00', delivered_at: '2026-03-04T11:52:40-05:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.description, event.stage, event.location ?? null])).toEqual([
      ['2026-03-04T11:52:40-05:00', 'Entregamos tu envío', 'delivered', null],
      ['2026-03-04T08:15:09-05:00', 'En reparto', 'out_for_delivery', null],
      ['2026-03-04T06:20:33-05:00', 'En bodega de destino', 'in_transit', 'PUERTO EJEMPLO, DEPARTAMENTO DOS'],
      ['2026-03-03T18:02:27-05:00', 'Esperando tu acción', 'exception', null],
      ['2026-03-03T16:45:10-05:00', '1a entrega fallida', 'failed_attempt', null],
      ['2026-03-03T08:30:00-05:00', 'En reparto', 'out_for_delivery', null],
      ['2026-03-03T05:12:48-05:00', 'En bodega de destino', 'in_transit', 'PUERTO EJEMPLO, DEPARTAMENTO DOS'],
      ['2026-03-02T22:05:31-05:00', 'Viajando al destino', 'in_transit', null],
      ['2026-03-02T19:40:12-05:00', 'En bodega de origen', 'in_transit', 'VILLA MUESTRA, DEPARTAMENTO UNO'],
      ['2026-03-02T09:14:05-05:00', 'Recibimos tu envío', 'accepted', null],
    ]);
    // Warehouse addresses, the delivery window and the next milestone are not kept.
    expect(JSON.stringify(result)).not.toMatch(/CALLE|CARRERA|8 a\.m|Entrega Estimada|#B37700/);
  });

  it('keeps an estimate until the journey ends and milestones that share a clock, in the order of their steps', () => {
    const result = parseInterrapidisimo(fixture('in-transit-summary'), changed('in-transit-milestones', (body) => {
      (body.tracking as Row[]).reverse();
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Viajando al destino',
      last_update: '2026-05-11T21:30:00-05:00', expected_delivery: '2026-05-14' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map((event) => event.description)).toEqual(
      ['Viajando al destino', 'En bodega de origen', 'Viajando al destino', 'Recibimos tu envío']);
    // An estimate already behind the newest milestone is stale.
    const stale = parseInterrapidisimo(changed('in-transit-summary', (body) => {
      guideOf({ resultado: body }).fechaEstimadaEntrega = '2026-05-10T18:00:00';
    }), fixture('in-transit-milestones'), IN_TRANSIT);
    expect(stale.expected_delivery).toBeNull();
  });

  it('reads a guide waiting at an office, a return and a milestone the map does not know', () => {
    const waiting = parseInterrapidisimo(fixture('in-transit-summary'), changed('in-transit-milestones', (body) => {
      (body.tracking as Row[]).push({ etapa: 5, nombreEtapa: 'Recoge en oficina', fechaEtapa: '05/12/2026 10:00:00' });
    }), IN_TRANSIT);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', expected_delivery: '2026-05-14' });
    const returned = parseInterrapidisimo(fixture('delivered-summary'), changed('delivered-milestones', (body) => {
      Object.assign((body.tracking as Row[]).at(-1)!, { nombreEtapa: 'Devuelto al remitente' });
    }), DELIVERED);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null });
    expect(returned).not.toHaveProperty('delivered_at');
    const second = parseInterrapidisimo(fixture('delivered-summary'), changed('delivered-milestones', (body) => {
      Object.assign((body.tracking as Row[]).at(-1)!, { nombreEtapa: '2a entrega fallida' });
    }), DELIVERED);
    expect(second).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: 'carrier_map' });
    const unknown = parseInterrapidisimo(fixture('delivered-summary'), changed('delivered-milestones', (body) => {
      Object.assign((body.tracking as Row[]).at(-1)!, { nombreEtapa: 'Paso sintético' });
    }), DELIVERED);
    expect(unknown).toMatchObject({ last_status_text: 'Paso sintético', current_stage: 'out_for_delivery' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
  });

  it('reads a guide made ahead of handover as not started, and a guide without milestones as no history', () => {
    const missing = fixture('milestones-not-found');
    const ahead = changed('delivered-summary', (body) => { guideOf({ resultado: body }).preenvio = true; });
    expect(parseInterrapidisimo(ahead, missing, DELIVERED)).toEqual({ status: 'pending', current_stage: 'registered',
      current_stage_source: 'carrier_map', last_status_text: 'Por iniciar', last_update: null, expected_delivery: null, summary_only: true,
      events: [] });
    expect(() => parseInterrapidisimo(fixture('delivered-summary'), missing, DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const empty = changed('delivered-milestones', (body) => { body.tracking = []; });
    expect(() => parseInterrapidisimo(fixture('delivered-summary'), empty, DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // A milestone without a date is one still to come.
    const undated = changed('delivered-milestones', (body) => { (body.tracking as Row[]).forEach((row) => { row.fechaEtapa = ''; }); });
    expect(() => parseInterrapidisimo(fixture('delivered-summary'), undated, DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a summary only when it names the guide asked', () => {
    expect(() => parseInterrapidisimo(fixture('in-transit-summary'), fixture('in-transit-milestones'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Inter Rapidísimo answered for another guide' }));
    const empty = changed('delivered-summary', (body) => { body.guias = []; });
    expect(() => parseInterrapidisimo(empty, fixture('delivered-milestones'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const numeric = changed('delivered-summary', (body) => { guideOf({ resultado: body }).numeroGuia = Number(DELIVERED); });
    expect(parseInterrapidisimo(numeric, fixture('delivered-milestones'), DELIVERED).events).toHaveLength(10);
  });

  it('reads the search’s session, its missing guide and its refusals', () => {
    expect(interrapidisimoSession(fixture('search'))).toBe(SESSION);
    expect(() => interrapidisimoSession(fixture('search-not-found'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const answer = (mensaje: string, ok = false) => ({ operacionExitosa: ok, mensaje, errores: null, resultado: null, statusCode: 400 });
    expect(() => interrapidisimoSession(answer('STE033'))).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => interrapidisimoSession(answer('STE023'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => interrapidisimoSession(answer('STE010'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => interrapidisimoSession(answer('STE002', true))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => interrapidisimoSession({ Message: 'An error has occurred.' })).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed reply', () => {
    for (const [summary, milestones] of [
      [changed('delivered-summary', (_body, whole) => { delete (whole as Row).operacionExitosa; }), fixture('delivered-milestones')],
      [changed('delivered-summary', (body) => { body.guias = 'guides'; }), fixture('delivered-milestones')],
      [changed('delivered-summary', (body) => { delete guideOf({ resultado: body }).numeroGuia; }), fixture('delivered-milestones')],
      [changed('delivered-summary', (body) => { delete guideOf({ resultado: body }).preenvio; }), fixture('delivered-milestones')],
      [fixture('delivered-summary'), changed('delivered-milestones', (body) => { body.tracking = 'milestones'; })],
      [fixture('delivered-summary'), changed('delivered-milestones', (_body, whole) => { whole.mensaje = 'STE999'; })],
      [fixture('delivered-summary'), changed('delivered-milestones', (body) => { body.tracking = Array.from({ length: 201 }, () => rowsOf({ resultado: body })[0]); })],
      [fixture('delivered-summary'), changed('delivered-milestones', (body) => { (body.tracking as Row[])[0] = 'milestone' as never; })],
      [fixture('delivered-summary'), changed('delivered-milestones', (body) => { delete (body.tracking as Row[])[0]!.etapa; })],
      [fixture('delivered-summary'), changed('delivered-milestones', (body) => { (body.tracking as Row[])[0]!.nombreEtapa = ''; })],
      [fixture('delivered-summary'), changed('delivered-milestones', (body) => { (body.tracking as Row[])[0]!.nombreEtapa = ['Recibimos']; })],
      [fixture('delivered-summary'), changed('delivered-milestones', (body) => { (body.tracking as Row[])[0]!.fechaEtapa = '2026-03-02 09:14:05'; })],
      [fixture('delivered-summary'), changed('delivered-milestones', (body) => { (body.tracking as Row[])[0]!.fechaEtapa = '02/30/2026 09:14:05'; })],
      [fixture('delivered-summary'), changed('delivered-milestones', (body) => { (body.tracking as Row[])[0]!.fechaEtapa = '03/02/2026 24:00:00'; })],
    ] as const) {
      expect(() => parseInterrapidisimo(summary, milestones, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown guide, a moved route, a block page, a refused session and a broken reply apart', async () => {
    const lookup = (replies: Parameters<typeof gateway>[0]) => carrier(gateway(replies)).track({ number: DELIVERED });
    await expect(lookup({ search: reply(fixture('search-not-found'), { status: 404 }) })).rejects.toMatchObject({ kind: 'not_found' });
    // A 404 without the service's answer, or a redirect, is a moved route.
    await expect(lookup({ search: reply({ message: 'no Route matched with those values' }, { status: 404 }) })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ search: reply('', { status: 404, headers: { 'Content-Type': 'text/html' } }) })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ search: reply('', { status: 302, headers: { Location: 'https://interrapidisimo.com/' } }) })).rejects.toMatchObject({ kind: 'transport' });
    // Akamai's block page, with HTTP 403 or 200.
    for (const status of [403, 200]) {
      await expect(lookup({ search: reply(text('blocked.html'), { status, headers: { 'Content-Type': 'text/html' } }) }))
        .rejects.toMatchObject({ kind: 'challenge' });
    }
    await expect(lookup({ milestones: reply(text('blocked.html'), { status: 403, headers: { 'Content-Type': 'text/html' } }) }))
      .rejects.toMatchObject({ kind: 'challenge' });
    // The milestones service turning the session down is no missing guide.
    // The service writes its refusals' fields with capitals.
    await expect(lookup({ milestones: reply({ OperacionExitosa: false, Mensaje: 'STE237', Errores: null, Resultado: null, StatusCode: 401 },
      { status: 401 }) })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ milestones: reply({ operacionExitosa: false, mensaje: 'STE237', resultado: null, statusCode: 401 }, { status: 401 }) }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ summary: reply({ operacionExitosa: false, mensaje: 'STE024', resultado: { guias: [] }, statusCode: 404 }, { status: 404 }) }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup({ summary: reply('<html><title>Inter Rapidísimo</title></html>') })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known guide and the unknown-guide answer, and asks nothing for a number Inter Rapidísimo does not issue', async () => {
    await expect(carrier(gateway()).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T16:52:40.000Z' });
    const unknown = gateway({ search: reply(fixture('search-not-found'), { status: 404 }) });
    await expect(carrier(unknown).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(unknown).toHaveBeenCalledTimes(1);
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('70000000001')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects numbers Inter Rapidísimo does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['70000000001', '70000000000171', 'ABC000000017', '7000000000l7']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeInterrapidisimoNumber('7000-0000-0017')).toBe(DELIVERED);
  });

  it('ends a hanging request inside the budget', async () => {
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

  it('routes a guide filed under Inter Rapidísimo to the adapter', async () => {
    const fetcher = gateway();
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'interrapidisimo' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'interrapidisimo', source: 'interrapidisimo', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(INTERRAPIDISIMO_MILESTONES))).toBe(true);
  });
});

describe('Inter Rapidísimo status vocabulary', () => {
  it('records every milestone the map knows with the stage it gives', () => {
    // The other entries are the wording of the tracking service the tracker used before.
    const live = statuses.entries.filter((entry) => entry.confirmedBy === 'live') as { wording: string; stage: string }[];
    expect(live.length).toBeGreaterThan(0);
    for (const entry of live) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(interrapidisimoStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'interrapidisimo', providerCode: null, description: 'Esperando tu acción' }))
      .toEqual({ kind: 'mapped', stage: 'exception' });
    expect(statusMapAnswer({ carrier: 'interrapidisimo', providerCode: null, description: 'Paso sintético' })).toEqual({ kind: 'unknown' });
    expect(interrapidisimoStage('Paso sintético')).toBeNull();
  });
});
