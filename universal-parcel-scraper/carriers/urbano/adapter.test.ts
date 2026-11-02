import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, URBANO_API, UrbanoTracker, urbanoLookupBody } from './adapter.js';
import { normalizeUrbanoNumber, parseUrbano, urbanoWording } from './parser.js';
import { statusMap, urbanoMappedStage, urbanoStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The delivered shipment's tracking code and the in-transit one's guía barcode.
const DELIVERED = '10000001';
const IN_TRANSIT = 'WYB100000022';
const UNKNOWN = 'G10000003';

type Row = Record<string, unknown>;
type Shipment = Row & { movimientos: Row[] };
type Reply = Row & { data: Shipment[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
/** A fixture with its shipment, or the whole reply, changed in place by `change`. */
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const payload = fixture(name);
  change(payload.data[0]!, payload);
  return payload;
};
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Urbano HTTP adapter', () => {
  it('posts the whole number to the tracking page’s lookup once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new UrbanoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' wyb-1000 0002 2 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(URBANO_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ guia_barra: IN_TRANSIT, flag_seller: 0 });
    expect(urbanoLookupBody(IN_TRANSIT)).toBe(String(init!.body));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'urbano', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('lists the movements newest first as wall clocks and stages them by Urbano’s codes', () => {
    const result = parseUrbano(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGAMOS TU PEDIDO: Entrega A Titular', last_update: null, last_update_local: '2026-05-08T15:47:00',
      expected_delivery: null, weight_kg: 2 });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-05-08T15:47:00', 'Arequipa', 'ENTREGAMOS TU PEDIDO: Entrega A Titular', 'EN', 'delivered'],
      ['2026-05-08T09:12:00', 'Arequipa', 'SALIO A ENTREGARSE', 'ER', 'out_for_delivery'],
      // A run kept with its day only.
      ['2026-05-07', 'Arequipa', 'SALIO A ENTREGARSE', 'ER', 'out_for_delivery'],
      ['2026-05-06T13:20:00', 'Arequipa', 'INTENTAMOS ENTREGARTE: Direccion Incorrecta', 'CV', 'failed_attempt'],
      // The arrival listed twice is kept once.
      ['2026-05-06T08:46:00', 'Arequipa', 'LLEGO A LA CIUDAD DESTINO', 'AR', 'in_transit'],
      ['2026-05-05T20:12:00', 'LIMA', 'DESPACHAMOS A SU CIUDAD', 'DD', 'in_transit'],
      ['2026-05-05T20:06:00', 'LIMA', 'Entro a Pre-Embarque', 'CK', 'in_transit'],
      // The movement with only an internal note is left out.
      ['2026-05-04T21:26:00', 'LIMA', 'RECIBIMOS EN ORIGEN', 'AO', 'accepted'],
      ['2026-05-04T10:28:00', 'LIMA', 'PEDIDO CREADO', 'PU', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.time === undefined && event.point === undefined))
      .toBe(true);
  });

  it('keeps no recipient, signatory, contact, address, courier, vehicle, visit point, contents or sender', () => {
    const json = JSON.stringify(parseUrbano(fixture('delivered'), DELIVERED));
    expect(json).not.toMatch(/Persona|Per\*|00000000|900000000|example\.com|Calle Ejemplo|CAYMA|\*\*\*|ABC|XYZ|Visita|llamar|-16\.|-71\.|Articulo|Tienda|TIENDA|PCK|3000001|400001|WYB|10000001/);
  });

  it('reads a parcel on its way, asked by its guía barcode, with its estimate', () => {
    const result = parseUrbano(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'DESPACHAMOS A SU CIUDAD', last_update_local: '2026-09-29T19:40:00', expected_delivery: '2026-09-30', weight_kg: 0.75 });
    expect(result.events).toHaveLength(4);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-09-28T11:15:00', location: 'LIMA', description: 'PEDIDO CREADO', stage: 'registered' });
    // The page's own estimate field comes first; an invalid day is no estimate.
    expect(parseUrbano(changed('in-transit', (shipment) => { shipment.fec_estimada = '2026-10-01'; }), IN_TRANSIT).expected_delivery).toBe('2026-10-01');
    expect(parseUrbano(changed('in-transit', (shipment) => { shipment.fecha_estimada = '2026-02-30'; }), IN_TRANSIT).expected_delivery).toBeNull();
    expect(parseUrbano(changed('in-transit', (shipment) => { shipment.peso = '0.00'; }), IN_TRANSIT)).not.toHaveProperty('weight_kg');
  });

  it('takes the page’s label for a return or a wait for collection over the scans', () => {
    expect(parseUrbano(changed('in-transit', (shipment) => { shipment.id_proceso = 21; }), IN_TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map', last_status_text: 'DESPACHAMOS A SU CIUDAD' });
    expect(parseUrbano(changed('in-transit', (shipment) => { shipment.id_proceso = '23'; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map', expected_delivery: '2026-09-30' });
    // A label for collection does not step a delivered parcel back; a return still decides.
    expect(parseUrbano(changed('delivered', (shipment) => { shipment.id_proceso = 24; }), DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    expect(parseUrbano(changed('delivered', (shipment) => { shipment.id_proceso = 21; }), DELIVERED)).toMatchObject({ current_stage: 'returned' });
    // Other steps of the rail follow the scans.
    expect(parseUrbano(changed('in-transit', (shipment) => { shipment.id_proceso = 5; }), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    // A code the map does not know falls to the shared wording rules, and a scan neither stages has no stage.
    const unknown = parseUrbano(changed('in-transit', (shipment) => {
      shipment.movimientos = [{ ...shipment.movimientos[0]!, chk: 'ZZ', detalle: 'Nota de muestra' }];
    }), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Nota de muestra' });
    expect(unknown).not.toHaveProperty('current_stage');
    expect(unknown.events![0]).toMatchObject({ provider_code: 'ZZ' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
  });

  it('takes signatories, ID documents, e-mail addresses and phone numbers out of the wording', () => {
    expect(urbanoWording('Firma:Persona Ejemplo (DNI:00000000)')).toBe('');
    expect(urbanoWording('Entrega A Titular - Firma: Persona Ejemplo')).toBe('Entrega A Titular');
    expect(urbanoWording('Entregado a Persona Ejemplo')).toBe('');
    expect(urbanoWording('Pedido recibido por Persona Ejemplo')).toBe('Pedido');
    expect(urbanoWording('Cliente no contesta al 900 000 000, persona@example.com')).toBe('Cliente no contesta al');
    expect(urbanoWording('RECIBIMOS EN ORIGEN')).toBe('RECIBIMOS EN ORIGEN');
    expect(urbanoWording('  Entrega   A Titular ')).toBe('Entrega A Titular');
    // A signatory in a movement's sub-status leaves its heading alone.
    const signed = parseUrbano(changed('delivered', (shipment) => { shipment.movimientos[0]!.sub_estado = 'Firma:Persona Ejemplo (DNI:00000000)'; }), DELIVERED);
    expect(signed.events![0]).toMatchObject({ description: 'ENTREGAMOS TU PEDIDO', stage: 'delivered' });
    // Without a heading, the sub-status alone is the wording.
    const sub = parseUrbano(changed('delivered', (shipment) => { shipment.movimientos[3]!.detalle = ''; }), DELIVERED);
    expect(sub.events![3]).toMatchObject({ description: 'Direccion Incorrecta', provider_code: 'CV', stage: 'failed_attempt' });
  });

  it('reads a number the tracker holds nothing for as inconclusive, never as not found', () => {
    expect(() => parseUrbano(fixture('not-found'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseUrbano({ success: true, message: '', code_error: 0, data: [{ error_sql: '-2', guia_barra: UNKNOWN }] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
    expect(() => parseUrbano({ success: false, message: 'Error', code_error: 1, data: [] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseUrbano({ success: true, message: '', code_error: 1, data: [] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseUrbano(changed('delivered', (shipment) => { shipment.movimientos = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseUrbano(changed('delivered', (shipment) => { delete (shipment as Row).movimientos; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('keeps only the shipment that names the whole number asked', () => {
    expect(() => parseUrbano(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Urbano answered for another shipment' }));
    expect(() => parseUrbano(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Urbano answered for another shipment' }));
    // The tracking code, the barcode and the guía text each name the shipment.
    expect(parseUrbano(fixture('in-transit'), '10000002').events).toHaveLength(4);
    expect(parseUrbano(changed('in-transit', (shipment) => { shipment.guia_barra = ''; }), IN_TRANSIT).events).toHaveLength(4);
    // A longer number holding the one asked is another shipment.
    expect(() => parseUrbano(changed('in-transit', (shipment) => { shipment.rastreo = `9${DELIVERED}`; shipment.cod_seguimiento = ''; }), DELIVERED))
      .toThrow(expect.objectContaining({ message: 'Urbano answered for another shipment' }));
    expect(() => parseUrbano(changed('in-transit', (shipment, payload) => { payload.data.push(structuredClone(shipment)); }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Urbano returned several shipments under the number' }));
    // An entry for another number asked beside it is left aside.
    const beside = changed('in-transit', (_shipment, payload) => { payload.data.unshift({ error_sql: -1, guia_barra: UNKNOWN } as never); });
    expect(parseUrbano(beside, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete body.success; },
      (_shipment: Shipment, body: Reply) => { body.success = 'true'; },
      (_shipment: Shipment, body: Reply) => { body.data = {} as never; },
      (_shipment: Shipment, body: Reply) => { body.data = ['shipment'] as never; },
      (_shipment: Shipment, body: Reply) => { body.data = Array.from({ length: 21 }, () => body.data[0]!); },
      (shipment: Shipment) => { delete shipment.error_sql; },
      (shipment: Shipment) => { shipment.error_sql = 'cero'; },
      (shipment: Shipment) => { for (const key of ['rastreo', 'cod_seguimiento', 'guia_barra', 'guia_texto']) delete shipment[key]; },
      (shipment: Shipment) => { shipment.rastreo = ['10000002']; },
      (shipment: Shipment) => { shipment.movimientos = 'scans' as never; },
      (shipment: Shipment) => { shipment.movimientos = Array.from({ length: 301 }, () => shipment.movimientos[0]!); },
      (shipment: Shipment) => { shipment.movimientos[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.movimientos[0]!.detalle = ['DESPACHAMOS']; },
      (shipment: Shipment) => { shipment.movimientos[0]!.auditoria = '2026-09-29T19:40:00'; },
      (shipment: Shipment) => { shipment.movimientos[0]!.auditoria = '2026-09-29 24:00'; },
      (shipment: Shipment) => { shipment.movimientos[0]!.auditoria = '2026-02-30 10:00'; },
      (shipment: Shipment) => { shipment.movimientos[0]!.auditoria = '29/09/2026 19:40'; },
      (shipment: Shipment) => { delete shipment.movimientos[0]!.auditoria; },
    ]) {
      expect(() => parseUrbano(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a browser check, a refusal and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    // Laravel answers a route it does not have with HTTP 500; a gone route and a redirect are moves too.
    await expect(lookup('{"message":"The route api/v1/trackingGlobal could not be found.","code":500}', { status: 500 }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.urbano.com.pe/' } })).rejects.toMatchObject({ kind: 'transport' });
    // Any other failure of the service is inconclusive.
    await expect(lookup('{"message":"Server Error"}', { status: 500 })).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    await expect(lookup('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>',
      { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"message":"Too Many Attempts."}', { status: 429, headers: { 'Retry-After': '30' } }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    await expect(lookup('<html><title>Urbano</title></html>', { headers: { 'Content-Type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('refuses what is not an Urbano number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['10001', 'SAMPLETRACKING', 'G1000000,G1000001', '0'.repeat(31), '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeUrbanoNumber(' g-1000 0003 ')).toBe(UNKNOWN);
  });

  it('declares no recognition: the tracker never says a number is unknown', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a number filed under Urbano to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'urbano' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'urbano', source: 'urbano', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === URBANO_API)).toBe(true);
  });
});

describe('Urbano status vocabulary', () => {
  it('records every scan code the map knows with the stage it gives', () => {
    const coded = (statuses.entries as { code?: string; wording: string; stage: string }[]).filter((entry) => entry.code);
    expect(coded.length).toBeGreaterThan(0);
    for (const entry of coded) {
      expect(statusMapAnswer({ carrier: 'urbano', providerCode: entry.code!, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(urbanoStage(entry.code!, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown code to the shared rules', () => {
    expect(statusMap.stage('ZZ', 'pedido devuelto al remitente')).toBeUndefined();
    expect(statusMap.stage(null, 'entregamos tu pedido')).toBeUndefined();
    expect(urbanoMappedStage('zz')).toBeUndefined();
    expect(urbanoMappedStage('en')).toBe('delivered');
    expect(urbanoStage('ZZ', 'Pedido devuelto al remitente')).toEqual({ stage: 'returned', source: 'wording:language' });
    expect(urbanoStage('ZZ', 'Nota de muestra')).toBeNull();
    expect(statusMapAnswer({ carrier: 'urbano', providerCode: 'ZZ', description: 'Nota de muestra' })).toEqual({ kind: 'unknown' });
  });
});
