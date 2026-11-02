import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LAAR_API, LaarCourierTracker, laarRequest, type LaarRoute } from './adapter.js';
import { normalizeLaarNumber, parseLaar } from './parser.js';
import { laarStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'GYE0000000001';
const IN_TRANSIT = 'GYE0000000002';
const UNKNOWN = 'GYE0000000000';

type Row = Record<string, unknown>;
type Reply = Row & { objetoADeserializar: unknown };
type Replies = Record<LaarRoute, Reply>;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Replies;
const list = (reply: Reply) => reply.objetoADeserializar as Row[];
const stepsOf = (reply: Reply) => JSON.parse(reply.objetoADeserializar as string) as Row[];
const changed = (name: string, change: (replies: Replies) => void) => {
  const replies = fixture(name);
  change(replies);
  return replies;
};
const changedSteps = (name: string, change: (steps: Row[]) => void) => changed(name, (replies) => {
  const steps = stepsOf(replies.steps);
  change(steps);
  replies.steps.objetoADeserializar = JSON.stringify(steps);
});
const parse = (replies: Replies, number: string) => parseLaar(replies, number);

const ROUTES: Readonly<Record<string, LaarRoute>> = {
  '/Tracking/api/buscar/guia': 'search', '/Tracking/api/etiqueta/deprati': 'label', '/Tracking/api/estados': 'steps',
  '/Tracking/api/estadosTransito': 'transit', '/Tracking/api/novedades': 'incidents',
};
const routeOf = (url: unknown) => ROUTES[new URL(String(url)).pathname]!;
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
/** A transport answering each route from the replies, with one route's answer replaced. */
const serve = (replies: Replies, override: Partial<Record<LaarRoute, () => Response>> = {}) =>
  vi.fn<typeof fetch>().mockImplementation(async (url) => override[routeOf(url)]?.() ?? reply(replies[routeOf(url)]));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Laar Courier HTTP adapter', () => {
  it('asks the page’s routes in its order for the whole guía, through the supplied transport', async () => {
    const fetcher = serve(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LaarCourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' gye 0000-000002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher.mock.calls.map(([url]) => routeOf(url))).toEqual(['search', 'label', 'steps', 'transit', 'incidents']);
    for (const [url, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: {
        Accept: 'application/json', Authorization: 'Basic YWRtaW46YWRtaW4=', API_KEY_LAAR: expect.any(String), 'User-Agent': 'SyntheticHost/1.0' } });
      if (init?.method === 'GET') expect(new URL(String(url)).searchParams.get('guia')).toBe(IN_TRANSIT);
    }
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${LAAR_API}/buscar/guia?guia=${IN_TRANSIT}`);
    // The timeline is asked for with the label's current state, as the page does.
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]!.body))).toEqual({ idEstado: 5, guia: IN_TRANSIT, tipoConsulta: 0 });
    expect(JSON.parse(String(fetcher.mock.calls[4]![1]!.body))).toEqual({ guia: IN_TRANSIT, tipoConsulta: 0 });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'laar-courier', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(laarRequest('steps', DELIVERED)).toEqual({ url: `${LAAR_API}/estados`, method: 'POST',
      body: JSON.stringify({ idEstado: 0, guia: DELIVERED, tipoConsulta: 0 }) });
  });

  it('keeps each step’s wall clock and office, and leaves out a creation dated after the collection', () => {
    const result = parse(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2026-05-13T11:31:07', expected_delivery: null, weight_kg: 2.5 });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.description, event.stage, event.location ?? null])).toEqual([
      ['2026-05-13T11:31:07', '7', 'Entregado', 'delivered', 'Muestra Sur'],
      ['2026-05-13T10:27:29', '6', 'Zona de Entrega', 'out_for_delivery', 'Muestra Sur'],
      // A transit detail comes above the step it details at the same second.
      ['2026-05-12T16:48:21', '11', 'SALIDA DE BODEGA DE ORIGEN', 'in_transit', null],
      ['2026-05-12T16:48:21', '5', 'En Tránsito', 'in_transit', 'Muestra Norte'],
      ['2026-05-12T16:05:10', '4', 'En Bodega', 'in_transit', 'Muestra Norte'],
      ['2026-05-12T16:05:10', '3', 'Recolectado', 'accepted', 'Muestra Norte'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample|SAMPLE|Samp|Ficticia|Calle|0990000000|example\.com|00000|ZZ-00|MUESTRA|Courier de Campo/);
  });

  it('keeps a creation dated before the collection, and skips steps not reached yet', () => {
    const result = parse(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'SALIDA DE BODEGA DE ORIGEN', last_update_local: '2026-05-18T21:02:09' });
    // A weight of zero is no weight.
    expect(result).not.toHaveProperty('weight_kg');
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([
      ['11', 'in_transit'], ['5', 'in_transit'], ['4', 'in_transit'], ['3', 'accepted'], ['2', 'registered'],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-05-18T08:02:11', description: 'Por Recolectar' });
  });

  it('keeps a reported problem by its own wording, without the remarks beside it', () => {
    const result = parse(changed('in-transit', (replies) => {
      replies.incidents.objetoADeserializar = [{ fechaHora: '2026-05-19T11:20:05.3', novedad: 'CLIENTE AUSENTE, llamar al 099 000 0000', nombreCat: 'ENTREGA',
        observacionCourier: 'Sample Person no estaba', observacionSac: 'Sample note', P16_ActualizacionInformativo: 'ACT' },
      { fechaHora: '2026-05-19T12:00:00', novedad: '', nombreCat: 'ENTREGA', observacionCourier: null, observacionSac: null }];
    }), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'wording:language',
      last_status_text: 'CLIENTE AUSENTE, llamar al' });
    expect(result.events![0]).toEqual({ local_time: '2026-05-19T11:20:05', description: 'CLIENTE AUSENTE, llamar al',
      stage: 'failed_attempt', stage_source: 'wording:language' });
    expect(result.events).toHaveLength(6);
    expect(JSON.stringify(result)).not.toMatch(/Sample|ENTREGA"|099/);
  });

  it('takes the summary’s word for a delivery, a return or a voided guía, and drops voided steps', () => {
    const returned = parse(changed('in-transit', (replies) => { list(replies.search)[0]!.estado = 'Devuelto'; }), IN_TRANSIT);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'wording:language' });
    const voided = parse(changedSteps('in-transit', (steps) => {
      steps.push({ P33_Orden: 9, P33_Alias: 'Guía Anulada', Id: 9, G28_FechaEstado: '2026-05-19T09:00:00', RegionalAcopio: 'Muestra Norte' });
    }), IN_TRANSIT);
    expect(voided.events!.map((event) => event.description)).not.toContain('Guía Anulada');
    // The summary's own word that agrees with the newest scan keeps the scan's source.
    expect(parse(fixture('delivered'), DELIVERED)).toMatchObject({ current_stage_source: 'carrier_map' });
  });

  it('reads a guía created and not collected yet as its state alone', () => {
    const created = changed('in-transit', (replies) => {
      list(replies.search)[0]!.estado = 'Por Recolectar';
      replies.steps.objetoADeserializar = JSON.stringify(stepsOf(replies.steps).map((step) => ({ ...step, G28_FechaEstado: null })));
      replies.transit.objetoADeserializar = [];
    });
    expect(parse(created, IN_TRANSIT)).toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Por Recolectar', summary_only: true, events: [] });
    list(created.search)[0]!.estado = '';
    expect(() => parse(created, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads an unknown guía as not found after one request, and a record without a label as no history', async () => {
    const fetcher = serve(fixture('not-found'));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const unlabelled = changed('delivered', (replies) => { replies.label.objetoADeserializar = []; });
    expect(() => parse(unlabelled, DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const labelless = serve(unlabelled);
    await expect(carrier(labelless).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(labelless).toHaveBeenCalledTimes(2);
  });

  it('counts a guía only when its label and transit details name it', async () => {
    expect(() => parse(fixture('delivered'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Laar answered for another guía' }));
    const elsewhere = changed('delivered', (replies) => { list(replies.transit)[0]!.guia = IN_TRANSIT; });
    expect(() => parse(elsewhere, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const lower = changed('delivered', (replies) => { list(replies.label)[0]!.g01Id = DELIVERED.toLowerCase(); });
    expect(parse(lower, DELIVERED).events).toHaveLength(6);
    // Another guía's label stops the lookup before the timeline is asked for.
    const fetcher = serve(fixture('delivered'));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads a failed record, label or timeline as inconclusive, and leaves out a detail list the service fails to read', () => {
    const failed = { isSuccess: false, message: 'System.Exception: synthetic', objetoADeserializar: null, tipoMensaje: null };
    expect(() => parse(changed('delivered', (replies) => { replies.search = failed; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(changed('delivered', (replies) => { replies.label = failed; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(changed('delivered', (replies) => { replies.search.isSuccess = false; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(changed('delivered', (replies) => { replies.steps = failed; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const partial = parse(changed('delivered', (replies) => { replies.transit = failed; replies.incidents = failed; }), DELIVERED);
    expect(partial.events!.map((event) => event.provider_code)).toEqual(['7', '6', '5', '4', '3']);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (replies: Replies) => { delete (replies.search as Row).objetoADeserializar; },
      (replies: Replies) => { replies.search.objetoADeserializar = { estado: 'Entregado' }; },
      (replies: Replies) => { replies.search.objetoADeserializar = ['guía']; },
      (replies: Replies) => { list(replies.search)[0]!.estado = 7; },
      (replies: Replies) => { delete list(replies.label)[0]!.g01Id; },
      (replies: Replies) => { replies.steps.objetoADeserializar = '[{"Id":'; },
      (replies: Replies) => { replies.steps.objetoADeserializar = '{"Id":2}'; },
      (replies: Replies) => { replies.steps.objetoADeserializar = JSON.stringify(Array.from({ length: 201 }, () => stepsOf(replies.steps)[1])); },
      (replies: Replies) => { replies.transit.objetoADeserializar = 'details'; },
      (replies: Replies) => { list(replies.transit)[0]!.fecha = '12/05/2026 16:48'; },
      (replies: Replies) => { list(replies.transit)[0]!.nombre = ''; },
      (replies: Replies) => { list(replies.transit)[0]!.p33Id = 'eleven'; },
      (replies: Replies) => { delete list(replies.transit)[0]!.guia; },
    ]) {
      expect(() => parse(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const change of [
      (steps: Row[]) => { steps[1]!.G28_FechaEstado = '2026-02-30T10:00:00'; },
      (steps: Row[]) => { steps[1]!.G28_FechaEstado = '2026-05-12T24:00:00'; },
      (steps: Row[]) => { steps[1]!.G28_FechaEstado = '2026-05-12T16:05:10-05:00'; },
      (steps: Row[]) => { steps[1]!.G28_FechaEstado = 1778601910000; },
      (steps: Row[]) => { steps[1]!.P33_Alias = null; },
      (steps: Row[]) => { steps[1]!.P33_Alias = ['Recolectado']; },
      (steps: Row[]) => { steps[1]!.Id = '3a'; },
      (steps: Row[]) => { steps[1]!.RegionalAcopio = 3; },
    ]) {
      expect(() => parse(changedSteps('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // .NET's empty date is a step not reached.
    expect(parse(changedSteps('delivered', (steps) => { steps[1]!.G28_FechaEstado = '0001-01-01T00:00:00'; }), DELIVERED).events)
      .toHaveLength(5);
  });

  it('keeps an unknown guía, a refused key, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (route: LaarRoute, answer: () => Response) => carrier(serve(fixture('delivered'), { [route]: answer })).track({ number: DELIVERED });
    await expect(carrier(serve(fixture('not-found'))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // A request without the page's key or credentials is HTTP 401 for every guía.
    await expect(lookup('search', () => new Response('Unauthorized', { status: 401 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('steps', () => new Response('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('label', () => new Response('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('steps', () => new Response('', { status: 405 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('search', () => new Response('', { status: 302, headers: { Location: 'https://fenix.laarcourier.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('search', () => reply('<html><head><title>Just a moment...</title></head></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('transit', () => reply('<html><title>Tracking LaarCourier</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('incidents', () => new Response('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known guía and the unknown-guía answer, and asks nothing for a guía Laar does not issue', async () => {
    const delivered = serve(fixture('delivered'));
    // A local clock dates the last activity without an instant.
    await expect(carrier(delivered).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-05-13T11:31:07' });
    const unknown = serve(fixture('not-found'));
    await expect(carrier(unknown).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(unknown).recognize!('GYE-00')).resolves.toEqual({ known: false });
    expect(unknown).toHaveBeenCalledTimes(1);
  });

  it('rejects guías Laar does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['GYE00', 'SAMPLETRACKING', `GYE${'0'.repeat(28)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLaarNumber('gye 000-000-0001')).toBe(DELIVERED);
  });

  it('ends a hanging read inside the budget and tries once more', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes a guía filed under Laar to the adapter', async () => {
    const fetcher = serve(fixture('delivered'));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'laar-courier' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'laar-courier', source: 'laar-courier', result: { current_stage: 'delivered' } });
  });
});

describe('Laar Courier status vocabulary', () => {
  it('records every id and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(laarStage(entry.code ?? '', entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'laar-courier', providerCode: '6', description: 'Zona de Entrega' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'laar-courier', providerCode: '99', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // An id the map does not know falls to the step's name, then to the shared wording rules.
    expect(laarStage('99', 'Entregado')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(laarStage('', 'DIRECCION INCORRECTA')).toEqual({ stage: 'exception', source: 'wording:language' });
    expect(laarStage('99', 'Synthetic note')).toBeNull();
  });
});
