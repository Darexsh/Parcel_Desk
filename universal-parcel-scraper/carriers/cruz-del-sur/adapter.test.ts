import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CRUZ_DEL_SUR_ENDPOINT, CruzDelSurTracker } from './adapter.js';
import { normalizeCruzDelSurNumber, parseCruzDelSur } from './parser.js';
import { cruzDelSurMappedStage, cruzDelSurStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '100000000';
const TRANSIT = '200000000';
const UNKNOWN = '900000000';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseCruzDelSur>) => result.events!.map((event) => [event.local_time, event.description, event.location, event.stage]);
// The search page, whose form checks a reCAPTCHA before it opens a result.
const FORM = '<html><head><title>Cruz del Sur</title></head><body><form id="formulario-seguimiento" method="POST"><input type="text" name="nic" />'
  + '<div class="g-recaptcha" data-sitekey="synthetic"></div></form></body></html>';
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType: \'interactive\'};</script></body></html>';
const PRIVATE = ['Juana', 'Perez', 'TIENDA', 'Carlos', 'Gomez', 'MERCADO', 'PUEBLO PRIVADO', 'BARRIO OCULTO', 'VIN', 'Fecha de carga'];

describe('Cruz del Sur tracking adapter', () => {
  it('asks the result page once for the whole NIC through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CruzDelSurTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2000000-00 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.cruzdelsur.com/herramientas_seguimiento_resultado.php?nic=${TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cruz-del-sur', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first as wall clocks with each branch, without the general panel', () => {
    const result = parseCruzDelSur(page('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2026-03-05T15:45:00', expected_delivery: null,
      events: [
        { local_time: '2026-03-05T15:45:00', description: 'Entregado', location: 'Puerto Ficticio', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T09:20:00', description: 'En reparto', location: 'Puerto Ficticio', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T07:50:00', description: 'Llegada de unidad a sucursal destino', location: 'Puerto Ficticio',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-04T01:15:00', description: 'Salida del camión', location: 'Villa Inventada', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T22:30:00', description: 'Cargado en el Camion', location: 'Villa Inventada', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T19:05:00', description: 'Despacho procesado', location: 'Villa Inventada', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T18:40:00', description: 'Recibido en depósito sin procesar', location: 'Villa Inventada',
          stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T09:12:00', description: 'Despacho creado', location: 'Villa Inventada', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
    expect(result.delivered_at).toBeUndefined();
  });

  it('keeps a day without a clock as a date, across New Year, and each event once', () => {
    const result = parseCruzDelSur(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Salida del camión', last_update_local: '2026-01-02T23:30:00' });
    expect(rows(result)).toEqual([
      ['2026-01-02T23:30:00', 'Salida del camión', 'Villa Inventada', 'in_transit'],
      ['2026-01-02T20:45:00', 'Cargado en el Camion', 'Villa Inventada', 'in_transit'],
      ['2025-12-31T08:10:00', 'Despacho procesado', 'Villa Inventada', 'in_transit'],
      ['2025-12-30T17:05:00', 'Recibido en depósito sin procesar', 'Villa Inventada', 'accepted'],
      ['2025-12-30', 'Despacho creado', 'Villa Inventada', 'registered'],
    ]);
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('stages a new wording by the shared rules, leaves unknown wording without a stage and an event without a branch without a place', () => {
    const shared = parseCruzDelSur(page('delivered').replace('8- Entregado', '8- Envío entregado al destinatario'), DELIVERED);
    expect(shared).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    const unknown = parseCruzDelSur(page('delivered').replace('8- Entregado', '8- Bulto pesado'), DELIVERED);
    expect(unknown).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Bulto pesado' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-03-05T15:45:00', description: 'Bulto pesado', location: 'Puerto Ficticio' });
    const placeless = parseCruzDelSur(page('in-transit').replace(/<label class="secondary_color mt-10">[\s\S]*?<\/label>/g, ''), TRANSIT);
    expect(placeless.events!.every((event) => event.location === undefined)).toBe(true);
  });

  it('binds the page to the requested NIC and rejects pages it cannot read', () => {
    expect(() => parseCruzDelSur(page('delivered'), '300000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker reads the NIC as a number and shows it without leading zeros.
    expect(parseCruzDelSur(page('in-transit').replace(`NIC ${TRANSIT}`, 'NIC 20000000'), '020000000')).toMatchObject({ status: 'in_transit' });
    expect(() => parseCruzDelSur(page('in-transit').replace(`NIC ${TRANSIT}`, 'NIC 20000000'), TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const many = page('delivered').replace(/<div class="row full_mobile">\s*<div class="col-md-12">\s*<label class="red_color[\s\S]*?Entregado[\s\S]*?<\/div>\s*<\/div>/,
      (row: string) => row.repeat(301));
    for (const [index, html] of [
      page('delivered').replace(`NIC ${DELIVERED}`, 'NIC'),
      page('delivered').replace('Datos del envío', 'Datos del envío</div><div class="title_section_3">Datos del envío'),
      page('delivered').replace('Línea de seguimiento', 'Seguimiento'),
      page('delivered').replace('Datos generales', 'Línea de seguimiento'),
      page('delivered').replace('05-03-2026', '32-03-2026'),
      page('delivered').replace('05-03-2026', '2026-03-05'),
      page('delivered').replace('15:45 hs', '24:10 hs'),
      page('delivered').replace('15:45 hs', '15.45'),
      page('delivered').replace('8- Entregado', 'Entregado'),
      page('delivered').replace('8- Entregado', '8- '),
      page('delivered').replace(/(<input disabled type="text" value="05-03-2026"[^>]*>)/, '$1$1$1'),
      page('delivered').replace(/<input disabled type="text" value="05-03-2026"[^>]*>/g, ''),
      page('delivered').replace(/(<label class="secondary_color mt-10">[\s\S]*?<\/label>)/, '$1$1'),
      page('not-found').replace('No existe NIC.', 'NIC debe ser numérico.'),
      many,
      '<html><body>Mantenimiento</body></html>'].entries()) {
      expect(() => parseCruzDelSur(html, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the tracker’s notice as a missing shipment, and a shipment without events as no history', () => {
    expect(() => parseCruzDelSur(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const empty = page('in-transit').replace(/<div class="row full_mobile">\s*<div class="col-md-12">\s*<label class="red_color[\s\S]*?<\/div>\s*<\/div>/g, '');
    expect(() => parseCruzDelSur(empty, TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    for (const html of [FORM, CHALLENGE, '<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parseCruzDelSur(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes nine digits other than zeros only, without a request', async () => {
    expect(normalizeCruzDelSurNumber('1000000-00')).toBe(DELIVERED);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['000000000', '10000000', '1000000000', '10000000A', 'NIC', '', '1'.repeat(80)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the notice for an unknown NIC as not found and recognizes a known shipment, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('in-transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('not-found'))).mockResolvedValueOnce(reply(page('in-transit')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-02T23:30:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // A page for another NIC is no answer either way.
    await expect(carrier(fetcher).recognize!('300000000')).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps the search form or a challenge served with HTTP 200, redirects, empty pages and oversized replies apart from missing shipments', async () => {
    for (const html of [FORM, CHALLENGE]) {
      const challenged = vi.fn<typeof fetch>().mockImplementation(async () => reply(html));
      await expect(carrier(challenged).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
      await expect(carrier(challenged).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    }
    const redirected = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302,
      headers: { Location: '/herramientas_seguimiento.php' } }));
    await expect(carrier(redirected).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
    for (const body of ['', '  ']) {
      const empty = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(empty).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(carrier(empty).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
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

  it('routes its result links to the adapter and never claims a bare NIC', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('cruz-del-sur');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('cruz-del-sur');
    for (const link of [`https://www.cruzdelsur.com/herramientas_seguimiento_resultado.php?nic=${DELIVERED}`,
      `https://cruzdelsur.com/herramientas_seguimiento_resultado.php?nic=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'cruz-del-sur', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'cruz-del-sur' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'cruz-del-sur', source: 'cruz-del-sur', result: { current_stage: 'delivered' } });
    expect(answer.result.receiver_name).toBeUndefined();
    expect(answer.result.sender_name).toBeUndefined();
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${CRUZ_DEL_SUR_ENDPOINT}?`))).toBe(true);
  });
});

describe('Cruz del Sur status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(cruzDelSurMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLocaleLowerCase('es-AR')), entry.wording).toBe(entry.stage);
    }
    expect(cruzDelSurMappedStage('  CARGADO en el camión. ')).toBe('in_transit');
    expect(cruzDelSurMappedStage('Recibido en deposito sin procesar')).toBe('accepted');
    for (const wording of ['constructor', 'toString', 'Despacho', 'Entregado hoy']) expect(cruzDelSurMappedStage(wording), wording).toBeUndefined();
    expect(cruzDelSurStage('Bulto pesado')).toBeNull();
    expect(statusMap.stage('7', 'entregado')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'cruz-del-sur', description: 'En reparto' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
  });
});
