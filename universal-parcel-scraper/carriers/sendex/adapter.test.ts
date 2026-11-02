import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SENDEX_TRACKER, SendexTracker } from './adapter.js';
import { normalizeSendexNumber, parseSendex } from './parser.js';
import { sendexMappedStage, sendexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '300000000011';
const TRANSIT = '300000000029';
const UNKNOWN = '300000000037';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const rows = (result: ReturnType<typeof parseSendex>) => result.events!.map((event) => [event.local_time, event.location ?? null, event.description, event.stage ?? null]);
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType: \'interactive\'};</script></body></html>';
// What the fixtures hold about the recipient, the destination and the guía that the result must not.
const PRIVATE = ['MARIA', 'EJEMPLO', 'JUAN', 'INVENTADO', 'MUESTRA', 'ESTADO DE PRUEBA', 'CIUDAD INVENTADA', 'VILLA INVENTADA', '00000', '99999',
  'Recibió', 'ANTICIPADA', 'CONTRATO', 'PAQUETE', '03/03/2026', '14/09/2026'];
/** A page whose movement rows, as markup, an edit rearranged. */
const movements = (name: string, edit: (rows: string[]) => string[]) => {
  const $ = load(page(name));
  const container = $('.sdx-movements__container');
  const listed = container.children('.sdx-movements__row').toArray().map((node) => $.html(node));
  container.children('.sdx-movements__row').remove();
  container.append(edit(listed).join('\n'));
  return $.html();
};
const notice = (text: string, kind = 'sendex-notice') => page('not-found')
  .replace('<div class="sendex-notice">No se encontraron resultados para las guías ingresadas.</div>', `<div class="${kind}">${text}</div>`);

describe('Sendex tracking adapter', () => {
  it('posts the whole guía to the tracking page once, through the supplied transport, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SendexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 3000 0000 0029 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SENDEX_TRACKER);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe(`guias=${TRANSIT}`);
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sendex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivery newest first as wall clocks at their offices, once each, without the recipient, the receiver or the destination', () => {
    const result = parseSendex(page('delivered'), DELIVERED);
    const at = 'SUCURSAL DESTINO DE PRUEBA (SDX)';
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADO', last_update: null, last_update_local: '2026-03-05T13:47:00', expected_delivery: null,
      service_name: 'REGULAR', destination_country: 'MX',
      events: [
        { local_time: '2026-03-05T13:47:00', location: at, description: 'ENTREGADO', stage: 'delivered', stage_source: 'carrier_map' },
        // The page lists the round's two movements of one minute in the order they happened.
        { local_time: '2026-03-05T09:30:00', location: at, description: 'EN RUTA PARA ENTREGA', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T09:30:00', location: at, description: 'ENVÍO SALE DE COP', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T06:05:00', location: at, description: 'RECIBIDO EN OFICINA DESTINO', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-04T14:05:00', location: 'CENTRO OP PRUEBA NORTE', description: 'EN TRÁNSITO', stage: 'in_transit', stage_source: 'carrier_map' },
        // The movement the page lists twice is kept once.
        { local_time: '2026-03-03T22:40:00', location: 'CENTRO OP PRUEBA NORTE', description: 'EN TRÁNSITO', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T10:12:00', location: 'SUCURSAL ORIGEN DE PRUEBA (SDX)', description: 'RECIBIDO EN OFICINA', stage: 'accepted',
          stage_source: 'carrier_map' },
      ],
    });
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
  });

  it('reads an older guía’s sentences and takes the commitment date as the estimate until the delivery', () => {
    const result = parseSendex(page('in-transit'), TRANSIT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'EL ENVÍO SE ENCUENTRA EN EL VEHÍCULO PARA SU ENTREGA', last_update: null, last_update_local: '2026-09-17T09:02:00',
      expected_delivery: '2026-09-18', service_name: 'REGULAR', destination_country: 'MX' });
    expect(rows(result).map(([local, , description, stage]) => [local, description, stage])).toEqual([
      ['2026-09-17T09:02:00', 'EL ENVÍO SE ENCUENTRA EN EL VEHÍCULO PARA SU ENTREGA', 'out_for_delivery'],
      ['2026-09-16T14:38:00', 'ENVÍO CON INTENTO DE ENTREGA NO EXITOSO', 'failed_attempt'],
      ['2026-09-16T09:15:00', 'EL ENVÍO SE ENCUENTRA EN EL VEHÍCULO PARA SU ENTREGA', 'out_for_delivery'],
      ['2026-09-16T09:15:00', 'ENVÍO SALE DE COP', 'in_transit'],
      ['2026-09-16T04:02:00', 'RECIBIDO EN OFICINA DESTINO', 'in_transit'],
      ['2026-09-15T15:30:00', 'EL ENVÍO SALIÓ HACIA LA OFICINA DESTINO O DE ENLACE', 'in_transit'],
      ['2026-09-15T11:46:00', 'EL ENVÍO LLEGO A LA OFICINA DESTINO O DE ENLACE', 'in_transit'],
      ['2026-09-14T20:19:00', 'EL ENVÍO SALIÓ HACIA LA OFICINA DESTINO O DE ENLACE', 'in_transit'],
      ['2026-09-14T20:11:00', 'EL ENVÍO LLEGÓ A LAS INSTALACIONES DE SENDEX', 'in_transit'],
      ['2026-09-14T17:05:00', 'EL ENVÍO FUE RECOLECTADO EN ORIGEN POR SENDEX', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    for (const kept of PRIVATE) expect(JSON.stringify(result), kept).not.toContain(kept);
    // A commitment with a clock gives its day; an empty field or another layout gives none.
    expect(parseSendex(page('in-transit').replace('18/09/2026', '18/09/2026 18:00'), TRANSIT).expected_delivery).toBe('2026-09-18');
    for (const committed of ['—', '', '2026-09-18', '31/09/2026']) {
      expect(parseSendex(page('in-transit').replace('18/09/2026', committed), TRANSIT).expected_delivery, committed).toBeNull();
    }
    // A delivered parcel has no estimate.
    expect(parseSendex(page('delivered').replace('<span class="sdx-cell__value">—</span>', '<span class="sdx-cell__value">06/03/2026</span>'),
      DELIVERED).expected_delivery).toBeNull();
    // A history listed newest first is kept in that order.
    expect(rows(parseSendex(movements('in-transit', (listed) => listed.reverse()), TRANSIT))).toEqual(rows(result));
  });

  it('stages an unknown wording by the shared rules, or leaves it without a stage, and keeps a country it cannot code by name', () => {
    const shared = parseSendex(page('delivered').replace('>ENTREGADO<', '>ENVÍO ENTREGADO AL DESTINATARIO<'), DELIVERED);
    expect(shared).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    const unknown = parseSendex(page('delivered').replace('>ENTREGADO<', '>BULTO PESADO<'), DELIVERED);
    expect(unknown).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'BULTO PESADO' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-03-05T13:47:00', location: 'SUCURSAL DESTINO DE PRUEBA (SDX)', description: 'BULTO PESADO' });
    // An empty office gives no place.
    expect(parseSendex(page('delivered').replace('>SUCURSAL ORIGEN DE PRUEBA (SDX)<', '>—<'), DELIVERED).events!.at(-1))
      .not.toHaveProperty('location');
    const elsewhere = parseSendex(page('delivered').replace('>MEXICO<', '>TIERRA DE PRUEBA<').replace('>REGULAR<', '>—<'), DELIVERED);
    expect(elsewhere).toMatchObject({ destination_country_name: 'TIERRA DE PRUEBA' });
    expect(elsewhere).not.toHaveProperty('destination_country');
    expect(elsewhere).not.toHaveProperty('service_name');
  });

  it('binds the page to the requested guía and rejects pages it cannot read', () => {
    expect(() => parseSendex(page('delivered'), TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Sendex answered for another guía' }));
    const many = movements('delivered', (listed) => Array.from({ length: 501 }, (_, index) => listed[index % listed.length]!));
    for (const html of [
      page('delivered').replace('Número de guía', 'Guía'),
      page('delivered').replace('>Tipo de Servicio<', '>País<'),
      page('delivered').replace('<div class="sdx-card">', '<div class="sdx-card"></div><div class="sdx-card">'),
      page('delivered').replace('elementor-widget-sendex_form', 'elementor-widget-sendex_resultados'),
      page('delivered').replace('05/03/2026 13:47', '05/03/2026 24:10'),
      page('delivered').replace('05/03/2026 13:47', '31/02/2026 13:47'),
      page('delivered').replace('05/03/2026 13:47', '2026-03-05 13:47'),
      page('delivered').replace('05/03/2026 13:47', '05/03/2026 13:47:00'),
      page('delivered').replace('>ENTREGADO<', '>—<'),
      page('delivered').replace('<span class="sdx-movements__label">Oficina</span>', '<span class="sdx-movements__label">Sucursal</span>'),
      many,
      notice('Ingresa al menos una guía completa (mínimo 12 dígitos).'),
      notice('Servicio no disponible'),
      notice(''),
      '<html><head><title>Rastreo &#8211; Sendex by Coordi</title></head><body><form class="sendex-form"></form></body></html>',
    ]) {
      expect(() => parseSendex(html, DELIVERED), html.slice(-200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads only the tracker’s notice as a missing guía, and keeps its failure, a card without movements and block pages apart', () => {
    expect(() => parseSendex(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSendex(notice('Error de conexión al consultar la guía.', 'sendex-error'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const bare = movements('delivered', () => []);
    expect(bare).not.toContain('sdx-movements__row');
    expect(() => parseSendex(bare, DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    for (const html of [CHALLENGE, '<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>',
      '<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>']) {
      expect(() => parseSendex(html, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });

  it('takes twelve digits only, without a request, and leaves eleven-digit Coordinadora guías alone', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['30000000001', '3000000000110', 'SX0000000011', `${DELIVERED}/`, '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSendexNumber(' 3000-0000-0011 ')).toBe(DELIVERED);
  });

  it('reads the notice for an unknown guía as not found and recognizes a known one, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('delivered'))).mockResolvedValueOnce(reply(page('not-found')))
      .mockResolvedValueOnce(reply(page('not-found'))).mockResolvedValueOnce(reply(page('in-transit')));
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T13:47:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // A page for another guía is no answer either way.
    await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(UNKNOWN)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps a block page served with HTTP 200, redirects, empty pages and oversized replies apart from missing guías', async () => {
    const challenged = vi.fn<typeof fetch>().mockImplementation(async () => reply(CHALLENGE));
    await expect(carrier(challenged).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(challenged).recognize!(UNKNOWN)).rejects.toMatchObject({ kind: 'challenge' });
    const redirected = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 301, headers: { Location: 'https://sendex.coordi.com/' } }));
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
    await expect(carrier(immediate).track({ number: UNKNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
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

  it('claims no twelve digits, reads the former tracker’s links, and routes a guía filed under Sendex to the adapter', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('sendex');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('sendex');
    for (const link of [`http://www.sendex.mx/Home/RastreoRapido?guias=${DELIVERED}`, `https://sendex.mx/Rastreo/Rastreo/${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'sendex', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'sendex' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'sendex', source: 'sendex', result: { current_stage: 'delivered' } });
    expect(answer.result.receiver_name).toBeUndefined();
    expect(fetcher.mock.calls.every(([url]) => String(url) === SENDEX_TRACKER)).toBe(true);
  });
});

describe('Sendex status vocabulary', () => {
  it('maps every wording the tracker was seen to use, with or without its accents', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      if (!entry.stage) {
        expect(sendexMappedStage(entry.wording), entry.wording).toBeUndefined();
        continue;
      }
      expect(sendexMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(sendexStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'sendex', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(sendexMappedStage('el envio llego a las instalaciones de sendex')).toBe('in_transit');
    expect(statusMap.stage('X1', 'entregado')).toBeUndefined();
    expect(sendexStage('NOVEDAD SINTÉTICA')).toBeNull();
    expect(statusMapAnswer({ carrier: 'sendex', providerCode: null, description: 'NOVEDAD SINTÉTICA' })).toEqual({ kind: 'unknown' });
  });
});
