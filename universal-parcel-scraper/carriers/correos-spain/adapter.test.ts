import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../app.js';
import { IndeterminateError, NotFoundError, SchemaError, InvalidInputError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import {
  normalizeCorreosSpainTrackingNumber,
  correosSpainTrackingUrl,
  parseCorreosSpainExpeditionResponse,
  parseCorreosSpainTrackingResponse,
  CorreosSpainTracker,
  adapter,
} from './adapter.js';
import { correosOriginZone } from './clock.js';
import { classifyCorreosSpainStatus } from './status.js';

// All identifiers and timestamps below are synthetic. Event codes and Spanish
// wordings reuse the vendor's fixed texts confirmed against a real parcel by
// the prior-art client, so classification exercises production prose rather
// than paraphrases.
const TRACKING_NUMBER = 'PR123456789012345C';
// An expedition code and the parcel code it stands for: the same fifteen
// characters, then the parcel's seven further digits and its own check letter.
const EXPEDITION = 'PL00ZZ000000001Z';
const PARCEL = 'PL00ZZ0000000010100000Y';
const DELIVERED = JSON.parse(
  readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function event(code: string, fecha: string, horEvento: string, resumen: string) {
  return { codEvento: code, fecEvento: fecha, horEvento, desTextoResumen: resumen, desTextoAmpliado: resumen };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(DELIVERED), ...overrides };
}

function response(value: unknown, status = 200) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Correos Spain tracking normalization', () => {
  it('accepts Correos-issued codes case-insensitively and rejects the rest', () => {
    expect(normalizeCorreosSpainTrackingNumber('pr123456789012345c')).toBe(TRACKING_NUMBER);
    expect(normalizeCorreosSpainTrackingNumber('PQ0011223344ES')).toBe('PQ0011223344ES');
    for (const raw of ['ABC', '123', '']) {
      expect(() => normalizeCorreosSpainTrackingNumber(raw)).toThrow(InvalidInputError);
    }
    expect(correosSpainTrackingUrl(TRACKING_NUMBER)).toBe(
      'https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=PR123456789012345C',
    );
  });
});

describe('Correos Spain response parsing', () => {
  it('accepts numeric result codes and rejects structured or boolean codes', () => {
    expect(parseCorreosSpainTrackingResponse([envelope({ error: { codError: 0 } })], TRACKING_NUMBER).status).toBe('delivered');
    for (const codError of [[0], { value: 0 }, false, Infinity]) {
      expect(() => parseCorreosSpainTrackingResponse([envelope({ error: { codError } })], TRACKING_NUMBER)).toThrow(SchemaError);
    }
  });

  it('returns delivered history newest-first with Madrid timestamps', () => {
    const result = parseCorreosSpainTrackingResponse([envelope()], TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Entregado',
      last_update: '2026-04-29T13:12:42+02:00',
      expected_delivery: null,
    });
    expect(result.events?.map((item) => [item.description, item.stage, item.time])).toEqual([
      ['Entregado', 'delivered', '2026-04-29T13:12:42+02:00'],
      ['En reparto', 'out_for_delivery', '2026-04-29T08:46:00+02:00'],
      ['Clasificado', 'in_transit', '2026-04-28T15:52:17+02:00'],
      ['Admitido', 'accepted', '2026-04-27T23:03:58+02:00'],
    ]);
  });

  it('maps documented event codes and reports unmapped ones as unknown', () => {
    const cases: Array<[string, string, string]> = [
      ['A090000V', 'pending', 'registered'],
      ['A010000V', 'in_transit', 'accepted'],
      ['P101110V', 'in_transit', 'in_transit'],
      ['H01I350V', 'out_for_delivery', 'ready_for_pickup'],
      ['G01L020V', 'out_for_delivery', 'ready_for_pickup'],
      ['H010930R', 'exception', 'failed_attempt'],
      ['O140000V', 'exception', 'returned'],
      ['X120000V', 'delivered', 'delivered'],
      ['C010000V', 'in_transit', 'in_transit'],
      ['H250000V', 'out_for_delivery', 'out_for_delivery'],
      ['ADV0000V', 'in_transit', 'accepted'],
      ['H01R390V', 'exception', 'failed_attempt'],
      ['H01R420V', 'exception', 'failed_attempt'],
      ['H01R424V', 'exception', 'failed_attempt'],
      ['L03D320R', 'exception', 'returned'],
      ['A170000V', 'pending', 'registered'],
      ['E000001V', 'in_transit', 'customs'],
      ['B170000V', 'in_transit', 'customs'],
      ['E510000V', 'in_transit', 'in_transit'],
      ['E819300V', 'in_transit', 'customs'],
      ['E508700V', 'in_transit', 'customs'],
      ['E134630V', 'in_transit', 'customs'],
      ['E190000V', 'in_transit', 'in_transit'],
      ['I020000V', 'exception', 'returned'],
      ['I01H230V', 'exception', 'returned'],
      ['L03D240R', 'exception', 'returned'],
    ];
    for (const [code, status, stage] of cases) {
      expect(classifyCorreosSpainStatus(code)).toEqual({ status, stage });
      const result = parseCorreosSpainTrackingResponse([envelope({
        eventos: [event(code, '29/04/2026', '13:12:42', 'Resumen')],
      })], TRACKING_NUMBER);
      expect(result).toMatchObject({ status, current_stage: stage });
    }
    expect(classifyCorreosSpainStatus('Z999999Z')).toBeUndefined();
    const unknown = parseCorreosSpainTrackingResponse([envelope({
      eventos: [event('Z999999Z', '29/04/2026', '13:12:42', 'Algo nuevo')],
    })], TRACKING_NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Algo nuevo' });
    // No explicit mapping means no stage at all: the sync classifies the raw
    // wording and records where the final stage came from.
    expect(unknown.events?.[0]).toMatchObject({ description: 'Algo nuevo', provider_code: 'Z999999Z' });
    expect(unknown.events?.[0]?.stage).toBeUndefined();
  });

  it('keeps the stage of the scan before an "In delivery" notice while the parcel waits for collection', () => {
    const result = parseCorreosSpainTrackingResponse([envelope({
      nom_codired: 'OFICINA EXAMPLE',
      eventos: [
        event('G200000V', '20/10/2026', '06:15:00', 'Registration in the delivery unit'),
        event('H01C120V', '20/10/2026', '06:20:00', 'In delivery'),
        event('H01I350V', '20/10/2026', '10:53:00', 'At recipient’s disposal'),
        event('H01C120V', '20/10/2026', '13:12:00', 'In delivery'),
      ],
    })], TRACKING_NUMBER);
    expect(result.events?.map((item) => [item.provider_code, item.stage, item.stage_source])).toEqual([
      ['H01C120V', 'ready_for_pickup', 'none'],
      ['H01I350V', 'ready_for_pickup', undefined],
      ['H01C120V', 'in_transit', 'none'],
      ['G200000V', 'in_transit', undefined],
    ]);
    // The notice is no summary: the parcel still waits at the office.
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'At recipient’s disposal', pickup_point: 'OFICINA EXAMPLE' });
  });

  it('keeps scans of one instant in the localizador’s order', () => {
    const result = parseCorreosSpainTrackingResponse([envelope({
      eventos: [
        event('A010000V', '27/04/2026', '23:03:58', 'Admitido'),
        event('P040000V', '28/04/2026', '15:52:17', 'Clasificado'),
        event('H020000V', '28/04/2026', '15:52:17', 'En reparto'),
      ],
    })], TRACKING_NUMBER);
    expect(result.events?.map((item) => item.provider_code)).toEqual(['H020000V', 'P040000V', 'A010000V']);
  });

  it('rewords a scan stored in another language in place, matched by its instant and code', () => {
    // The localizador's replies in every language carry the same codes and clocks.
    expect(sameInstantIdentityPolicy('correos-spain', { supportsScanMatching: true }))
      .toMatchObject({ storedSources: ['correos-spain'], requireProviderCode: true });
  });

  it("reads an origin post's scans on an item from abroad on that post's clock", () => {
    const eventos = [
      event('B030000V', '29/09/2026', '16:56:00', 'En oficina de cambio'),
      event('B170000V', '29/09/2026', '17:01:00', 'En aduana de origen'),
      event('D050000V', '05/10/2026', '09:11:05', 'Llegada a oficina de cambio'),
      event('C010000V', '09/10/2026', '20:42:37', 'Salida de oficina de cambio'),
    ];
    const parse = (number: string, rows = eventos) => parseCorreosSpainTrackingResponse([envelope({ codEnvio: number, eventos: rows })], number);
    const times = (number: string) => parse(number).events?.map((item) => [item.provider_code, item.time ?? `local ${item.local_time}`]);
    // The suffix of the S10 code names the origin; Correos's own scans stay on Madrid's clock.
    expect(times('RR123456785IN')).toEqual([
      ['C010000V', '2026-10-09T20:42:37+02:00'],
      ['D050000V', '2026-10-05T09:11:05+02:00'],
      ['B170000V', '2026-09-29T17:01:00+05:30'],
      ['B030000V', '2026-09-29T16:56:00+05:30'],
    ]);
    // An origin of several clocks keeps the wall clock, and Spain's own items Madrid's.
    expect(times('RR123456785US')?.slice(2)).toEqual([['B170000V', 'local 2026-09-29T17:01:00'], ['B030000V', 'local 2026-09-29T16:56:00']]);
    expect(parse('RR123456785US', eventos.slice(0, 1))).toMatchObject({ last_update: null, last_update_local: '2026-09-29T16:56:00' });
    expect(times('RR123456785ES')?.slice(2)).toEqual([['B170000V', '2026-09-29T17:01:00+02:00'], ['B030000V', '2026-09-29T16:56:00+02:00']]);
    // A stored row on the Madrid reading is taken over by its code and wall clock.
    expect(sameInstantIdentityPolicy('correos-spain', { supportsScanMatching: true })).toMatchObject({ relabelledFrom: 'Europe/Madrid' });
  });

  it("reads a Canary Islands delivery unit's scans on the islands' clock", () => {
    const eventos = [
      event('A010000V', '20/10/2026', '10:00:00', 'Admitido'),
      event('P040000V', '21/10/2026', '22:15:00', 'Clasificado'),
      event('G01L010V', '23/10/2026', '07:40:00', 'Alta en unidad de reparto'),
      event('H020000V', '23/10/2026', '09:05:00', 'En reparto'),
      event('I01H210V', '26/10/2026', '11:30:00', 'Entregado'),
    ];
    const times = (codired: unknown, rows = eventos) => parseCorreosSpainTrackingResponse([envelope({ codired, eventos: rows })], TRACKING_NUMBER)
      .events?.map((item) => [item.provider_code, item.time]);
    // The unit code opens with its province: 35 and 38 are the islands. Scans before the delivery unit stay on Madrid's clock.
    expect(times('3500010')).toEqual([
      ['I01H210V', '2026-10-26T11:30:00+00:00'],
      ['H020000V', '2026-10-23T09:05:00+01:00'],
      ['G01L010V', '2026-10-23T07:40:00+01:00'],
      ['P040000V', '2026-10-21T22:15:00+02:00'],
      ['A010000V', '2026-10-20T10:00:00+02:00'],
    ]);
    expect(times(3800010)?.[0]).toEqual(['I01H210V', '2026-10-26T11:30:00+00:00']);
    for (const codired of ['2800001', '350001', undefined]) expect(times(codired)?.[0]).toEqual(['I01H210V', '2026-10-26T11:30:00+01:00']);
    // The collection from a sender's address is not the delivery unit's.
    expect(times('3500010', [event('HI10002V', '20/10/2026', '09:00:00', 'Envío recogido')])).toEqual([['HI10002V', '2026-10-20T09:00:00+02:00']]);
    // Once handed back to the sender, the envelope may name the sender's unit.
    const returned = [...eventos.slice(0, 3), event('I020000V', '27/10/2026', '12:00:00', 'Entregado al remitente')];
    expect(times('3500010', returned)?.find(([code]) => code === 'G01L010V')).toEqual(['G01L010V', '2026-10-23T07:40:00+02:00']);
  });

  it("tells relayed copies of an origin post's scans by Correos's summaries", () => {
    const zone = (wording: string, number = 'RR123456785IN') => correosOriginZone(number, { wording });
    expect(zone('En oficina de cambio')).toBe('Asia/Kolkata');
    expect(zone('In the exchange office')).toBe('Asia/Kolkata');
    expect(zone('Admisión, En aduana de origen, El envío está en la aduana del país de origen')).toBe('Asia/Kolkata');
    expect(zone('En aduana de origen', 'RR123456785US')).toBeNull();
    // Correos's own scans at its office of exchange, a Spanish item and a non-S10 code stay on Madrid's clock.
    expect(zone('Salida de oficina de cambio')).toBeUndefined();
    expect(zone('Llegada a oficina de cambio')).toBeUndefined();
    expect(zone('En oficina de cambio', 'RR123456785ES')).toBeUndefined();
    expect(zone('En oficina de cambio', TRACKING_NUMBER)).toBeUndefined();
    expect(correosOriginZone('RR123456785IN', { code: 'C010000V' })).toBeUndefined();
  });

  it('binds the envelope codEnvio and honors the codError result', () => {
    expect(() => parseCorreosSpainTrackingResponse([envelope({ codEnvio: 'PR123456789012346C' })], TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseCorreosSpainTrackingResponse([envelope({ codEnvio: undefined })], TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseCorreosSpainTrackingResponse([envelope({ error: { codError: '3', desError: 'Sin Trazabilidad en Minerva.' }, eventos: null })], TRACKING_NUMBER))
      .toThrow(NotFoundError);
    expect(() => parseCorreosSpainTrackingResponse([], TRACKING_NUMBER)).toThrow(SchemaError);
    expect(() => parseCorreosSpainTrackingResponse([envelope({ error: undefined })], TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseCorreosSpainTrackingResponse(null, TRACKING_NUMBER)).toThrow(SchemaError);
  });

  it("leaves a Correos Express shipment the group's localizador answers to Correos Express", () => {
    const shipment = '1000000000000017';
    const express = [
      event('X010000V', '13/10/2026', '13:12:02', 'Information'),
      event('X020000V', '13/10/2026', '19:46:32', 'En route to the destination location'),
    ];
    expect(() => parseCorreosSpainTrackingResponse([envelope({ codEnvio: shipment, eventos: express })], shipment))
      .toThrowError(expect.objectContaining({ kind: 'invalid_input', reason: 'other_carrier' }));
    // A Correos scan among them, or a code of Correos's own with letters, keeps the history.
    expect(parseCorreosSpainTrackingResponse([envelope({ codEnvio: shipment, eventos: [
      ...express, event('C010000V', '14/10/2026', '09:00:00', 'In transit'),
    ] })], shipment).events).toHaveLength(3);
    expect(parseCorreosSpainTrackingResponse([envelope({ eventos: express })], TRACKING_NUMBER).events).toHaveLength(2);
  });

  it('names the single parcel of an expedition and leaves several inconclusive', () => {
    const shipment = (shipmentCode: string, expeditionCode = EXPEDITION) => ({ shipmentCode, expeditionCode, events: [] });
    expect(parseCorreosSpainExpeditionResponse({ type: 'expeditions', shipment: [shipment(PARCEL)] }, EXPEDITION)).toBe(PARCEL);
    expect(parseCorreosSpainExpeditionResponse({ shipment: [shipment('pl00zz 0000000010100000y'), shipment(PARCEL)] }, EXPEDITION)).toBe(PARCEL);
    expect(() => parseCorreosSpainExpeditionResponse({ shipment: [shipment(PARCEL), shipment('PL00ZZ0000000020100000F')] }, EXPEDITION))
      .toThrow(IndeterminateError);
    // Another expedition's parcel, an empty list and a missing code are no answer about this one.
    for (const payload of [{ shipment: [shipment(PARCEL, 'PL00ZZ000000002S')] }, { shipment: [] }, { shipment: [shipment('')] },
      { shipment: [null] }, { shipment: 'none' }, {}, null]) {
      expect(() => parseCorreosSpainExpeditionResponse(payload, EXPEDITION)).toThrow(SchemaError);
    }
  });

  it('binds a parcel found through its expedition to that expedition', () => {
    const parcel = (codExpedicion: unknown) => [envelope({ codEnvio: PARCEL, codExpedicion })];
    expect(parseCorreosSpainTrackingResponse(parcel(EXPEDITION), PARCEL, EXPEDITION).status).toBe('delivered');
    for (const other of ['PL00ZZ000000002S', null, undefined]) {
      expect(() => parseCorreosSpainTrackingResponse(parcel(other), PARCEL, EXPEDITION)).toThrow(SchemaError);
    }
    // A parcel asked for by its own code needs no expedition.
    expect(parseCorreosSpainTrackingResponse(parcel(null), PARCEL).status).toBe('delivered');
  });

  it('keeps codError-0 parcels without events as unknown with the envelope summary', () => {
    const result = parseCorreosSpainTrackingResponse([envelope({
      eventos: [], resumen_ultimo: 'En camino',
    })], TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'En camino', events: [] });
  });

  it('skips unusable rows without losing the shipment', () => {
    const result = parseCorreosSpainTrackingResponse([envelope({
      eventos: [
        event('I01H210V', '29/04/2026', '13:12:42', 'Entregado'),
        event('I01H210V', '29/04/2026', '13:12:42', 'Entregado'),
        event('I01H210V', 'not-a-date', '13:12:42', 'Entregado'),
        event('I01H210V', '29/04/2026', '13:12:42', ''),
        'not a record',
      ],
    })], TRACKING_NUMBER);
    // Empty wording falls back to the code, so two rows survive the sparse input.
    expect(result.events?.map((item) => item.description)).toEqual(['Entregado', 'I01H210V']);
  });

  it('words a collection the English reply leaves without a summary', () => {
    const result = parseCorreosSpainTrackingResponse([envelope({
      eventos: [event('A090000V', '28/04/2026', '09:00:00', 'Pre-registered'), event('HI10002V', '28/04/2026', '13:00:00', '')],
    })], TRACKING_NUMBER);
    expect(result.events?.[0]).toMatchObject({ description: 'Shipment collected', provider_code: 'HI10002V', stage: 'accepted' });
  });

  it('retains weight and parcel data, never the customer name or raw keys', () => {
    const result = parseCorreosSpainTrackingResponse([envelope()], TRACKING_NUMBER);
    expect(result.receiver_name).toBeUndefined();
    expect(result).toMatchObject({
      weight_kg: 1.5,
      dimensions_text: '30 x 20 x 10 cm',
      delivered_at: '2026-04-29T13:12:42+02:00',
    });
    const serialized = JSON.stringify(result);
    for (const secret of ['nombre_cliente', 'Example Customer', 'nom_codired', 'peso', 'largo', 'ancho', 'alto']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('reads sides given in metres as centimetres', () => {
    const metres = parseCorreosSpainTrackingResponse([envelope({ largo: '0.3', ancho: '0.2', alto: '0.045' })], TRACKING_NUMBER);
    expect(metres.dimensions_text).toBe('30 x 20 x 4.5 cm');
    const thin = parseCorreosSpainTrackingResponse([envelope({ largo: '2', ancho: '30', alto: '0.5' })], TRACKING_NUMBER);
    expect(thin.dimensions_text).toBe('2 x 30 x 0.5 cm');
  });

  it('never retains the customer address, phone or signature blocks', () => {
    const serialized = JSON.stringify(parseCorreosSpainTrackingResponse([envelope()], TRACKING_NUMBER));
    for (const secret of [
      'Calle Ejemplo 1', '+340000000000', 'Example Signature',
      'direccion_cliente', 'telefono_cliente', 'firma_receptor', 'desTextoAmpliado',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('exposes the office name only while awaiting collection', () => {
    const pickup = parseCorreosSpainTrackingResponse([envelope({
      nom_codired: 'MADRID SUC 37. LA ELIPA',
      eventos: [event('H01I350V', '29/04/2026', '13:12:42', 'En oficina')],
    })], TRACKING_NUMBER);
    expect(pickup).toMatchObject({ pickup_point: 'MADRID SUC 37. LA ELIPA' });
    const held = parseCorreosSpainTrackingResponse([envelope({
      nom_codired: 'MADRID SUC 37. LA ELIPA',
      eventos: [event('G01L020V', '29/04/2026', '13:12:42', 'A disposición del destinatario')],
    })], TRACKING_NUMBER);
    expect(held).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'MADRID SUC 37. LA ELIPA' });
    const delivered = parseCorreosSpainTrackingResponse([envelope()], TRACKING_NUMBER);
    expect(delivered.pickup_point).toBeUndefined();
  });

  it('produces every capability carrier.json declares', () => {
    expect(CAPABILITIES).toEqual(['history', 'pickup_point', 'weight', 'dimensions', 'delivered_at']);
    const delivered = parseCorreosSpainTrackingResponse([envelope()], TRACKING_NUMBER);
    expect(delivered.events?.length).toBeGreaterThan(0);
    expect(delivered.weight_kg).toBe(1.5);
    expect(delivered.dimensions_text).toBe('30 x 20 x 10 cm');
    expect(delivered.delivered_at).toBe('2026-04-29T13:12:42+02:00');
    // The office is only a pickup signal while the parcel awaits collection.
    const pickup = parseCorreosSpainTrackingResponse([envelope({
      eventos: [event('H01I350V', '29/04/2026', '13:12:42', 'En oficina')],
    })], TRACKING_NUMBER);
    expect(pickup.pickup_point).toBe('OFICINA EXAMPLE CENTRAL');
  });
});

describe('Correos Spain pickup office address', () => {
  const OFFICES = readFileSync(new URL('./fixtures/offices.json', import.meta.url), 'utf8');
  const LOCATOR = 'https://api1.correos.es/digital-services/searchloc/api/v1/offices?';
  const waiting = (overrides: Record<string, unknown> = {}) => [envelope({
    eventos: [event('G01L020V', '29/04/2026', '13:12:42', 'A disposición del destinatario')],
    ...overrides,
  })];
  const lookup = (data: unknown, offices?: () => Response | Promise<Response>, signal?: AbortSignal) => {
    const fetcher = vi.fn<typeof fetch>(async (url) => (String(url).startsWith(LOCATOR)
      ? (offices ?? (() => new Response(OFFICES)))()
      : response(data)));
    const tracker = new CorreosSpainTracker({ timeoutMs: 1_000, fetcher });
    return { fetcher, tracker, result: tracker.fetch(TRACKING_NUMBER, { signal }) };
  };
  const locatorCalls = (fetcher: ReturnType<typeof lookup>['fetcher']) => fetcher.mock.calls
    .filter(([url]) => String(url).startsWith(LOCATOR));

  it('follows the office name with its street and town while the parcel waits there', async () => {
    const held = lookup(waiting());
    const result = await held.result;
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup',
      pickup_point: 'OFICINA EXAMPLE CENTRAL\nPlaza Ejemplo, 2\n00001 Villaejemplo' });
    expect(JSON.stringify(result)).not.toMatch(/000000004|example\.invalid|08:30|40\.42|VECINA|Avenida/);
    const url = new URL(String(locatorCalls(held.fetcher)[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ text: 'OFICINA EXAMPLE CENTRAL', searchType: 'otros',
      specialSearch: 'true', sendDelivery: 'OFI', distance: '10000' });
    const delivered = lookup([envelope()]);
    expect((await delivered.result).pickup_point).toBeUndefined();
    expect(delivered.fetcher).toHaveBeenCalledOnce();
  });

  it('remembers the address of an office, and asks again after a failure', async () => {
    const failing = lookup(waiting(), () => new Response('', { status: 503 }));
    expect((await failing.result).pickup_point).toBe('OFICINA EXAMPLE CENTRAL');
    failing.fetcher.mockImplementation(async (url) => (String(url).startsWith(LOCATOR)
      ? new Response(OFFICES) : response(waiting())));
    for (let lookups = 0; lookups < 2; lookups += 1) {
      expect((await failing.tracker.fetch(TRACKING_NUMBER)).pickup_point)
        .toBe('OFICINA EXAMPLE CENTRAL\nPlaza Ejemplo, 2\n00001 Villaejemplo');
    }
    expect(locatorCalls(failing.fetcher)).toHaveLength(2);
  });

  it.each([
    ['another office alone', () => new Response(OFFICES.replace('"officeId": "2800001"', '"officeId": "2800003"'))],
    ['an office without a street', () => new Response(OFFICES.replace('"address": "Plaza Ejemplo, 2"', '"address": null'))],
    ['an office without a town', () => new Response(OFFICES.replace('"cityName": "Villaejemplo",\n        "officeId": "2800001"',
      '"cityName": "",\n        "officeId": "2800001"'))],
    // The locator answers a search that finds nothing with HTTP 200 and this body.
    ['no office found', () => response({ code: '404', message: 'Not Found', moreInformation: { description: 'Not results found.' } })],
    ['a malformed reply', () => new Response('<html>PRIVATE</html>')],
    ['an HTTP error', () => new Response('', { status: 401 })],
    ['an outage', () => { throw new TypeError('fetch failed'); }],
  ])('keeps the office name alone after %s', async (_, offices) => {
    await expect(lookup(waiting(), offices).result).resolves.toMatchObject({ pickup_point: 'OFICINA EXAMPLE CENTRAL' });
  });

  it('asks nothing without a unit code to bind the reply to', async () => {
    for (const codired of [undefined, '', '28 00001', 'ABC']) {
      const unbound = lookup(waiting({ codired }));
      expect((await unbound.result).pickup_point).toBe('OFICINA EXAMPLE CENTRAL');
      expect(unbound.fetcher).toHaveBeenCalledOnce();
    }
    // A numeric code binds as its digits.
    expect((await lookup(waiting({ codired: 2800001 })).result).pickup_point).toContain('Plaza Ejemplo, 2');
  });

  it('ends a lookup cancelled during the office request', async () => {
    const controller = new AbortController();
    const held = lookup(waiting(), () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    }, controller.signal);
    await expect(held.result).rejects.toThrow();
  });
});

describe('CorreosSpainTracker fetch', () => {
  it('calls the localizador endpoint with web-channel params', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      seen.push(String(input));
      return response([envelope()]);
    });
    const result = await new CorreosSpainTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER);
    expect(result.status).toBe('delivered');
    expect(seen).toEqual([
      'https://localizador.correos.es/canonico/eventos_envio_servicio/PR123456789012345C?codAplicacion=60&codCanal=3&codIdioma=EN&indUltEvento=N',
    ]);
  });

  it("asks for the reader's language when the localizador words scans in it, and English otherwise", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([envelope()]));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    for (const [language, asked] of [['es', 'ES'], ['es-ES', 'ES'], ['pt-BR', 'PT'], ['fr', 'FR'], ['ca', 'EN'], ['de', 'EN'], [null, 'EN']] as const) {
      await instance.track({ number: TRACKING_NUMBER, language });
      expect(new URL(String(fetcher.mock.calls.at(-1)?.[0])).searchParams.get('codIdioma')).toBe(asked);
    }
  });

  it('resolves an expedition code through the public search, then tracks its parcel', async () => {
    const seen: string[] = [];
    const search = 'https://api1.correos.es/digital-services/searchengines/api/v1/envios?text=PL00ZZ000000001Z&language=ES';
    const localizador = (code: string) => `https://localizador.correos.es/canonico/eventos_envio_servicio/${code}?codAplicacion=60&codCanal=3&codIdioma=EN&indUltEvento=N`;
    let found: Response = response({ type: 'expeditions', shipment: [{ shipmentCode: PARCEL, expeditionCode: EXPEDITION }] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      seen.push(String(input));
      return String(input) === search ? found.clone() : response([envelope({ codEnvio: PARCEL, codExpedicion: EXPEDITION })]);
    });
    const tracker = new CorreosSpainTracker({ timeoutMs: 1_000 });
    expect((await tracker.fetch('pl00zz000000001z')).status).toBe('delivered');
    expect(seen).toEqual([search, localizador(PARCEL)]);
    // The search answers 204 for a code it does not know; the localizador is not asked.
    seen.length = 0;
    found = new Response(null, { status: 204 });
    await expect(tracker.fetch(EXPEDITION)).rejects.toThrow(NotFoundError);
    expect(seen).toEqual([search]);
    found = response({}, 503);
    await expect(tracker.fetch(EXPEDITION)).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    // A code the search returns as its own parcel is tracked without an expedition binding.
    seen.length = 0;
    found = response({ type: 'envio', shipment: [{ shipmentCode: EXPEDITION, expeditionCode: EXPEDITION }] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      seen.push(String(input));
      return String(input) === search ? found.clone() : response([envelope({ codEnvio: EXPEDITION, codExpedicion: null })]);
    });
    expect((await tracker.fetch(EXPEDITION)).status).toBe('delivered');
    expect(seen).toEqual([search, localizador(EXPEDITION)]);
  });

  it('surfaces transport and schema failures distinctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({}, 503));
    await expect(new CorreosSpainTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('not json', 200));
    await expect(new CorreosSpainTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toThrow(TypeError);
    expect(() => new CorreosSpainTracker({ timeoutMs: 0 })).toThrow(TypeError);
    await expect(new CorreosSpainTracker({ timeoutMs: 1_000 }).fetch('ABC'))
      .rejects.toThrow(InvalidInputError);
  });
});
