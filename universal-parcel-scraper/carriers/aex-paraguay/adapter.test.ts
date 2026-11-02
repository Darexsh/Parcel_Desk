import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, AEX_ENDPOINT, AexTracker } from './adapter.js';
import { aexWording, parseAex } from './parser.js';
import { aexMappedStage, aexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'A000000001';
const TRANSIT = 'A000000002';
const UNKNOWN = 'A000000000';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseAex>) => result.events!.map((event) => [event.local_time, event.description, event.stage ?? null]);
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType: \'managed\'};</script></body></html>';
const PRIVATE = ['Juana', 'Inventada', 'Recibido', 'doc', '1234567', '0981', 'Llamar'];

describe('AEX tracking adapter', () => {
  it('asks the tracking page once for the whole guía in capitals through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' a 000-000 002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.aex.com.py/web/tracking.php?guia=${TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'aex-paraguay', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery as wall clocks under their day, newest first, once each and without the comment naming the receiver', () => {
    const result = parseAex(page('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Entrega Realizada',
      last_update: null, last_update_local: '2026-03-13T11:42:00', expected_delivery: null,
      events: [
        { local_time: '2026-03-13T11:42:00', description: 'Entrega Realizada', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-13T08:05:00', description: 'Asignado a repartidor para entrega', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-13T08:04:00', description: 'Asignado a repartidor para entrega', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        // The pickup listed twice is kept once.
        { local_time: '2026-03-12T17:20:00', description: 'El paquete fue retirado y se encuentra en poder de AEX', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-03-12T17:12:00', description: 'Recepción en oficina de AEX', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-03-12T09:31:47', description: 'El remitente generó la etiqueta de envío y el paquete está pendiente de retiro por AEX',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
    expect(result.delivered_at).toBeUndefined();
  });

  it('stages an event it does not know by the state beside it, and ignores the progress rail and comments', () => {
    const result = parseAex(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Despachado a sucursal de destino', last_update_local: '2026-02-02T07:15:00' });
    expect(rows(result)).toEqual([
      ['2026-02-02T07:15:00', 'Despachado a sucursal de destino', 'in_transit'],
      ['2026-01-31T18:02:00', 'Recepción en oficina de AEX', 'accepted'],
      ['2026-01-31T16:40:00', 'El paquete fue retirado y se encuentra en poder de AEX', 'accepted'],
      ['2026-01-31T10:03:12', 'El remitente generó la etiqueta de envío y el paquete está pendiente de retiro por AEX', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
    // A page listing the oldest first is turned round.
    const $ = load(page('in-transit'));
    const container = $('.timeline-container');
    const days: string[][] = [];
    for (const node of container.children().toArray()) {
      if ($(node).is('h5')) days.push([$.html(node)]);
      else days.at(-1)!.splice(1, 0, $.html(node));
    }
    container.html(days.reverse().flat().join(''));
    const ascending = $.html();
    expect(rows(parseAex(ascending, TRANSIT))).toEqual(rows(result));
  });

  it('falls back to the shared wording rules, then to no stage, and describes an event without text by its state', () => {
    const worded = parseAex(page('delivered').replace('<div class="tracking-status">Entregada</div>', '<div class="tracking-status">Novedad</div>')
      .replace('Entrega Realizada', 'Paquete entregado al destinatario'), DELIVERED);
    expect(worded).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    const unknown = parseAex(page('delivered').replace('<div class="tracking-status">Entregada</div>', '<div class="tracking-status">Novedad</div>')
      .replace('Entrega Realizada', 'Bulto pesado'), DELIVERED);
    expect(unknown).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Bulto pesado' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-03-13T11:42:00', description: 'Bulto pesado' });
    const bare = parseAex(page('delivered').replace('<div class="tracking-event">Entrega Realizada</div>', ''), DELIVERED);
    expect(bare.events![0]).toEqual({ local_time: '2026-03-13T11:42:00', description: 'Entregada', stage: 'delivered', stage_source: 'carrier_map' });
    expect(aexStage('Otra novedad', 'En camino')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(aexStage('Otra novedad', '')).toBeNull();
  });

  it('drops phone and ID numbers from an event', () => {
    expect(aexWording('Llamar al 0981 000 000 para coordinar')).toBe('Llamar al para coordinar');
    expect(aexWording('Documento 1.234.567 verificado')).toBe('Documento verificado');
    expect(aexWording('  Recepción en oficina de AEX ')).toBe('Recepción en oficina de AEX');
  });

  it('binds the page to the requested guía and rejects pages it cannot read', () => {
    // The tracker capitalizes the guía and drops its spaces before it repeats it.
    expect(parseAex(page('in-transit').replace(`Guía ${TRANSIT}`, 'Guía a000000002'), TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    expect(() => parseAex(page('delivered'), 'A0000000011')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAex(page('delivered'), TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAex(page('not-found'), TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const many = page('in-transit').replace(/<div class="tracking-event-row">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, (row: string) => row.repeat(301));
    const broken = [
      page('delivered').replace('Historial de eventos', 'Historial'),
      page('delivered').replace('<div class="card-header">', '<div class="card-header">Historial de eventos - <small>Guía A000000001</small></div><div class="card-header">'),
      page('delivered').replace('<small>Guía A000000001</small>', '<small>A000000001</small>'),
      page('delivered').replace('timeline-container', 'timeline-list'),
      page('delivered').replace('Viernes, 13 de Marzo del 2026', 'Viernes, 31 de Febrero del 2026'),
      page('delivered').replace('Viernes, 13 de Marzo del 2026', 'Viernes, 13 de Marzus del 2026'),
      page('delivered').replace('Viernes, 13 de Marzo del 2026', '2026-03-13'),
      page('delivered').replace('<div class="tracking-hour">11:42:00</div>', '<div class="tracking-hour">24:10:00</div>'),
      page('delivered').replace('<div class="tracking-hour">11:42:00</div>', '<div class="tracking-hour">11:42</div>'),
      page('delivered').replace('<div class="tracking-hour">11:42:00</div>', ''),
      page('delivered').replace('<div class="tracking-event">Entrega Realizada</div>', '<div class="tracking-event">Entrega Realizada</div><div class="tracking-event">Otra</div>'),
      page('delivered').replace('<div class="tracking-status">Entregada</div>', '').replace('<div class="tracking-event">Entrega Realizada</div>', ''),
      page('delivered').replace(/<h5 class="tracking-date-title">Viernes[^<]*<\/h5>/, ''),
      page('delivered').replace('<div class="text-end mb-3">', '<div class="alert alert-warning">No se encuentra el número de seguimiento que ingresaste.</div><div class="text-end mb-3">'),
      page('not-found').replace('No se encuentra el número de seguimiento que ingresaste', 'Servicio no disponible'),
      many,
      '<html><body>Mantenimiento</body></html>',
    ];
    for (const html of broken) {
      const guia = html.includes(UNKNOWN) ? UNKNOWN : html.includes(TRANSIT) ? TRANSIT : DELIVERED;
      expect(() => parseAex(html, guia), html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // An empty timeline belongs to a guía AEX holds, before its first event.
    expect(() => parseAex(page('in-transit').replace(/<div class="timeline-container">[\s\S]*?<\/div><\/div>\s*<\/div>/,
      '<div class="timeline-container"></div></div></div>'), TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads only the notice as a missing guía, the empty form as one AEX does not issue, and block pages as challenges', () => {
    expect(() => parseAex(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAex(page('empty-form'), 'ZZ000000000')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseAex(page('empty-form').replace('Ingresá el número de guía de transporte', 'Error'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of [CHALLENGE, '<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parseAex(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes a series letter and six to twenty letters and digits only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['900000000', 'A00000', 'AEXABCDEF', `A${'0'.repeat(21)}`, 'A0000000-1/', '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the notice for an unknown guía as not found and recognizes a known one, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('in-transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('not-found'))).mockResolvedValueOnce(reply(page('empty-form'))).mockResolvedValueOnce(reply(page('in-transit')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-02T07:15:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(fetcher).recognize!('ZZ000000000')).resolves.toEqual({ known: false });
    // A page for another guía is no answer either way.
    await expect(carrier(fetcher).recognize!('A000000003')).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a challenge served with HTTP 200, redirects, empty pages and oversized replies apart from missing guías', async () => {
    const challenged = vi.fn<typeof fetch>().mockImplementation(async () => reply(CHALLENGE));
    await expect(carrier(challenged).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(challenged).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    // An address the site no longer serves is sent to its home page.
    const redirected = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302,
      headers: { Location: 'https://www.aex.com.py/web/' } }));
    await expect(carrier(redirected).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
    for (const body of ['', '  ']) {
      const empty = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(empty).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(carrier(empty).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: TRANSIT })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('not-found')));
    await expect(carrier(flaky).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('not-found')));
    await expect(carrier(immediate).track({ number: UNKNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: UNKNOWN }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: TRANSIT }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('leaves A-series guías to Allegro One’s rule, routes AEX’s links to the adapter and tracks a guía filed under AEX', async () => {
    // A and nine digits falls inside Allegro One's high-confidence shape, so AEX is not suggested or asked.
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'allegro-one', confidence: 'high' });
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('aex-paraguay');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('aex-paraguay');
    expect(parseTrackingInput(`https://www.aex.com.py/web/tracking.php?guia=${DELIVERED}`))
      .toMatchObject({ trackingNumber: DELIVERED, carrier: 'aex-paraguay', source: 'link' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'aex-paraguay' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'aex-paraguay', source: 'aex-paraguay', result: { current_stage: 'delivered' } });
    expect(answer.result.receiver_name).toBeUndefined();
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${AEX_ENDPOINT}?`))).toBe(true);
  });
});

describe('AEX status vocabulary', () => {
  it('records every event, state and rail step the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      if ('code' in entry) continue;
      expect(aexMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLocaleLowerCase('es-PY')), entry.wording).toBe(entry.stage);
    }
    expect(aexMappedStage('  RECEPCION en oficina de AEX. ')).toBe('accepted');
    for (const wording of ['constructor', 'toString', 'Guía', 'Entregada hoy']) expect(aexMappedStage(wording), wording).toBeUndefined();
    // The page shows no codes; the webhook's codes are AEX's API's own.
    expect(statusMap.stage('E', 'entregado')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'aex-paraguay', description: 'Asignado a repartidor para entrega' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
