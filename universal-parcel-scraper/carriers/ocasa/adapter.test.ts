import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, OCASA_ENDPOINT, OcasaTracker } from './adapter.js';
import { ocasaWording, parseOcasa } from './parser.js';
import { ocasaMappedStage, ocasaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '40000000017';
const TRANSIT = 'EC3QX10000001';
const RETURNED = 'ECO0000000123';
const UNKNOWN = 'EC3ZZ00000000';
// Lookups shortly after each fixture's newest event, in UTC.
const MARCH = Date.parse('2026-03-14T15:00:00Z');
const JANUARY = Date.parse('2026-01-03T15:00:00Z');
const SEPTEMBER = Date.parse('2026-09-20T15:00:00Z');
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parseOcasa>) => result.events!.map((event) => [event.local_time, event.description, event.stage]);
// The CAPTCHA step `Tracking/index` serves before the result.
const CAPTCHA = '<html><head><meta name="description" content="Validate Captcha"></head><body><form id="captchaform" action="../Tracking/ValidateCaptcha" method="POST">'
  + `<input type="hidden" id="airbillnumber" name="airbillnumber" value="${UNKNOWN}" /><div class="g-recaptcha" data-sitekey="synthetic"></div></form></body></html>`;
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType: \'interactive\'};</script></body></html>';
const PRIVATE = ['perez', 'PEREZ', 'JUANA', 'TIENDA', 'CALLE', '1234', '9999', 'VILLA INVENTADA', 'Villa Inventada', 'Z999', 'SYNTHETIC-MAPS-KEY',
  'CARLOS', 'GOMEZ', 'MERCADO DE PRUEBA', 'AVENIDA', 'MARIA', 'LOPEZ', 'ANA TORRES', 'PASAJE', 'BARRIO'];

describe('OCASA tracking adapter', () => {
  it('asks the result page once for the whole number through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new OcasaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', now: () => JANUARY }).fetch(' ec3qx 1000-0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://tracking.ocasa.com/TrackingOnline/index?airbillnumber=${TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ocasa', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery in the page’s order as wall clocks, without the recipient, the address, the sender or the centre', () => {
    const result = parseOcasa(page('delivered'), DELIVERED, MARCH);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregamos el envio. Gracias por utilizar el servicio de OCASA para tus entregas.',
      last_update: null, last_update_local: '2026-03-12T16:41:00', expected_delivery: null,
      events: [
        { local_time: '2026-03-12T16:41:00', description: 'Entregamos el envio. Gracias por utilizar el servicio de OCASA para tus entregas.',
          stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-03-12T08:07:00', description: 'Hoy estamos pasando a entregar el envío por el domicilio de destino en el rango horario de 9 a 18 horas.',
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-10T12:25:00', description: 'El pedido llegó al centro de distribución OCASA, responsable de la entrega a destino.',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-09T15:35:00', description: 'El envío ha salido del centro de distribución de OCASA.', stage: 'in_transit', stage_source: 'carrier_map' },
        // A first centre scan can read twelve hours before the pickup listed under it.
        { local_time: '2026-03-08T06:16:00', description: 'El envío ha llegado al centro de distribución OCASA.', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-08T18:16:00', description: 'Pasamos a buscar el envío por el domicilio del remitente y lo estamos llevando a nuestra planta para iniciar el proceso de entrega.',
          stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-03-08T18:16:00', description: 'El envío ya está confirmado para que lo retiremos por el domicilio del remitente.',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
    expect(result.delivered_at).toBeUndefined();
  });

  it('gives each yearless clock the latest year before the lookup, across New Year, and an older one when it is still to come', () => {
    const result = parseOcasa(page('in-transit'), TRANSIT, JANUARY);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_update_local: '2026-01-03T07:40:00' });
    expect(rows(result)).toEqual([
      ['2026-01-03T07:40:00', 'Hoy estamos pasando a entregar el envío por el domicilio de destino en el rango horario de 9 a 18 horas.', 'out_for_delivery'],
      ['2026-01-02T18:35:00', 'El envío ha llegado al centro de distribución OCASA.', 'in_transit'],
      ['2026-01-02T18:35:00', 'Tuvimos un inconveniente ajeno a OCASA que impidió la entrega. Regresaremos nuevamente a visitarte dentro de las próximas 72 horas hábiles.', 'failed_attempt'],
      ['2026-01-02T07:10:00', 'Hoy estamos pasando a entregar el envío por el domicilio de destino en el rango horario de 9 a 18 horas.', 'out_for_delivery'],
      ['2025-12-31T06:25:00', 'El pedido llegó al centro de distribución OCASA, responsable de la entrega a destino.', 'in_transit'],
      ['2025-12-30T18:35:00', 'El envío ha salido del centro de distribución de OCASA.', 'in_transit'],
      ['2025-12-30T09:14:00', 'El envío ha llegado al centro de distribución OCASA.', 'in_transit'],
      ['2025-12-29T17:59:00', 'Pasamos a buscar el envío por el domicilio del remitente y lo estamos llevando a nuestra planta para iniciar el proceso de entrega.', 'accepted'],
      ['2025-12-29T09:00:00', 'El envío ya está confirmado para que lo retiremos por el domicilio del remitente.', 'registered'],
    ]);
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
    // The day after the lookup in Argentina is the latest an event can be.
    expect(parseOcasa(page('in-transit'), TRANSIT, Date.parse('2026-01-02T12:00:00Z')).events!.slice(0, 2).map((event) => event.local_time))
      .toEqual(['2026-01-03T07:40:00', '2026-01-02T18:35:00']);
    expect(parseOcasa(page('in-transit'), TRANSIT, Date.parse('2026-01-02T03:00:00Z')).events!.slice(0, 5).map((event) => event.local_time))
      .toEqual(['2025-01-03T07:40:00', '2025-01-02T18:35:00', '2025-01-02T18:35:00', '2025-01-02T07:10:00', '2024-12-31T06:25:00']);
    // A leap day goes back to the last leap year.
    const leap = page('delivered').replace('12/MAR - 16:41', '29/FEB - 16:41').replace('12/MAR - 08:07', '28/FEB - 08:07')
      .replace('10/MAR', '27/FEB').replace('09/MAR', '26/FEB').replaceAll('08/MAR', '25/FEB');
    expect(parseOcasa(leap, DELIVERED, MARCH).events!.map((event) => String(event.local_time).slice(0, 10)))
      .toEqual(['2024-02-29', '2024-02-28', '2024-02-27', '2024-02-26', '2024-02-25', '2024-02-25', '2024-02-25']);
  });

  it('reads a closed delivery and its return, keeping each event once', () => {
    const result = parseOcasa(page('returned'), RETURNED, SEPTEMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'El envío está en proceso de devolución al remitente.', last_update_local: '2026-09-15T06:51:00' });
    expect(rows(result)).toEqual([
      ['2026-09-15T06:51:00', 'El envío está en proceso de devolución al remitente.', 'returned'],
      ['2026-09-14T06:19:00', 'Te informo que el proceso de envío ha finalizado. Por favor contactate con la marca por la cual realizaste la compra para obtener mayor información', 'exception'],
      ['2026-09-06T22:46:00', 'El envío ha llegado al centro de distribución OCASA.', 'in_transit'],
      ['2026-09-01T18:57:00', 'No se pudo encontrar el domicilio.', 'failed_attempt'],
      ['2026-09-01T06:24:00', 'Hoy estamos pasando a entregar el envío por el domicilio de destino en el rango horario de 9 a 18 horas.', 'out_for_delivery'],
      ['2026-08-31T21:24:00', 'Pasamos por el domicilio de destino y no te encontramos. Regresaremos nuevamente a visitarte dentro de las próximas 72 horas hábiles', 'failed_attempt'],
      ['2026-08-31T07:34:00', 'Hoy estamos pasando a entregar el envío por el domicilio de destino en el rango horario de 9 a 18 horas.', 'out_for_delivery'],
      ['2026-08-29T15:56:00', 'El envío ya está confirmado para que lo retiremos por el domicilio del remitente.', 'registered'],
    ]);
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
  });

  it('stages a new sentence by its heading, then by the shared rules, and leaves unknown wording without a stage', () => {
    const heading = parseOcasa(page('returned').replace('No se pudo encontrar el domicilio.', 'Otra novedad.'), RETURNED, SEPTEMBER);
    expect(heading.events![3]).toEqual({ local_time: '2026-09-01T18:57:00', description: 'Otra novedad.', stage: 'failed_attempt', stage_source: 'carrier_map' });
    const shared = parseOcasa(page('delivered').replace('<p class="ultimoestado">Entregado</p>', '<p class="ultimoestado">Novedad</p>')
      .replace(/Entregamos el envio a [^<]*/, 'El envío fue entregado al destinatario.'), DELIVERED, MARCH);
    expect(shared).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    const unknown = parseOcasa(page('delivered').replace('<p class="ultimoestado">Entregado</p>', '<p class="ultimoestado">Novedad</p>')
      .replace(/Entregamos el envio a [^<]*/, 'Bulto pesado'), DELIVERED, MARCH);
    expect(unknown).toMatchObject({ status: 'out_for_delivery', last_status_text: 'Bulto pesado' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-03-12T16:41:00', description: 'Bulto pesado' });
    // An event without a sentence is described by its heading.
    const bare = parseOcasa(page('delivered').replace(/<p class="descripcion opcionb">[^<]*<\/p>/, ''), DELIVERED, MARCH);
    expect(bare.events![0]).toEqual({ local_time: '2026-03-12T16:41:00', description: 'Entregado', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('drops who took a parcel, phone and ID numbers and the bracketed centre from a sentence, and keeps a branch', () => {
    expect(ocasaWording('Entregamos el envío a J. Perez. Gracias por utilizar el servicio de OCASA para tus entregas.'))
      .toBe('Entregamos el envío. Gracias por utilizar el servicio de OCASA para tus entregas.');
    expect(ocasaWording('Entregamos el envio a Juana Perez')).toBe('Entregamos el envio.');
    expect(ocasaWording('Envío entregado. Recibió: Juana Perez, DNI 12.345.678')).toBe('Envío entregado.');
    expect(ocasaWording('Envío entregado, firmado por Juana Perez')).toBe('Envío entregado');
    expect(ocasaWording('Llamar al 011 4000-0000 para coordinar')).toBe('Llamar al para coordinar');
    expect(ocasaWording('El envío ha llegado al centro de distribución OCASA responsable de la entrega final (Villa Inventada - Argentina).'))
      .toBe('El envío ha llegado al centro de distribución OCASA responsable de la entrega final.');
    const branch = 'El envío está en camino para ser recibido por la sucursal final de destino y llevarlo al domicilio de destino. (Sucursal Centro, Calle 1 de 9 a 18 hs)';
    expect(ocasaWording(branch)).toBe(branch);
    expect(ocasaStage(ocasaWording(branch), 'En camino')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
  });

  it('binds the page to the requested number and rejects pages it cannot read', () => {
    // The tracker pads a short numeric number with zeros, and shows the number it looked up.
    expect(() => parseOcasa(page('delivered').replace(`>\n                      ${DELIVERED}`, '>\n                      040000000017'), DELIVERED, MARCH))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseOcasa(page('delivered'), '40000000018', MARCH)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseOcasa(page('not-found'), TRANSIT, MARCH)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseOcasa(page('in-transit').replace(TRANSIT, 'ec3qx10000001'), TRANSIT, JANUARY)).toMatchObject({ current_stage: 'out_for_delivery' });
    const many = page('delivered').replace(/<li id="lineatiempo" class="opcionb opciongris">[\s\S]*?<\/li>/, (row: string) => row.repeat(301));
    for (const html of [
      page('delivered').replace('<div class="tracking-number">', '<div class="tracking-number">X</div><div class="tracking-number">'),
      page('delivered').replace('cardtimeline', 'cardlist'),
      page('delivered').replace('12/MAR - 16:41', '12/MAR - 24:10'),
      page('delivered').replace('12/MAR - 16:41', '31/FEB - 16:41'),
      page('delivered').replace('12/MAR - 16:41', '12/XYZ - 16:41'),
      page('delivered').replace('12/MAR - 16:41', '2026-03-12 16:41'),
      page('delivered').replace('<p class="ultimoestado">Entregado</p>', ''),
      page('delivered').replace('<p class="ultimahora" >12/MAR - 16:41 hs.</p>', ''),
      page('delivered').replace(/<p class="descripcion opcionb">[^<]*<\/p>/, (sentence: string) => sentence.repeat(2)),
      page('delivered').replace('<p class="ultimoestado">Entregado</p>', '<p class="ultimoestado"></p>').replace(/<p class="descripcion opcionb">[^<]*<\/p>/, ''),
      page('not-found').replace('No hay registros para mostrar.', 'Servicio no disponible'),
      many,
      '<html><body>Mantenimiento</body></html>']) {
      expect(() => parseOcasa(html, html === page('not-found').replace('No hay registros para mostrar.', 'Servicio no disponible') ? UNKNOWN : DELIVERED, MARCH),
        html.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the tracker’s notice with an empty panel as a missing shipment', () => {
    expect(() => parseOcasa(page('not-found'), UNKNOWN, MARCH)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A shipment the panel names exists, even before its first event.
    const named = page('not-found').replace('<div class="mb-1 destinatario"></div>', '<div class="mb-1 destinatario">JUANA PEREZ</div>');
    expect(() => parseOcasa(named, UNKNOWN, MARCH)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    for (const html of [CAPTCHA, CHALLENGE, '<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>']) {
      expect(() => parseOcasa(html, UNKNOWN, MARCH)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes ten to twenty letters and digits only, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['264797352', 'ECOABCDEFGH', '4000000001700000000017', 'EC3QX1000000-1/', '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the notice for an unknown number as not found and recognizes a known shipment, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('in-transit'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('not-found'))).mockResolvedValueOnce(reply(page('in-transit')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-01-03T07:40:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // A page for another number is no answer either way.
    await expect(carrier(fetcher).recognize!('EC3QX10000002')).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a CAPTCHA or challenge served with HTTP 200, redirects, empty pages and oversized replies apart from missing shipments', async () => {
    for (const html of [CAPTCHA, CHALLENGE]) {
      const challenged = vi.fn<typeof fetch>().mockImplementation(async () => reply(html));
      await expect(carrier(challenged).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
      await expect(carrier(challenged).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    }
    const redirected = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302,
      headers: { Location: `/Tracking/index?airbillnumber=${UNKNOWN}` } }));
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

  it('asks OCASA about its EC numbers, routes its links and other layouts to the adapter, and never claims eleven digits', async () => {
    expect(detectCarrierMatch(TRANSIT)).toMatchObject({ confidence: 'low' });
    expect(detectCarrierMatch(TRANSIT).candidates).toContain('ocasa');
    expect(recognitionAskedCarriers(TRANSIT)).toContain('ocasa');
    for (const number of [DELIVERED, RETURNED]) {
      expect(detectCarrierMatch(number).candidates).not.toContain('ocasa');
      expect(recognitionAskedCarriers(number)).not.toContain('ocasa');
    }
    for (const link of [`https://tracking.ocasa.com/Tracking/index?client=&airbillnumber=${DELIVERED}&i=18&url=ocasa`,
      `https://tracking.ocasa.com/TrackingOnline/index?airbillnumber=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'ocasa', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'ocasa' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ocasa', source: 'ocasa', result: { current_stage: 'delivered' } });
    expect(answer.result.receiver_name).toBeUndefined();
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${OCASA_ENDPOINT}?`))).toBe(true);
  });
});

describe('OCASA status vocabulary', () => {
  it('records every sentence and heading the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(ocasaMappedStage(entry.wording), entry.wording).toBe(stage);
      expect(statusMap.stage(null, entry.wording.toLocaleLowerCase('es-AR')), entry.wording).toBe(stage);
    }
    expect(ocasaMappedStage('  EL ENVIO ha llegado al centro de distribucion OCASA (Otra Ciudad - AR) ')).toBe('in_transit');
    for (const wording of ['constructor', 'toString', 'Envío', 'Entregado hoy']) expect(ocasaMappedStage(wording), wording).toBeUndefined();
    expect(statusMap.stage('7', 'entregado')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'ocasa', description: 'No se pudo encontrar el domicilio.' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
  });
});
