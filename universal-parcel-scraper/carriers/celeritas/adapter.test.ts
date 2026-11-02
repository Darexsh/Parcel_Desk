import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CELERITAS_ENDPOINT, CeleritasTracker } from './adapter.js';
import { parseCeleritas } from './parser.js';
import { celeritasHeadingStage, celeritasScanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const TRANSIT = '912345670';
const RETURNED = '934567812';
const ABSENT = '300000017';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseCeleritas>) => result.events!.map(event => [event.local_time, event.description, event.stage]);
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType: \'interactive\'};</script></body></html>';

describe('Celeritas tracking adapter', () => {
  it('asks the tracking page once for the whole reference through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CeleritasTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 912 345 670 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://celeritastransporte.com/seguimiento-paquete-pedidos/?refer=${TRANSIT}&lang=es`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'celeritas', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an open shipment newest first, as wall clocks, with its weight and nothing about the shop, places or partner', () => {
    const result = parseCeleritas(page('transit'), TRANSIT);
    expect(result).toEqual({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Envío en reparto', last_update: null, last_update_local: '2026-03-04T07:52:00',
      expected_delivery: null, weight_kg: 0.7,
      events: [
        { local_time: '2026-03-04T07:52:00', description: 'Envío en reparto', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-04T07:52:00', description: 'Recibido en plataforma local', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T23:18:00', description: 'Envío recibido en agencia de origen', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T15:06:00', description: 'Lectura en almacen de Cruce', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-02T09:20:00', description: 'Envío pendiente de recibir', stage: 'registered', stage_source: 'carrier_map' },
        { local_time: '2026-03-02T09:15:00', description: 'Envío pendiente de recibir', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    const text = JSON.stringify(result);
    for (const kept of ['TIENDA DE EJEMPLO', '4400012345', 'CORREOS', 'Villaprueba', 'Pueblo Inventado', 'domiciliaria', 'SMS']) {
      expect(text, kept).not.toContain(kept);
    }
  });

  it('takes a returned heading over a later transit scan, keeps each scan once and never names the point', () => {
    const result = parseCeleritas(page('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'ENVIO DEVUELTO', last_update_local: '2026-05-21T21:40:00', weight_kg: 2.35 });
    expect(result.pickup_point).toBeUndefined();
    expect(rows(result)).toEqual([
      ['2026-05-21T21:40:00', 'Lectura en almacén de Cruce', 'in_transit'],
      ['2026-05-20T22:05:00', 'Devolución entregada en almacén de destino', 'returned'],
      ['2026-05-20T14:12:00', 'Lectura en almacen de Cruce', 'in_transit'],
      ['2026-05-14T08:30:00', 'Envío pendiente de recibir', 'registered'],
      ['2026-05-09T09:02:00', 'Disponible para recoger en agencia de transporte', 'ready_for_pickup'],
      // Equal clocks keep the page's order.
      ['2026-05-08T12:37:00', 'Pospuesta en punto', 'failed_attempt'],
      ['2026-05-08T12:37:00', 'Recibido en plataforma local', 'in_transit'],
      ['2026-05-08T12:37:00', 'Envío en reparto', 'out_for_delivery'],
      ['2026-05-07T18:44:00', 'Envío recibido en agencia de origen', 'in_transit'],
      ['2026-05-06T16:21:00', 'Lectura en almacen de Cruce', 'in_transit'],
      ['2026-05-05T15:58:00', 'Envío pendiente de recibir', 'registered'],
    ]);
    for (const kept of ['PAPELER', 'pupInfo', '99999', 'CIUDAD INVENTADA', 'OTRA TIENDA', '77001234', 'REPARTOS DE PRUEBA']) {
      expect(JSON.stringify(result), kept).not.toContain(kept);
    }
    // When the newest scan is the return itself, it speaks for the shipment.
    const settled = parseCeleritas(page('returned').replace(/<div class="timeline-event">(?:(?!<div class="timeline-event">)[\s\S])*?21\/05\/2026 - 21:40[\s\S]*?<\/p>\s*<\/div>\s*<\/div>/, ''), RETURNED);
    expect(settled).toMatchObject({ current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Devolución entregada en almacén de destino', last_update_local: '2026-05-20T22:05:00' });
  });

  it('leaves the stage to the scans under an open or unknown heading, and to the shared rules for new wording', () => {
    expect(parseCeleritas(page('returned').replace('ENVIO DEVUELTO', 'EN GESTION'), RETURNED))
      .toMatchObject({ current_stage: 'in_transit', last_status_text: 'Lectura en almacén de Cruce' });
    expect(parseCeleritas(page('transit').replace('EN GESTION', 'NUEVO ESTADO'), TRANSIT))
      .toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Envío en reparto' });
    const shared = parseCeleritas(page('transit').replace('>Envío en reparto<', '>Envío entregado<'), TRANSIT);
    expect(shared).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    expect(shared.delivered_at).toBeUndefined();
    const unknown = parseCeleritas(page('transit').replace('>Envío en reparto<', '>Bulto pesado<'), TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Bulto pesado' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events![0]).toEqual({ local_time: '2026-03-04T07:52:00', description: 'Bulto pesado' });
  });

  it('answers with a returned heading alone when no scan is listed, and has no history without one', () => {
    const empty = page('returned').replace(/<div class="timeline">[\s\S]*?<\/div>\s*<\/div>\s*<\/section>/, '<div class="timeline"></div></div></section>');
    expect(parseCeleritas(empty, RETURNED)).toEqual({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'ENVIO DEVUELTO', last_update: null, expected_delivery: null, weight_kg: 2.35, summary_only: true, events: [] });
    expect(() => parseCeleritas(empty.replace('ENVIO DEVUELTO', 'EN GESTION'), RETURNED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a weight only when it is a positive amount', () => {
    for (const [kilos, expected] of [['0', undefined], ['', undefined], ['1.5 kg', undefined], ['12', 12]] as const) {
      expect(parseCeleritas(page('transit').replace('>0.7<', `>${kilos}<`), TRANSIT).weight_kg, kilos).toBe(expected);
    }
  });

  it('binds the page to the requested reference and rejects pages it cannot read', () => {
    // The tracker also finds shipments by the shop's order number, under their own reference.
    expect(() => parseCeleritas(page('transit'), RETURNED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of [
      page('transit').replace(`>${TRANSIT}<`, '>91234567<'),
      page('transit').replace(`>${TRANSIT}<`, `>${TRANSIT} ${RETURNED}<`),
      page('transit').replace('Tu número de referencia:', 'Referencia:'),
      page('transit').replace('<li>', `<li><span class="first-column">Tu número de referencia:</span><span class="second-column">${TRANSIT}</span></li><li>`),
      page('transit').replace('<section class="seguimiento-paquete container-lg">', '<section class="seguimiento-paquete"></section><section class="seguimiento-paquete container-lg">'),
      page('transit').replace('<span class="event-name">EN GESTION</span>', '<span class="event-name">EN GESTION</span><span class="event-name">ENVIO DEVUELTO</span>'),
      page('transit').replace('04/03/2026 - 07:52', '04/03/2026 - 24:10'),
      page('transit').replace('04/03/2026 - 07:52', '31/02/2026 - 07:52'),
      page('transit').replace('04/03/2026 - 07:52', '2026-03-04 07:52'),
      page('transit').replace('>Envío en reparto<', '><'),
      page('transit').replace('<time>04/03/2026 - 07:52</time>', ''),
      '<html><body>Mantenimiento</body></html>']) {
      expect(() => parseCeleritas(html, TRANSIT), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const many = page('transit').replace(/<div class="timeline-event">[\s\S]*?<\/p>\s*<\/div>\s*<\/div>/, (row: string) => row.repeat(301));
    expect(() => parseCeleritas(many, TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads only the tracker’s notice for an unknown reference as a missing shipment', () => {
    expect(() => parseCeleritas(page('not-found'), ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCeleritas(page('not-found').replace('Esta referencia no existe', 'Servicio no disponible'), ABSENT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The page without a lookup, and block pages, are no answer about the shipment.
    expect(() => parseCeleritas(page('search'), ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of [CHALLENGE, '<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parseCeleritas(html, ABSENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes nine-digit references only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['91234567', '9123456701', 'A12345670', 'PQ4BCD0123456780128001X', '4400012345']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the notice for an unknown reference as not found and recognizes a known shipment, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('not-found'))).mockResolvedValueOnce(reply(page('transit')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-04T07:52:00' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    // A hit under another reference is no answer either way.
    await expect(carrier(fetcher).recognize!(RETURNED)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(status === 429 || status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a challenge served with HTTP 200, redirects, empty pages and oversized replies apart from missing shipments', async () => {
    const challenged = vi.fn<typeof fetch>().mockImplementation(async () => reply(CHALLENGE));
    await expect(carrier(challenged).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
    for (const response of [() => new Response(null, { status: 302, headers: { Location: `${CELERITAS_ENDPOINT}?refer=${ABSENT}&lang=es&c=1` } }),
      () => new Response(null, { status: 301, headers: { Location: 'https://celeritastransporte.com/' } }), () => reply(''), () => reply('  ')]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: TRANSIT })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('transit')));
    await expect(carrier(flaky).track({ number: TRANSIT })).resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('transit')));
    await expect(carrier(immediate).track({ number: TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: TRANSIT }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a reference to the adapter when the caller names Celeritas or pastes its link, which detection never offers', async () => {
    for (const number of [TRANSIT, RETURNED]) {
      expect(detectCarrierMatch(number).candidates).not.toContain('celeritas');
      expect(recognitionAskedCarriers(number)).not.toContain('celeritas');
    }
    for (const link of [`https://celeritastransporte.com/seguimiento-paquete-pedidos/?refer=${TRANSIT}&lang=es`,
      `https://celeritastransporte.com/seguimiento-paquete-pedidos/?c=1&refer=${TRANSIT}`, `https://celeritastransporte.com/seguimiento-paquete-pedidos?refer=${TRANSIT}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: TRANSIT, carrier: 'celeritas', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('transit')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: TRANSIT, carrier: 'celeritas' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'celeritas', source: 'celeritas', result: { current_stage: 'out_for_delivery' } });
    expect(answer.result.delivery_carrier).toBeUndefined();
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${CELERITAS_ENDPOINT}?`))).toBe(true);
  });
});

describe('Celeritas status vocabulary', () => {
  it('records every wording and heading the maps know with the stage they give', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      const heading = entry.wording === entry.wording.toUpperCase();
      if (entry.wording === 'Esta referencia no existe') continue;
      expect(heading ? celeritasHeadingStage(entry.wording) : celeritasScanStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMap.stage(null, entry.wording.toLocaleLowerCase('es-ES')), entry.wording).toBe(heading ? undefined : stage);
    }
    expect(celeritasScanStage('  ENVÍO en  reparto ')).toBe('out_for_delivery');
    for (const wording of ['constructor', 'toString', 'Envío', 'ENVIO DEVUELTO', 'Envío en reparto hoy']) {
      expect(celeritasScanStage(wording), wording).toBeUndefined();
    }
    expect(celeritasHeadingStage('Envío en reparto')).toBeUndefined();
    expect(statusMap.stage('7', 'envío en reparto')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'celeritas', description: 'Pospuesta en punto' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
  });
});
