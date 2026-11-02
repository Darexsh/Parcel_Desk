import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PAQUETEXPRESS_ENDPOINT, PaquetexpressTracker, paquetexpressTrackingUrl } from './adapter.js';
import { normalizePaquetexpressNumber, parsePaquetexpress } from './parser.js';
import { paquetexpressQuiet, paquetexpressScanStage, paquetexpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '999000000012';
const GUIA = 'SYN01WE100002';
const PARCEL_A = '999000000101';
const PARCEL_B = '999000000102';
const PICKUP = '99900000003';
const REQUEST = '9990000000044';
const ABSENT = '999000000999';
// A parsed fixture that tests change in place.
type Rows = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Rows => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const ACCESS_ERROR = [{ error: 'ERROR', errorDescripcion: 'ERROR DE ACCESSO' }];
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : `Resultado(${JSON.stringify(body)})`,
  { status, headers: { 'Content-Type': 'application/x-javascript' } });
const moved = (location: string, status = 302) => new Response(null, { status, headers: { Location: location } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));
const rows = (result: ReturnType<typeof parsePaquetexpress>) => result.events!.map((event) => [event.time, event.provider_code, event.stage]);
// Everything in the fixtures the adapter must never return.
const PRIVATE = /Tienda Sintetica|REMITENTE|00000 -|Persona Receptora|Colonia Destinataria|Pedido Sintetico|Registro Interno/;
/** A row added to a fixture, a copy of its newest row with these fields. */
const withRow = (list: Rows, fields: Rows): Rows => [...list, { ...list.at(-1), ...fields }];

describe('Paquetexpress tracking adapter', () => {
  it('asks the history service once for the whole number with the page’s token, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PaquetexpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 9990-0000-0012 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://cc.paquetexpress.com.mx/ptxws/rest/api/v1/guia/historico/${DELIVERED}/@1@2@3@4@5?source=WEBPAGE`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'paquetexpress', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(paquetexpressTrackingUrl(GUIA.toLowerCase())).toBe(`${PAQUETEXPRESS_ENDPOINT}${GUIA}/@1@2@3@4@5?source=WEBPAGE`);
  });

  it('reads a delivered parcel newest first, on each branch’s clock, without the people its wording names', () => {
    const result = parsePaquetexpress(fixture('delivered'), DELIVERED);
    const place = { sonora: 'Puerto Ejemplo, Sonora, Mexico', sinaloa: 'Valle Ficticio, Sinaloa, Mexico', capital: 'Ciudad Prueba, Ciudad De Mexico, Mexico' };
    const mapped = { stage_source: 'carrier_map' };
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Mercancía Entregada A Domicilio', last_update: '2026-02-12T13:45:20-06:00',
      expected_delivery: null, delivered_at: '2026-02-12T13:45:20-06:00',
      events: [
        { time: '2026-02-12T13:45:20-06:00', description: 'Mercancía Entregada A Domicilio', location: place.capital, provider_code: 'HDC', stage: 'delivered', ...mapped },
        { time: '2026-02-12T09:15:00-06:00', description: 'En Ruta De Entrega A Domicilio', location: place.capital, provider_code: 'HTC', stage: 'out_for_delivery', ...mapped },
        // The printed date says the 10th; the stamp is the next day's.
        { time: '2026-02-11T08:30:00-06:00', description: 'Recibida En Sucursal destino', location: place.capital, provider_code: 'WHU', stage: 'in_transit', ...mapped },
        { time: '2026-02-10T03:00:00-07:00', description: 'Mercancía En Tránsito', location: place.sinaloa, provider_code: 'TRN', stage: 'in_transit', ...mapped },
        { time: '2026-02-10T01:15:00-07:00', description: 'Recibida En Sucursal de Transbordo', location: place.sinaloa, provider_code: 'WHU', stage: 'in_transit', ...mapped },
        { time: '2026-02-09T14:20:00-07:00', description: 'Mercancía En Tránsito', location: place.sonora, provider_code: 'TRN', stage: 'in_transit', ...mapped },
        { time: '2026-02-09T13:45:00-07:00', description: 'Confirmación De Recolección En Almacen', location: place.sonora, provider_code: 'HCA', stage: 'accepted', ...mapped },
        { time: '2026-02-09T12:10:30-07:00', description: 'Recolección Realizada', location: place.sonora, provider_code: 'HCM', stage: 'accepted', ...mapped },
        { time: '2026-02-09T11:40:00-07:00', description: 'Recolección Planeada', location: place.sonora, provider_code: 'HCP', stage: 'registered', ...mapped },
        { time: '2026-02-09T10:05:10-07:00', description: 'Documentación De Servicios Web', location: place.sonora, provider_code: 'SWB', stage: 'registered', ...mapped },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(PRIVATE);
  });

  it('reads stamps from before Mexico ended daylight saving time an hour earlier, and keeps whole-hour branch clocks only', () => {
    // The service reads every stored clock at UTC-6, so a summer 2019 stamp is an hour late.
    const pickup = fixture('pickup');
    expect(new Date(pickup[2].fechahora).toISOString()).toBe('2019-07-11T18:00:00.000Z');
    expect(rows(parsePaquetexpress(pickup, PICKUP))).toEqual([
      ['2019-07-11T11:00:00-06:00', 'WHU', 'ready_for_pickup'],
      ['2019-07-10T20:30:00-05:00', 'TRN', 'in_transit'],
      ['2019-07-10T12:00:00-05:00', 'BOK', 'accepted'],
    ]);
    expect(rows(parsePaquetexpress(fixture('two-parcels'), PARCEL_B)).slice(0, 2)).toEqual([
      ['2026-03-17T07:05:00-08:00', 'TTM', 'in_transit'],
      ['2026-03-17T08:40:00-05:00', 'WHU', 'in_transit'],
    ]);
    // A branch clock that is not a whole-hour difference from central time gives way to central time.
    expect(parsePaquetexpress(fixture('pickup-request'), REQUEST).events![0]!.time).toBe('2026-04-27T18:00:00-06:00');
    for (const hora of [null, '', '25:10', '7 pm']) {
      const list = fixture('delivered');
      list[0].hora = hora;
      expect(parsePaquetexpress(list, DELIVERED).events!.at(-1)!.time, String(hora)).toBe('2026-02-09T11:05:10-06:00');
    }
    // Midnight between the branch's day and central time's.
    const late = withRow(fixture('delivered'), { fechahora: Date.parse('2026-02-13T06:30:00Z'), hora: '23:30', eventoId: 'XYZ', status: 'Aviso' });
    expect(parsePaquetexpress(late, DELIVERED).events![0]!.time).toBe('2026-02-12T23:30:00-07:00');
  });

  it('keeps the parcel waiting at its branch, and an estimate only while it is on its way and its day has not passed', () => {
    expect(parsePaquetexpress(fixture('pickup'), PICKUP)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Recibida En Sucursal destino', expected_delivery: null });
    const atDestination = fixture('delivered').slice(0, 9);
    expect(parsePaquetexpress(atDestination, DELIVERED)).toMatchObject({ current_stage: 'in_transit', expected_delivery: '2026-02-12' });
    // A parcel delivered to the door waits at no branch.
    const pickupAtDoor = fixture('pickup').map((row: Rows) => ({ ...row, tipoEntrega: 'ENT_EAD' }));
    expect(parsePaquetexpress(pickupAtDoor, PICKUP)).toMatchObject({ current_stage: 'in_transit', expected_delivery: '2019-07-12' });
    const outForDelivery = fixture('delivered').slice(0, 10);
    expect(parsePaquetexpress(outForDelivery, DELIVERED)).toMatchObject({ current_stage: 'out_for_delivery', expected_delivery: null });
    outForDelivery[9].confMostrarPromesaComercial = true;
    expect(parsePaquetexpress(outForDelivery, DELIVERED)).toMatchObject({ expected_delivery: '2026-02-12' });
    for (const promesa of [' 10 de Febrero del 2026', ' 31 de Febrero del 2026', ' 12 of February 2026', null, 20260212]) {
      const list = fixture('delivered').slice(0, 9);
      list[8].promesa = promesa;
      expect(parsePaquetexpress(list, DELIVERED).expected_delivery, String(promesa)).toBeNull();
    }
    const spelled = fixture('delivered').slice(0, 9);
    spelled[8].promesa = '3 De SEPTIEMBRE Del 2026';
    expect(parsePaquetexpress(spelled, DELIVERED).expected_delivery).toBe('2026-09-03');
  });

  it('lets a cancelled pickup move nothing and drops the rows the tracker hides', () => {
    expect(parsePaquetexpress(fixture('pickup-request'), REQUEST)).toMatchObject({ status: 'pending', current_stage: 'registered',
      last_status_text: 'Recolección Planeada', last_update: '2026-04-27T18:00:00-06:00', expected_delivery: '2026-04-30' });
    expect(parsePaquetexpress(fixture('pickup-request'), REQUEST).events![0]).toEqual({ time: '2026-04-27T18:00:00-06:00',
      description: 'Rad Cancelación', location: 'Ciudad Prueba, Ciudad De Mexico, Mexico', provider_code: 'HCC' });
    expect(parsePaquetexpress(fixture('delivered'), DELIVERED).events!.map((event) => event.provider_code)).not.toContain('NRC');
    const hidden = fixture('delivered').filter((row: Rows) => row.eventoId === 'NRC');
    expect(() => parsePaquetexpress(hidden, DELIVERED)).toThrow(NoHistoryError);
  });

  it('cuts a new code’s wording before anyone it may name, and stages it through the shared rules', () => {
    const cases: [Rows, string, string | undefined][] = [
      [{ eventoId: 'XDV', status: 'Devuelta A Remitente Persona Receptora' }, 'Devuelta', 'returned'],
      [{ eventoId: 'XRZ', status: 'Mercancía Rechazada POR Persona Receptora' }, 'Mercancía Rechazada', 'exception'],
      [{ eventoId: 'XNE', status: 'Entrega No Realizada: Persona Receptora ausente' }, 'Entrega No Realizada', 'failed_attempt'],
      [{ eventoId: 'XQQ', status: 'Registro De Ruta, recibió Persona Receptora' }, 'Registro De Ruta', undefined],
      [{ eventoId: 'XQQ', status: 'A Persona Receptora' }, 'XQQ', undefined],
      // A known code keeps its wording and loses only the name.
      [{ eventoId: 'bdl', status: 'Entregada En Sucursal, recibió Persona Receptora' }, 'Entregada En Sucursal', 'delivered'],
      [{ eventoId: 'BOK', status: 'Documentada POR Persona Receptora' }, 'Documentada', 'accepted'],
      [{ eventoId: 'HCM', status: '' }, 'Recolección Realizada', 'accepted'],
      [{ eventoId: 'TRN', status: 'MercancÃ³a En Tránsito' }, 'Mercancóa En Tránsito', 'in_transit'],
    ];
    for (const [fields, description, stage] of cases) {
      const result = parsePaquetexpress(withRow(fixture('delivered'), { fechahora: Date.parse('2026-02-13T15:00:00Z'), ...fields }), DELIVERED);
      expect(result.events![0], fields.status).toMatchObject({ description, provider_code: fields.eventoId.toUpperCase() });
      expect(result.events![0]!.stage, fields.status).toBe(stage);
      if (!stage) expect(result.status, fields.status).toBe('unknown');
      expect(JSON.stringify(result), fields.status).not.toMatch(/Persona Receptora/);
    }
  });

  it('merges a guía’s parcels without letting one delivered parcel settle the other, and reads a parcel code alone', () => {
    const guia = parsePaquetexpress(fixture('two-parcels'), GUIA.toLowerCase());
    expect(guia).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Transbordo De Remolque',
      last_update: '2026-03-18T12:00:00-06:00', expected_delivery: '2026-03-20' });
    expect(guia.delivered_at).toBeUndefined();
    // The rows both parcels share are kept once.
    expect(guia.events!.map((event) => event.provider_code)).toEqual(['HDC', 'HTC', 'TTM', 'WHU', 'TRN', 'BOK', 'SWB']);
    expect(rows(parsePaquetexpress(fixture('two-parcels'), PARCEL_A))[0]).toEqual(['2026-03-18T12:00:00-06:00', 'HDC', 'delivered']);
    expect(parsePaquetexpress(fixture('two-parcels'), PARCEL_B).events!.map((event) => event.provider_code)).toEqual(['TTM', 'WHU', 'BOK', 'SWB']);
    const both = withRow(fixture('two-parcels'), { fechahora: Date.parse('2026-03-19T17:00:00Z'), hora: '11:00', eventoId: 'HDC',
      status: 'Mercancía Entregada A Domicilio, recibió Persona Receptora' });
    expect(parsePaquetexpress(both, GUIA)).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-19T11:00:00-06:00', expected_delivery: null });
  });

  it('counts a reply only when its tracking code, or its guía, is the number asked', () => {
    // A shipper's reference match brings another parcel's rows.
    expect(() => parsePaquetexpress(fixture('delivered'), ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePaquetexpress(fixture('delivered'), 'SYN01WE999999')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A tracking code is never compared with a guía, nor a guía with a tracking code.
    const crossed = fixture('delivered').map((row: Rows) => ({ ...row, guia: ABSENT, rastreo: 'SYN01WE999999' }));
    expect(() => parsePaquetexpress(crossed, ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePaquetexpress(crossed, 'SYN01WE999999')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = [...fixture('pickup'), ...fixture('delivered')];
    expect(parsePaquetexpress(mixed, PICKUP).events).toHaveLength(3);
  });

  it('reads an empty list as not found and a refused token as inconclusive', () => {
    expect(() => parsePaquetexpress([], ABSENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePaquetexpress(ACCESS_ERROR, ABSENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePaquetexpress([...fixture('delivered'), { error: 'ERROR' }], DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects replies it cannot read', () => {
    const changed = (fields: Rows) => withRow(fixture('delivered'), fields);
    for (const payload of [null, {}, 'Resultado([])', [null], [[]], Array.from({ length: 501 }, () => fixture('delivered')[0]),
      changed({ fechahora: null }), changed({ fechahora: '1770656710000' }), changed({ fechahora: 0 }), changed({ fechahora: 1.5e12 + 0.5 }),
      changed({ status: { text: 'Mercancía En Tránsito' } }), changed({ rastreo: [DELIVERED] }), changed({ eventoId: '', status: '' })]) {
      expect(() => parsePaquetexpress(payload, DELIVERED), JSON.stringify(payload).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('caps the history it returns', () => {
    const long = Array.from({ length: 130 }, (_, index) => ({ ...fixture('delivered')[5], hora: null, fechahora: Date.parse('2026-02-10T08:00:00Z') + index * 60_000 }));
    const result = parsePaquetexpress(long, DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update: '2026-02-10T04:09:00-06:00' });
  });

  it('takes tracking codes and guías only, without a request', async () => {
    expect(normalizePaquetexpressNumber(' 9990 0000 0012 ')).toBe(DELIVERED);
    expect(normalizePaquetexpressNumber('syn01we100002')).toBe(GUIA);
    const fetcher = vi.fn<typeof fetch>();
    // References, two numbers joined, and numbers of other shapes.
    for (const number of ['Orden 0001', 'PEDIDO1234', '123456789', '123456789012345', `${DELIVERED}/${PICKUP}`,
      `${DELIVERED}-${PARCEL_A}`, 'SYN1WE100002', 'SYN01WE123', 'SYN01W1000020', '', '9'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads an empty list as unknown and recognizes a known parcel by its newest scan, from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('pickup-request'))).mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply([]));
    await expect(carrier(fetcher).recognize!(REQUEST)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-28T00:00:00.000Z' });
    await expect(carrier(fetcher).recognize!(ABSENT)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const body of [fixture('delivered'), ACCESS_ERROR]) {
      const other = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(other).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
  });

  it.each([[400, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('', status));
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps redirects, challenges, pages and oversized replies apart from missing parcels', async () => {
    for (const response of [() => moved('https://www.paquetexpress.com.mx/'), () => moved('/', 301), () => new Response(null, { status: 307 })]) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
      await expect(carrier(fetcher).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(carrier(fetcher).recognize!(ABSENT)).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const challenge = vi.fn<typeof fetch>().mockImplementation(async () =>
      reply('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'));
    await expect(carrier(challenge).track({ number: ABSENT })).rejects.toMatchObject({ kind: 'challenge' });
    for (const body of ['', '[]', 'Resultado(', 'Resultado([)', '<html><head><title>Mantenimiento</title></head><body>Volvemos pronto</body></html>']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: ABSENT }), body).rejects.toMatchObject({ kind: 'schema' });
    }
    const spaced = vi.fn<typeof fetch>().mockResolvedValue(reply(` Resultado(${JSON.stringify(fixture('pickup'))});\n`));
    await expect(carrier(spaced).track({ number: PICKUP })).resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1_100_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('pickup')));
    await expect(carrier(flaky).track({ number: PICKUP })).resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('pickup')));
    await expect(carrier(immediate).track({ number: PICKUP }, { signal: AbortSignal.abort(new Error('cancelled')) }))
      .rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: PICKUP }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: PICKUP }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('asks Paquetexpress about a guía and routes a tracking code to it when the caller names the carrier', async () => {
    for (const number of [GUIA, 'syn01we10002', 'SYN01WE1000002']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['paquetexpress']) });
      expect(recognitionAskedCarriers(number), number).toContain('paquetexpress');
    }
    // Tracking codes share their lengths with other carriers, and a guía's sequence is five to seven digits.
    for (const number of [DELIVERED, PICKUP, REQUEST, 'SYN01WE1000', 'SYN01WE10000002', 'SYN1WE100002']) {
      expect(detectCarrierMatch(number)?.carrier, number).not.toBe('paquetexpress');
      expect(detectCarrierMatch(number).candidates, number).not.toContain('paquetexpress');
      expect(recognitionAskedCarriers(number), number).not.toContain('paquetexpress');
    }
    for (const link of [`https://www.paquetexpress.com.mx/rastreo/${DELIVERED}`, `https://www.paquetexpress.com.mx/en/rastreo/${DELIVERED}/`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'paquetexpress', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'paquetexpress' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'paquetexpress', source: 'paquetexpress', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === paquetexpressTrackingUrl(DELIVERED))).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(PRIVATE);
  });
});

describe('Paquetexpress status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      const wording = normalizeStatusWording(entry.wording);
      if (entry.code === 'WHU') {
        // The delivery type decides a branch's receipt, so the code alone gets no stage.
        expect(paquetexpressStage(entry.code, entry.wording, 'ENT_EAD'), entry.wording).toEqual({ stage, source: 'carrier_map' });
        expect(statusMap.stage(entry.code, wording)).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'paquetexpress', providerCode: entry.code, description: entry.wording }))
          .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
        continue;
      }
      expect(paquetexpressScanStage(entry.code), entry.code).toBe(stage);
      expect(paquetexpressQuiet(entry.code), entry.code).toBe(stage === undefined);
      expect(statusMap.stage(entry.code, wording), entry.code).toBe(stage);
      expect(statusMapAnswer({ carrier: 'paquetexpress', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(paquetexpressStage('WHU', 'Recibida En Sucursal destino', 'ENT_OCU')).toEqual({ stage: 'ready_for_pickup', source: 'carrier_map' });
    expect(paquetexpressStage('WHU', 'Recibida En Sucursal de Transbordo', 'ENT_OCU')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'paquetexpress', providerCode: 'NRC', description: 'Registro' })).toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    for (const code of ['constructor', 'toString', 'HD', 'HDCX']) expect(paquetexpressScanStage(code), code).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'paquetexpress', providerCode: 'HDR', description: 'Mercancía En Tránsito' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'paquetexpress', providerCode: null, description: 'Mercancía En Tránsito' })).toEqual({ kind: 'unknown' });
  });
});
