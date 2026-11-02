import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CastoresTracker } from './adapter.js';
import { CASTORES_PAGE, castoresWording, parseCastores } from './parser.js';
import { castoresMappedStage, castoresStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '00000000001';
const IN_TRANSIT = '00000000002';
const ABSENT = '00000000000';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseCastores>) =>
  result.events!.map(event => [event.local_time, event.location, event.description, event.stage]);
// The parties, who took the delivery, the origin and destination, and the page's commented-out delivery line.
const PRIVATE = /REMITENTE|DESTINATARIO|PERSONA INVENTADA|EMPRESA DE PRUEBA|CLIENTE FICTICIO|Recibio|GTO\.|S\.L\.P\.|B\.C\.|Entregado en/;

describe('Castores tracking adapter', () => {
  it('opens the tracking page once for the whole talón through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CastoresTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${DELIVERED.slice(0, 5)} ${DELIVERED.slice(5)} `, { budgetMs: 1000.5 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.castores.com.mx/rastrear.html?guide_numbers=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'castores', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the history newest first, as wall clocks, with the service and without parties or places of the header', () => {
    const result = parseCastores(page('delivered'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2026-03-12T09:05:10', expected_delivery: null,
      service_name: 'Domicilio', events: expect.any(Array) });
    expect(rows(result)).toEqual([
      ['2026-03-12T09:05:10', undefined, 'Entregado', 'delivered'],
      ['2026-03-12T07:40:22', 'PUERTO FICTICIO', 'En Ruta de Entrega: EN TRAYECTO', 'out_for_delivery'],
      ['2026-03-12T06:15:03', 'PUERTO FICTICIO', 'En Centro de Distribución Destino: EN BODEGA DESTINO O DE PASO', 'in_transit'],
      ['2026-03-11T22:48:51', 'PUERTO FICTICIO', 'En Ruta de Entrega: TALON RECUPERADO EN OFICINA', 'in_transit'],
      ['2026-03-10T03:30:00', 'CEDIS EJEMPLO', 'En Trayecto', 'in_transit'],
      ['2026-03-09T20:12:45', 'CEDIS EJEMPLO', 'En Centro de Distribución Origen: EN BODEGA DESTINO O DE PASO', 'in_transit'],
      ['2026-03-09T18:01:09', 'VILLA EJEMPLO CENTRO', 'Recolectado: EN TRAYECTO', 'accepted'],
      ['2026-03-09T16:20:30', 'VILLA EJEMPLO CENTRO', 'Documentado: EN BODEGA ORIGEN', 'accepted'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      expect(JSON.stringify(parseCastores(page(name), number)), name).not.toMatch(PRIVATE);
    }
    // A list oldest first is turned round, and a row the page repeats appears once.
    const body = page('delivered');
    const list = /<ul>\s*(<li[\s\S]*?<\/li>)\s*<\/ul>/.exec(body)![1]!;
    const listed = list.split('</li>').slice(0, -1).map(item => `${item}</li>`);
    const reversed = parseCastores(body.replace(list, [...listed].reverse().join('') + listed[0]), DELIVERED);
    expect(reversed.events).toEqual(result.events);
  });

  it('follows the newest row of a shipment on its way', () => {
    const result = parseCastores(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'En Centro de Distribución Destino: EN BODEGA DESTINO O DE PASO', last_update_local: '2026-04-22T08:10:00' });
    expect(rows(result)).toEqual([
      ['2026-04-22T08:10:00', 'FRONTERA EJEMPLO', 'En Centro de Distribución Destino: EN BODEGA DESTINO O DE PASO', 'in_transit'],
      ['2026-04-20T16:45:30', 'CIUDAD MUESTRA', 'En Trayecto', 'in_transit'],
      ['2026-04-20T01:05:15', 'CIUDAD MUESTRA', 'En Centro de Distribución Origen: EN BODEGA DESTINO O DE PASO', 'in_transit'],
      ['2026-04-19T17:20:40', 'CIUDAD MUESTRA', 'Documentado: EN BODEGA ORIGEN', 'accepted'],
    ]);
  });

  it('stages new wording through the shared rules and keeps the rest visible without a stage', () => {
    const told = parseCastores(page('delivered').replace('<h4>Entregado</h4><p></p><p></p>',
      '<h4>Entregado</h4><p>ENTREGADO AL CLIENTE</p><p>PUERTO FICTICIO</p>'), DELIVERED);
    expect(told.events![0]).toEqual({ local_time: '2026-03-12T09:05:10', location: 'PUERTO FICTICIO',
      description: 'Entregado: ENTREGADO AL CLIENTE', stage: 'delivered', stage_source: 'carrier_map' });
    const unknown = parseCastores(page('in-transit').replace('<h4>En Centro de Distribución Destino</h4>', '<h4>Ejemplo Sintético</h4>'), IN_TRANSIT);
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Ejemplo Sintético: EN BODEGA DESTINO O DE PASO' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-04-22T08:10:00', location: 'FRONTERA EJEMPLO',
      description: 'Ejemplo Sintético: EN BODEGA DESTINO O DE PASO' });
    // Without the service heading the result has no service.
    expect(parseCastores(page('in-transit').replace('<small>Servicio</small>Domicilio', '<small>Servicio</small>'), IN_TRANSIT))
      .not.toHaveProperty('service_name');
    expect(castoresWording('En Trayecto', 'EN TRAYECTO')).toBe('En Trayecto');
    expect(castoresWording('', 'EN TRAYECTO')).toBe('EN TRAYECTO');
  });

  it('binds the page to the requested talón and rejects pages it cannot read', () => {
    expect(() => parseCastores(page('delivered'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const shipment = /(\s*<div class="c-track__row js-shipping-content">[\s\S]*<\/div>\n)(?=\s*<\/div>\n\s*<\/div>\n\s*<\/section>)/.exec(page('delivered'))![1]!;
    expect(() => parseCastores(page('delivered').replace(shipment, shipment + shipment), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of ['<html><body>Mantenimiento</body></html>',
      page('delivered').replace(`#${DELIVERED}`, ''),
      page('delivered').replace('Número de guía', 'Folio'),
      page('delivered').replace('<small>Servicio</small>', '<small>Número de guía</small>'),
      page('delivered').replace('<small>12/Mar/2026</small>', '<small>12/Xyz/2026</small>'),
      page('delivered').replace('<small>12/Mar/2026</small>', '<small>31/Abr/2026</small>'),
      page('delivered').replace('07:40:22 Hrs', '24:40:22 Hrs'),
      page('delivered').replace('07:40:22 Hrs', '2026-03-12 07:40:22'),
      page('delivered').replace('<h4>En Trayecto</h4><p>EN TRAYECTO</p>', '<h4></h4><p></p>'),
      page('delivered').replace('<h4>En Trayecto</h4><p>EN TRAYECTO</p>', '<h4>En Trayecto</h4>'),
      page('delivered').replace('js-shipDetails', 'js-details'),
      page('delivered').replace('class="c-track__body"', 'class="c-track__content"')]) {
      expect(() => parseCastores(html, DELIVERED), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = page('delivered').replace('<li class="is-active">', `${Array.from({ length: 501 }, (_, second) =>
      `<li><p>01:00:${String(second % 60).padStart(2, '0')} Hrs <small>${String(1 + Math.floor(second / 60)).padStart(2, '0')}/Mar/2026</small></p><h4>En Trayecto</h4><p></p><p>CEDIS EJEMPLO</p></li>`).join('')}<li class="is-active">`);
    expect(() => parseCastores(many, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A shipment without rows has no history.
    expect(() => parseCastores(page('delivered').replace(/(<div class="c-track__ship-details[^>]*>\s*<ul>)[\s\S]*?(<\/ul>)/, '$1$2'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads only the notice naming the talón as a missing shipment, and a block page as a challenge', () => {
    expect(() => parseCastores(page('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCastores(page('not-found').replace('Las guias', 'El talón').replace('ingresados', 'ingresado'), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A notice for another number, or for none, is not this talón's.
    expect(() => parseCastores(page('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCastores(page('not-found').replace(`<strong>${ABSENT}</strong>`, '<strong></strong>'), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // The page renders nothing for a lookup it did not make.
    expect(() => parseCastores(page('not-found').replace(/<p>Las guias[\s\S]*?<br>/, ''), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCastores(page('not-found').replace('no existe en la base de datos', 'no está disponible'), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of ['<html><head><title>Access Denied</title></head><body>Blocked</body></html>',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>',
      '<html><body>Request unsuccessful. Incapsula incident ID: 0-0</body></html>']) {
      expect(() => parseCastores(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes eleven-digit talones and nothing else, the guía included, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000000', '000000000000', '0000000000X', 'ABC-0000000', 'ABC00000', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(carrier(fetcher).recognize).toBeUndefined();
    expect(() => parseCastores(page('delivered'), 'ABC-0000000')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => status === 302
        ? new Response(null, { status, headers: { Location: '/' } })
        : reply(status === 500 ? '' : page('not-found'), status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('keeps empty pages and oversized replies apart from missing shipments', async () => {
    for (const [body, kind] of [['', 'indeterminate'], ['  ', 'indeterminate'], ['{"success":true}', 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body.slice(0, 40)).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a talón filed under Castores to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} })
      .track({ number: DELIVERED, carrier: 'castores' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'castores', source: 'castores', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${CASTORES_PAGE}?`))).toBe(true);
  });
});

describe('Castores status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(castoresMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
    expect(castoresMappedStage('  en RUTA de   entrega ')).toBe('out_for_delivery');
    for (const wording of ['constructor', 'toString', 'En Ruta', 'En Ruta de Entrega: OTRO ESTATUS', 'EN BODEGA ORIGEN']) {
      expect(castoresMappedStage(wording), wording).toBeUndefined();
    }
    expect(castoresStage('Ejemplo Sintético')).toBeNull();
    expect(statusMap.stage('7', 'entregado')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'castores', description: 'En Ruta de Entrega: TALON RECUPERADO EN OFICINA' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
