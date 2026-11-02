import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HermesTracker, parseHermesTrackingResponse } from './adapter.js';
import { hermesStatus } from './status.js';

const WRONG_HERMES_NUMBER = '12345678';
const DELIVERED_NUMBER = '62100000000000000';

const fixture = (name: string): Record<string, unknown> => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
) as Record<string, unknown>;
const emptyOrder = () => fixture('empty-order');
const delivered = () => fixture('delivered');
const carrier = JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[]; timezone: string };
const capabilities = carrier.capabilities;

type Order = Record<string, unknown>;
const bodyOf = (payload: Record<string, unknown>) => payload.body as Record<string, unknown>;
/** The delivered fixture with a sender block, as the live reply carries one. */
function withSender(payload: Record<string, unknown>, versenderdaten: Record<string, unknown>) {
  bodyOf(payload).versenderdaten = versenderdaten;
  return payload;
}
/** The delivered fixture cut back to its tour scan, with order fields replaced. */
function onTour(order: Order) {
  const payload = delivered();
  const current = bodyOf(payload).auftragsdaten as Order;
  bodyOf(payload).auftragsdaten = {
    ...current,
    lieferdatum: null,
    ...order,
    statusjourneyDto: { auftragstatusdaten: [{
      sendungsstatusId: 430,
      sendungsstatus: 'Deine Sendung befindet sich auf Tour.',
      sendungsstatusBuchungszeitpunkt: '2026-10-12 07:10',
    }] },
  };
  return payload;
}

afterEach(() => vi.restoreAllMocks());

describe('Hermes no-data response', () => {
  it.each(['sendungsstatus', 'sendungsstatusBuchungszeitpunkt'])('rejects a structured %s field', (field) => {
    for (const value of [{ value: 'Delivered' }, ['Delivered'], 700]) {
      const event = { sendungsstatusId: 700, sendungsstatus: 'Delivered', sendungsstatusBuchungszeitpunkt: '2026-01-01 12:00', [field]: value };
      const payload = { auftragsdaten: { lieferscheinnummer: WRONG_HERMES_NUMBER, statusjourneyDto: { auftragstatusdaten: [event] } } };
      expect(() => parseHermesTrackingResponse(payload, WRONG_HERMES_NUMBER)).toThrow(SchemaError);
    }
  });

  it('does not classify structured wording as delivery evidence', () => {
    expect(hermesStatus(999, ['delivered'])).toBe('pending');
    expect(hermesStatus(999, { text: 'delivered' })).toBe('pending');
    expect(hermesStatus(999, 'delivered')).toBe('delivered');
  });

  it('rejects the official empty-order placeholder as a privacy-safe 404', () => {
    expect(() => parseHermesTrackingResponse(emptyOrder(), WRONG_HERMES_NUMBER))
      .toThrow(NotFoundError);
    try {
      parseHermesTrackingResponse(emptyOrder(), WRONG_HERMES_NUMBER);
    } catch (error) {
      expect(error).toMatchObject({
        name: 'NotFoundError',
        status: 404,
        message: 'Hermes could not locate the shipment',
      });
      expect(String(error)).not.toContain(WRONG_HERMES_NUMBER);
    }
  });

  it('does not accept an empty object as a pending shipment', () => {
    expect(() => parseHermesTrackingResponse({}, WRONG_HERMES_NUMBER))
      .toThrow('Hermes returned an invalid tracking response');
  });

  it('rejects a non-empty response for a different shipment', () => {
    const otherShipment = {
      body: {
        auftragsdaten: {
          lieferscheinnummer: '87654321',
          statusjourneyDto: {
            statusdaten: [{
              sendungsstatusId: 20_000,
              sendungsstatus: 'Unterwegs',
              sendungsstatusBuchungszeitpunkt: '2026-08-30T12:00:00+02:00',
            }],
          },
        },
      },
    };
    expect(() => parseHermesTrackingResponse(otherShipment, WRONG_HERMES_NUMBER))
      .toThrow('Hermes returned a different shipment');
  });

  it('reads the order myhes.de returns for one of its pieces', () => {
    const result = parseHermesTrackingResponse(delivered(), '00 0123456 0000000001 2');
    expect(result).toMatchObject({ status: 'delivered', canonical_tracking_number: DELIVERED_NUMBER });
    expect(parseHermesTrackingResponse(delivered(), DELIVERED_NUMBER)).not.toHaveProperty('canonical_tracking_number');
  });

  it('rejects an order for a twenty-digit number that is not a valid SSCC', () => {
    expect(() => parseHermesTrackingResponse(delivered(), '00012345600000000013'))
      .toThrow('Hermes returned a different shipment');
  });

  it('normalizes the public Hermes status IDs', () => {
    expect([
      [40, 'pending'],
      [100, 'in_transit'],
      [430, 'out_for_delivery'],
      [700, 'delivered'],
      [702, 'delivered'],
      [742, 'delivered'],
      [318, 'exception'],
    ].map(([statusId]) => hermesStatus(statusId))).toEqual([
      'pending',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'delivered',
      'delivered',
      'exception',
    ]);
  });

  it('parses a sanitized fixture from Hermes\'s public delivered sample', () => {
    const result = parseHermesTrackingResponse(delivered(), DELIVERED_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      last_update: '2026-08-05 12:50',
      last_status_text: 'Deine Sendung wurde erfolgreich zugestellt.',
    });
    // German service, offset-less local timestamps: the declared zone is
    // Europe/Berlin and the raw wall-clock strings are untouched by it.
    expect(result.timezone).toBe('Europe/Berlin');
    expect(carrier.timezone).toBe('Europe/Berlin');
    expect(result.events?.[0]?.time).toBe('2026-08-05 12:50');
    expect(result.events).toHaveLength(1);
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered' });
    expect(result.events?.some((event) => event.description === 'Tracking update')).toBe(false);
  });

  it('covers every capability declared in carrier.json', () => {
    const result = parseHermesTrackingResponse(withSender(delivered(), { shopname: 'MUSTER' }), DELIVERED_NUMBER);
    const planned = parseHermesTrackingResponse(onTour({ lieferdatum: '2026-10-12' }), DELIVERED_NUMBER);
    expect(capabilities).toEqual(['history', 'eta', 'sender_name', 'delivered_at']);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(planned.expected_delivery).toBe('2026-10-12');
    expect(result.sender_name).toBe('MUSTER');
    expect(result.delivered_at).toBe('2026-08-05 12:50');
  });

  it('names the sender the page shows: the dealer, else the shop, else the client', () => {
    const sender = (versenderdaten: Record<string, unknown>) =>
      parseHermesTrackingResponse(withSender(delivered(), versenderdaten), DELIVERED_NUMBER).sender_name;
    const client = { auftraggeber: 4711, fachhaendler: null, name: 'Muster Möbel (GmbH) ', shopname: 'MUSTER' };
    expect(sender(client)).toBe('MUSTER');
    expect(sender({ ...client, shopname: '' })).toBe('Muster Möbel (GmbH)');
    expect(sender({ ...client, fachhaendler: { name: 'Küchenstudio Beispiel', strasse: 'Beispielweg 1' } }))
      .toBe('Küchenstudio Beispiel');
    expect(sender({ auftraggeber: 4711, fachhaendler: null, name: null, shopname: null })).toBeUndefined();
    const serialized = JSON.stringify(parseHermesTrackingResponse(
      withSender(delivered(), { ...client, fachhaendler: { name: 'Küchenstudio Beispiel', strasse: 'Beispielweg 1' } }),
      DELIVERED_NUMBER,
    ));
    expect(serialized).not.toContain('Beispielweg');
    expect(serialized).not.toContain('4711');
  });

  it('reads the planned day with its time window and drops it once delivered', () => {
    const estimate = (order: Record<string, unknown>) =>
      parseHermesTrackingResponse(onTour(order), DELIVERED_NUMBER).expected_delivery;
    expect(estimate({ lieferdatum: '2026-10-12', lieferzeitfensterVon: '8:00', lieferzeitfensterBis: '12:00:00' }))
      .toBe('2026-10-12 08:00–12:00');
    expect(estimate({ lieferdatum: '2026-10-12', lieferzeitfensterVon: '08:00', lieferzeitfensterBis: null }))
      .toBe('2026-10-12');
    expect(estimate({ lieferdatum: '2026-10-12', lieferzeitfensterVon: 'morgens', lieferzeitfensterBis: '12:00' }))
      .toBe('2026-10-12');
    const result = parseHermesTrackingResponse(delivered(), DELIVERED_NUMBER);
    expect(result.status).toBe('delivered');
    expect(result.expected_delivery).toBeNull();
    expect(result.delivered_at).toBe('2026-08-05 12:50');
    expect(parseHermesTrackingResponse(onTour({ lieferdatum: '2026-10-12' }), DELIVERED_NUMBER).delivered_at)
      .toBeUndefined();
  });

  it('never projects the internal operational stream or an order reference', () => {
    const serialized = JSON.stringify(parseHermesTrackingResponse(delivered(), DELIVERED_NUMBER));
    for (const internalValue of [
      'Ware geliefert.',
      'Ihre Sendung wurde bei der angegebenen Adresse zugestellt.',
      '10000001',
    ]) expect(serialized).not.toContain(internalValue);
  });

  it('exercises the anonymous API path with a valid-shaped wrong number', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(emptyOrder()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new HermesTracker({ timeoutMs: 1_000 }).fetch(WRONG_HERMES_NUMBER))
      .rejects.toBeInstanceOf(NotFoundError);
    const request = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(request.origin + request.pathname).toBe('https://myhes.de/api/request/auftragsdaten');
    expect(request.searchParams.get('parcelNumber')).toBe(WRONG_HERMES_NUMBER);
  });

  it('recognizes an order with scans and the empty-order placeholder as unknown', async () => {
    const reply = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(delivered()))
      .mockResolvedValueOnce(reply(emptyOrder()))
      .mockResolvedValueOnce(reply(delivered()));
    const hes = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    // A local clock dates the last activity without an instant.
    await expect(hes.recognize!(DELIVERED_NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-08-05T12:50:00' });
    await expect(hes.recognize!(WRONG_HERMES_NUMBER)).resolves.toEqual({ known: false });
    // An order for another delivery note is no recognition.
    await expect(hes.recognize!('62100000000000001')).rejects.toBeInstanceOf(SchemaError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
