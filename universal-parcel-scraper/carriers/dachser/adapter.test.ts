import { readFileSync } from 'node:fs';
import { Settings } from 'luxon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { DachserTracker, parseDachserTrackingResponse, validateDachserTrackingUrl } from './adapter.js';
import { eventLabel, shipmentStatus } from './status.js';

const WRONG_DACHSER_NUMBER = '12345678';
const WRONG_DACHSER_URL = 'https://customeriberia.dachser.com/customerarea/'
  + 'utilidades/seguimiento-publico/detalle?numeroUnico=12345678'
  + '&hash=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SHIPMENT_NUMBER = '9010000001234';

const fixture = (name: string): Record<string, unknown> => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
) as Record<string, unknown>;
const inTransit = () => fixture('in-transit');
const nullResult500 = () => fixture('null-result-500');
const nullMessage500 = () => fixture('null-message-500');
const capabilities = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

afterEach(() => vi.restoreAllMocks());

describe('Dachser capability URL', () => {
  it('canonicalizes a complete public detail link and rejects anything else', () => {
    expect(validateDachserTrackingUrl(WRONG_DACHSER_URL, WRONG_DACHSER_NUMBER)).toBe(WRONG_DACHSER_URL);
    expect(() => validateDachserTrackingUrl('http://customeriberia.dachser.com/customerarea/utilidades/seguimiento-publico/detalle?numeroUnico=12345678&hash=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', WRONG_DACHSER_NUMBER))
      .toThrow('must use https://customeriberia.dachser.com');
    expect(() => validateDachserTrackingUrl(WRONG_DACHSER_URL, '87654321'))
      .toThrow('belongs to a different tracking number');
    expect(() => validateDachserTrackingUrl('https://customeriberia.dachser.com/customerarea/utilidades/seguimiento-publico/detalle?numeroUnico=12345678', WRONG_DACHSER_NUMBER))
      .toThrow('must include its access parameters');
    expect(() => validateDachserTrackingUrl('https://customeriberia.dachser.com/customerarea/utilidades/seguimiento-publico/detalle?numeroUnico=12345678&hash=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&unexpected=1', WRONG_DACHSER_NUMBER))
      .toThrow('unsupported parameter');
  });

  it('rejects a link that is not the shipment\'s as invalid input before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const tracker = new DachserTracker({ fetcher });
    await expect(tracker.fetch(WRONG_DACHSER_NUMBER, 'https://example.com/x')).rejects.toMatchObject({
      name: 'InvalidInputError',
      kind: 'invalid_input',
      message: 'Dachser links must use https://customeriberia.dachser.com',
    });
    await expect(tracker.fetch('87654321', WRONG_DACHSER_URL)).rejects.toMatchObject({
      kind: 'invalid_input',
      message: 'The Dachser URL belongs to a different tracking number',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Dachser response normalization', () => {
  it('does not derive identity, dates or delivery evidence from structured fields', () => {
    expect(() => parseDachserTrackingResponse({ numUnico: [SHIPMENT_NUMBER] }, SHIPMENT_NUMBER)).toThrow('different shipment');
    const result = parseDachserTrackingResponse({ numUnico: Number(SHIPMENT_NUMBER), estadoExpedicion: ['ENTREGADA'],
      fechaEstado: ['2026-01-01'], fCompromiso: ['2026-01-02'],
      incidenciaExpedicionData: [{ fechaIncidencia: ['2026-01-01'], descripcionIncidencia: 'ENTREGADA' }] }, SHIPMENT_NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_update: null, expected_delivery: null, events: [] });
    expect(eventLabel(['ENTREGADA']).stage).toBe('in_transit');
  });

  it('keeps only normalized status and event data', () => {
    const result = parseDachserTrackingResponse(inTransit(), SHIPMENT_NUMBER);
    expect(result).toMatchObject({
      status: 'in_transit',
      last_status_text: 'In transit',
      last_update: '2026-09-12T07:45:00+02:00',
      expected_delivery: '2026-09-15',
      timezone: 'Europe/Madrid',
    });
    expect(result.events).toEqual([
      { time: '2026-09-12T07:45:00+02:00', location: '', stage: 'in_transit', description: 'Shipment departed a Dachser facility' },
      { time: '2026-09-11T18:20:00+02:00', location: '', stage: 'in_transit', description: 'Shipment arrived at a Dachser facility' },
      { time: '2026-09-11T09:05:00+02:00', location: '', stage: 'accepted', description: 'Shipment accepted by Dachser' },
      { time: '2026-09-10T16:00:00+02:00', location: '', stage: 'registered', description: 'Shipment registered by Dachser' },
    ]);
  });

  it('orders scans in the repeated autumn hour by instant', () => {
    // Read in winter, when Luxon alone would take the second occurrence.
    const now = Settings.now;
    Settings.now = () => Date.UTC(2026, 0, 15);
    try {
      const result = parseDachserTrackingResponse({ ...inTransit(), incidenciaExpedicionData: [
        { fechaIncidencia: '2025-10-26T02:40:00+02:00', descripcionIncidencia: 'LLEGADA A PLATAFORMA' },
        // Without an offset, the first occurrence.
        { fechaIncidencia: '26/10/2025 02:20', descripcionIncidencia: 'ENVIO ACEPTADO EN ORIGEN' },
        { fechaIncidencia: '2025-10-26T02:10:00+01:00', descripcionIncidencia: 'SALIDA DE PLATAFORMA' },
      ] }, SHIPMENT_NUMBER);
      expect(result.events?.map((event) => event.time))
        .toEqual(['2025-10-26T02:10:00+01:00', '2025-10-26T02:40:00+02:00', '2025-10-26T02:20:00+02:00']);
    } finally {
      Settings.now = now;
    }
  });

  it('discards sender, recipient, contact, signature and internal notes', () => {
    const serialized = JSON.stringify(parseDachserTrackingResponse(inTransit(), SHIPMENT_NUMBER));
    for (const privateValue of [
      'PRIVATE SENDER SL',
      'PRIVATE RECIPIENT',
      'PRIVATE STREET 12',
      '+34000000000',
      'private@example.test',
      'PRIVATE SIGNATURE',
      'PRIVATE INTERNAL NOTE',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('covers every capability declared in carrier.json', () => {
    expect(capabilities).toEqual(['history', 'eta']);
    const result = parseDachserTrackingResponse(inTransit(), SHIPMENT_NUMBER);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.expected_delivery).toBe('2026-09-15');
  });

  it('classifies a negative or rescheduled notice before the delivery word it contains', () => {
    expect(eventLabel('EXPEDICION NO ENTREGADA')).toMatchObject({ stage: 'failed_attempt' });
    expect(eventLabel('NUEVA FECHA DE ENTREGA')).toMatchObject({ stage: 'in_transit' });
    expect(eventLabel('EXPEDICION ENTREGADA')).toMatchObject({ stage: 'delivered' });
    expect(shipmentStatus('ENTREGADA', true)).toEqual({ status: 'delivered', text: 'Delivered' });
    expect(shipmentStatus('', false)).toEqual({ status: 'unknown', text: 'Tracking update unavailable' });
  });

  it('drops the estimate once the shipment is delivered and rejects a different shipment', () => {
    const delivered = { ...inTransit(), estadoExpedicion: 'ENTREGADA' };
    expect(parseDachserTrackingResponse(delivered, SHIPMENT_NUMBER))
      .toMatchObject({ status: 'delivered', expected_delivery: null });
    expect(() => parseDachserTrackingResponse({ ...inTransit(), numUnico: '9010000009999' }, SHIPMENT_NUMBER))
      .toThrow('different shipment');
    expect(() => parseDachserTrackingResponse({}, SHIPMENT_NUMBER))
      .toThrow('did not return a shipment number');
  });
});

describe('Dachser no-data response', () => {
  it('maps the public endpoint null-result signature to a privacy-safe 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(nullResult500()),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new DachserTracker({ timeoutMs: 1_000 }).fetch(WRONG_DACHSER_NUMBER, WRONG_DACHSER_URL))
      .rejects.toBeInstanceOf(NotFoundError);
    const request = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(request.pathname).toBe('/api/utilidades/seguimiento-publico/detalle');
    expect(request.searchParams.get('numeroUnico')).toBe(WRONG_DACHSER_NUMBER);
  });

  it('does not misclassify unrelated upstream failures as no data', async () => {
    // The catch-all code and the detail path also carry every other unhandled failure.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ...nullResult500(),
      message: 'Database unavailable',
    }), { status: 500 }));

    await expect(new DachserTracker({ timeoutMs: 1_000 }).fetch(WRONG_DACHSER_NUMBER, WRONG_DACHSER_URL))
      .rejects.toMatchObject({
        name: 'UpstreamHttpError',
        kind: 'indeterminate',
        status: 500,
        message: 'Dachser tracking returned HTTP 500',
      });
  });

  it('keeps the null-message 500 indeterminate, which no field tells apart from an outage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(nullMessage500()),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new DachserTracker({ timeoutMs: 1_000 }).fetch(WRONG_DACHSER_NUMBER, WRONG_DACHSER_URL))
      .rejects.toMatchObject({
        name: 'UpstreamHttpError',
        kind: 'indeterminate',
        status: 500,
        message: 'Dachser tracking returned HTTP 500',
      });
  });

  it('classifies each reply on its own when the two shapes alternate for one tuple', async () => {
    const reply = (payload: Record<string, unknown>) => new Response(JSON.stringify(payload), { status: 500 });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(reply(nullResult500()))
      .mockResolvedValueOnce(reply(nullMessage500()))
      .mockResolvedValueOnce(reply(nullResult500()));
    const tracker = new DachserTracker({ timeoutMs: 1_000 });
    const lookup = () => tracker.fetch(WRONG_DACHSER_NUMBER, WRONG_DACHSER_URL);

    await expect(lookup()).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup()).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup()).rejects.toMatchObject({ kind: 'not_found' });
  });
});
