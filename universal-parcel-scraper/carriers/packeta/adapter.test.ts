import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../app.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch, isValidDhlExpressWaybill } from '../../core/detection/index.js';
import { IndeterminateError, NotFoundError, SchemaError, InvalidInputError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import {
  adapter,
  normalizePacketaTrackingNumber,
  packetaTrackingUrl,
  parsePacketaTrackingResponse,
  PacketaTracker,
} from './adapter.js';
import { classifyPacketaStatus, packetaEventStage } from './status.js';

// All identifiers, timestamps and names below are synthetic. Event sentences use
// the real canned English wording confirmed live by the prior-art client, so
// substring classification exercises production text rather than paraphrases.
const TRACKING_NUMBER = 'Z1234567890';
const DELIVERED = JSON.parse(
  readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const HANDOFF = JSON.parse(
  readFileSync(new URL('./fixtures/handoff.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const DPD_NUMBER = '01234567890128U';
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function packet(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(DELIVERED), ...overrides };
}

function response(value: unknown, status = 200) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Packeta tracking normalization', () => {
  it('accepts the barcode with or without its Z and rejects other shapes', () => {
    expect(normalizePacketaTrackingNumber('z1234567890')).toBe(TRACKING_NUMBER);
    expect(normalizePacketaTrackingNumber('Z1234567890')).toBe(TRACKING_NUMBER);
    expect(normalizePacketaTrackingNumber('Z 123 456 7890')).toBe(TRACKING_NUMBER);
    expect(normalizePacketaTrackingNumber('1234567890')).toBe(TRACKING_NUMBER);
    for (const raw of ['123456789', '12345678901', 'Z123456789', 'Z12345678901', 'ZA234567890', 'ZZ1234567890', '']) {
      expect(() => normalizePacketaTrackingNumber(raw)).toThrow(InvalidInputError);
    }
    expect(packetaTrackingUrl(TRACKING_NUMBER)).toBe('https://tracking.packeta.com/en/Z1234567890');
  });
});

describe('Packeta response parsing', () => {
  it('returns delivered history newest-first with Prague timestamps', () => {
    const result = parsePacketaTrackingResponse({ item: packet() }, TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'The package has been delivered',
      last_update: '2026-07-07T13:00:00+02:00',
      expected_delivery: null,
      timezone: 'Europe/Prague',
    });
    expect(result.events?.map((event) => [(event.description ?? '').slice(0, 24), event.stage, event.time])).toEqual([
      ['The parcel is with you. ', 'delivered', '2026-07-07T13:00:00+02:00'],
      ['The parcel is ready for ', 'ready_for_pickup', '2026-07-07T09:00:00+02:00'],
      ['The parcel is currently ', 'in_transit', '2026-01-06T15:30:00+01:00'],
      ['We are aware of your par', 'registered', '2026-01-05T08:00:00+01:00'],
    ]);
  });

  it('maps every documented packet status code', () => {
    const cases: Array<[string, string, string]> = [
      ['997', 'pending', 'registered'],
      ['1', 'in_transit', 'in_transit'],
      ['31', 'in_transit', 'in_transit'],
      ['2', 'out_for_delivery', 'ready_for_pickup'],
      ['3', 'delivered', 'delivered'],
      ['996', 'out_for_delivery', 'ready_for_pickup'],
      ['5', 'exception', 'returned'],
      ['20', 'exception', 'returned'],
      ['998', 'exception', 'returned'],
      ['21', 'exception', 'returned'],
      ['4', 'exception', 'exception'],
      ['22', 'exception', 'exception'],
      ['24', 'exception', 'returned'],
      ['33', 'exception', 'exception'],
    ];
    for (const [code, status, stage] of cases) {
      expect(classifyPacketaStatus(code)).toEqual({ status, stage });
      const result = parsePacketaTrackingResponse({ item: packet({ packetStatusId: code }) }, TRACKING_NUMBER);
      expect(result).toMatchObject({ status, current_stage: stage });
    }
    // An unmapped id is schema drift, but it must not lose the shipment.
    expect(classifyPacketaStatus('999')).toBeUndefined();
    expect(() => parsePacketaTrackingResponse({ item: packet({ packetStatusId: '999' }) }, TRACKING_NUMBER))
      .not.toThrow();
    expect(parsePacketaTrackingResponse({ item: packet({ packetStatusId: '999' }) }, TRACKING_NUMBER))
      .toMatchObject({ status: 'unknown' });
  });

  it('classifies event sentences and leaves unrecognized wording unstaged', () => {
    expect(packetaEventStage('The parcel has been handed over to the carrier XYZ.')).toBe('in_transit');
    expect(packetaEventStage('We have returned the parcel back to the sender.')).toBe('returned');
    expect(packetaEventStage('Something completely new happened.')).toBeNull();
    const result = parsePacketaTrackingResponse({ item: packet({
      packetStatusId: '31',
      trackingDetails: [
        { text: 'The parcel has been handed over to the carrier XYZ.', time: '2026-01-06 10:00:00' },
        { text: 'Something completely new happened.', time: '2026-01-06 11:00:00' },
      ],
    }) }, TRACKING_NUMBER);
    // No recognized sentence means no stage at all: the sync classifies the raw
    // wording and records where the final stage came from.
    expect(result.events?.map((event) => event.stage)).toEqual([undefined, 'in_transit']);
    expect(result.events?.[0]).toMatchObject({ description: 'Something completely new happened.' });
  });

  it('binds the returned barcode to the requested shipment', () => {
    expect(parsePacketaTrackingResponse({ item: packet({ barcode: '1234567890' }) }, TRACKING_NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(parsePacketaTrackingResponse({ item: packet({ barcode: TRACKING_NUMBER }) }, TRACKING_NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(() => parsePacketaTrackingResponse({ item: packet({ barcode: '0987654321' }) }, TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parsePacketaTrackingResponse({ item: packet({ barcode: 'Z0987654321' }) }, TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parsePacketaTrackingResponse({ item: packet({ barcode: 1234567890 }) }, TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parsePacketaTrackingResponse({ item: packet({ barcode: `1234567890${' '.repeat(64)}0987654321` }) }, TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parsePacketaTrackingResponse({ item: packet({ barcode: undefined }) }, TRACKING_NUMBER))
      .toThrow(SchemaError);
  });

  it('treats a 200-carried error as not-found and an item-less 200 as schema drift', () => {
    expect(() => parsePacketaTrackingResponse({ error: 'notFound' }, TRACKING_NUMBER))
      .toThrow(NotFoundError);
    expect(() => parsePacketaTrackingResponse({}, TRACKING_NUMBER)).toThrow(SchemaError);
    expect(() => parsePacketaTrackingResponse(null, TRACKING_NUMBER)).toThrow(SchemaError);
    expect(() => parsePacketaTrackingResponse({ error: 'serviceUnavailable' }, TRACKING_NUMBER))
      .toThrow(IndeterminateError);
  });

  it('accepts a registered parcel without events and skips malformed rows', () => {
    const result = parsePacketaTrackingResponse({ item: packet({
      packetStatusId: '997',
      packetStatus: 'Registered',
      trackingDetails: [],
    }) }, TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', events: [], last_update: null });
    const sparse = parsePacketaTrackingResponse({ item: packet({
      trackingDetails: [
        { text: 'The parcel is with you.', time: '2026-07-07 13:00:00' },
        { text: 'The parcel is with you.', time: '2026-07-07 13:00:00' },
        { text: '', time: '2026-07-07 13:00:00' },
        { text: 'The parcel is with you.', time: 'not a time' },
        'not a record',
      ],
    }) }, TRACKING_NUMBER);
    expect(sparse.events).toHaveLength(1);
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const result = parsePacketaTrackingResponse({ item: packet({
      trackingDetails: [
        { text: 'We have successfully received the parcel for transport. Example Depot', time: '2026-07-05 09:00:00' },
        { text: 'The parcel is currently on its way to the depot.', time: '2026-07-06 08:00:00' },
        { text: 'The parcel is on its way to you.', time: '2026-07-06 08:00:00' },
      ],
    }) }, TRACKING_NUMBER);
    expect(result.events?.slice(0, 2).map((event) => event.description))
      .toEqual(['The parcel is on its way to you.', 'The parcel is currently on its way to the depot.']);
  });

  it('retains operational sender and pickup-point names', () => {
    const result = parsePacketaTrackingResponse({ item: packet() }, TRACKING_NUMBER);
    expect(result).toMatchObject({
      sender_name: 'Example Sender s.r.o.',
      pickup_point: 'Example Pickup Point, Example Street 1',
      delivered_at: '2026-07-07T13:00:00+02:00',
    });
    expect(JSON.stringify(result)).not.toContain('branchAddress');
  });

  it('names no pickup point on a parcel a courier brought to the door', () => {
    const atDoor = (handOver: string) => parsePacketaTrackingResponse({ item: packet({
      branchAddress: 'XX Home Delivery HD',
      trackingDetails: [
        { text: 'We have successfully received the parcel for transport. Example Depot', time: '2026-07-05 09:00:00' },
        { text: handOver, time: '2026-07-06 08:00:00' },
        { text: 'The parcel is with you. Thank you, and we look forward to next time.', time: '2026-07-07 13:00:00' },
      ],
    }) }, TRACKING_NUMBER);
    // Packeta names a home-delivery branch there, and its partner carrier's hand-over is the last movement.
    const handedOver = atDoor('The parcel has been handed over to the carrier. Tracking number: EXAMPLE');
    expect(handedOver).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(handedOver).not.toHaveProperty('pickup_point');
    expect(atDoor('The parcel is on its way to you.')).not.toHaveProperty('pickup_point');
    // On its way, the branch is still the one Packeta names.
    expect(parsePacketaTrackingResponse({ item: packet({ packetStatusId: '31' }) }, TRACKING_NUMBER).pickup_point)
      .toBe('Example Pickup Point, Example Street 1');
  });

  it('names no pickup point for a parcel Packeta sends to the door, at any stage', () => {
    // courierId "1" marks a courier delivery: its branch is a home-delivery one,
    // which Packeta's own page does not link to.
    for (const [packetStatusId, courierId] of [['31', '1'], ['31', 1], ['2', '1'], ['3', '1']] as const) {
      const result = parsePacketaTrackingResponse({ item: packet({
        packetStatusId, courierId, branchAddress: 'XX Home Delivery HD',
      }) }, TRACKING_NUMBER);
      expect(result).not.toHaveProperty('pickup_point');
    }
    // A parcel bound for a point keeps it while it travels and waits there.
    for (const packetStatusId of ['31', '2']) {
      expect(parsePacketaTrackingResponse({ item: packet({ packetStatusId }) }, TRACKING_NUMBER).pickup_point)
        .toBe('Example Pickup Point, Example Street 1');
    }
  });

  it('names no pickup point on a parcel going back to its sender', () => {
    const returned = parsePacketaTrackingResponse({ item: packet({
      packetStatusId: '5',
      packetStatus: 'Returned to sender',
      branchAddress: 'Example Depot, Example Street 2',
      trackingDetails: [
        { text: 'We have successfully received the parcel for transport. Example Z-BOX 3', time: '2026-07-23 17:00:00' },
        { text: 'We have returned the parcel back to the sender.', time: '2026-08-20 12:00:00' },
      ],
    }) }, TRACKING_NUMBER);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned to sender' });
    expect(returned.events?.[0]).toMatchObject({ stage: 'returned' });
    expect(returned).not.toHaveProperty('pickup_point');
    // On its way back, the branch is the point it no longer waits at.
    expect(parsePacketaTrackingResponse({ item: packet({ packetStatusId: '21', packetStatus: 'Return (on the way back)' }) }, TRACKING_NUMBER))
      .not.toHaveProperty('pickup_point');
  });

  it('never retains recipient identity, address or signature data', () => {
    const serialized = JSON.stringify(parsePacketaTrackingResponse({ item: packet() }, TRACKING_NUMBER));
    for (const secret of [
      'Example Recipient', 'Priklad 2', '+420000000000', 'Example Signature',
      'recipientName', 'recipientAddress', 'recipientPhone', 'signature',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('produces every capability carrier.json declares', () => {
    expect(CAPABILITIES).toEqual(['history', 'location', 'sender_name', 'pickup_point', 'delivered_at']);
    const result = parsePacketaTrackingResponse({ item: packet() }, TRACKING_NUMBER);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.find((event) => event.location)).toMatchObject({ description: 'The parcel is ready for pickup.', location: 'Z-BOX Central 5' });
    expect(result.sender_name).toBe('Example Sender s.r.o.');
    expect(result.pickup_point).toBe('Example Pickup Point, Example Street 1');
    expect(result.delivered_at).toBe('2026-07-07T13:00:00+02:00');
  });
});

describe('PacketaTracker fetch', () => {
  it('posts the uppercased barcode and maps HTTP outcomes', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      seen.push(String(input));
      return response({ item: packet() });
    });
    const result = await new PacketaTracker({ timeoutMs: 1_000 }).fetch('z1234567890');
    expect(result.status).toBe('delivered');
    expect(seen).toEqual(['https://tracking.packeta.com/api/getPacketById/Z1234567890/en']);
  });

  it('maps 404 and error-carrying 200 responses to not-found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ error: 'notFound' }, 404));
    await expect(new PacketaTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'NotFoundError', status: 404, message: 'Packeta could not locate the shipment' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ error: 'notFound' }, 200));
    await expect(new PacketaTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it('surfaces transport and schema failures distinctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({}, 500));
    await expect(new PacketaTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'UpstreamHttpError', status: 500 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('not json', 200));
    await expect(new PacketaTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toThrow(TypeError);
    expect(() => new PacketaTracker({ timeoutMs: 0 })).toThrow(TypeError);
    await expect(new PacketaTracker({ timeoutMs: 1_000 }).fetch('nope'))
      .rejects.toThrow(InvalidInputError);
  });

  it('does not report maintenance or generic HTTP errors as missing parcels', async () => {
    const tracker = new PacketaTracker({ timeoutMs: 1_000 });
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValue(response({ error: 'serviceUnavailable' }, 200));
    await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toBeInstanceOf(IndeterminateError);
    // A 404 without Packeta's notFound error proves no shipment outcome.
    for (const value of [{ error: 'serviceUnavailable' }, '<html>Not Found</html>', {}]) {
      fetcher.mockResolvedValue(response(value, 404));
      await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ name: 'IndeterminateError', kind: 'indeterminate' });
    }
  });
});

describe('Packeta hand-off to a delivery partner', () => {
  it('keeps the partner number in the wording and names the partner its link points to', () => {
    const result = parsePacketaTrackingResponse({ item: structuredClone(HANDOFF) }, TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit',
      delivery_carrier: 'dpd-de', delivery_tracking_number: DPD_NUMBER,
    });
    expect(result).not.toHaveProperty('pickup_point');
    expect(result.events?.map((event) => [event.description, event.stage])).toEqual([
      [`The parcel has been handed over to the carrier. Tracking number: ${DPD_NUMBER}`, 'in_transit'],
      ['We have successfully received the parcel for transport.', 'in_transit'],
      ['The parcel is currently on its way to the depot.', 'in_transit'],
      [`The parcel has been assigned a tracking number: ${DPD_NUMBER} and will soon be handed over to the carrier.`, 'registered'],
      ['We are aware of your parcel and are waiting for the sender to hand it over to us.', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/<a|href|tracking\.dpd\.de/);
    // The tracker then asks DPD Germany about DPD's own number.
    expect(deliveryHandoff('packeta', TRACKING_NUMBER, result)).toEqual({ carrier: 'dpd-de', number: DPD_NUMBER, basis: 'partner' });
  });

  it('names no partner for its own link, an unknown host or two partners, and keeps a number only where it belongs', () => {
    const handedOver = (...links: Array<[url: string, text: string]>) => parsePacketaTrackingResponse({ item: packet({
      packetStatusId: '31', courierId: '1',
      trackingDetails: links.map(([url, text], index) => ({
        text: `The parcel has been handed over to the carrier. Tracking number: <a href="${url}" rel="noopener noreferrer">${text}</a>`,
        time: `2026-03-0${index + 1} 06:45:00`,
      })),
    }) }, TRACKING_NUMBER);
    const dpd = `https://tracking.dpd.de/status/en_DE/parcel/${DPD_NUMBER}`;
    for (const result of [
      handedOver([`https://tracking.packeta.com/en_GB/?id=${TRACKING_NUMBER}`, TRACKING_NUMBER]),
      handedOver(['https://parcels.example/track?number=EXAMPLE1', 'EXAMPLE1']),
      handedOver([dpd, DPD_NUMBER], ['https://foxpost.hu/en/parcel-tracking?code=CLFOX000000000000001', 'CLFOX000000000000001']),
    ]) {
      expect(result).not.toHaveProperty('delivery_carrier');
      expect(result).not.toHaveProperty('delivery_tracking_number');
      expect(result.events?.[0]?.description).not.toContain('<');
    }
    expect(handedOver([`https://tracking.packeta.com/en_GB/?id=${TRACKING_NUMBER}`, TRACKING_NUMBER]).events?.[0]?.description)
      .toBe(`The parcel has been handed over to the carrier. Tracking number: ${TRACKING_NUMBER}`);
    // A number the link does not hold, or DPD's rules do not offer, is not DPD's reference.
    for (const text of ['01234567890129U', '0123456789012']) {
      expect(handedOver([dpd, text])).toEqual(expect.objectContaining({ delivery_carrier: 'dpd-de' }));
      expect(handedOver([dpd, text])).not.toHaveProperty('delivery_tracking_number');
    }
    expect(handedOver([dpd.replace(DPD_NUMBER, '01234567890129U'), '01234567890129U'])).not.toHaveProperty('delivery_tracking_number');
  });

  it('names InPost and its parcel number from its find-parcel link', () => {
    const INPOST_NUMBER = '600000000000000000000001';
    const result = parsePacketaTrackingResponse({ item: packet({
      packetStatusId: '31', courierId: '1',
      trackingDetails: [{
        text: `The parcel has been handed over to the carrier. Tracking number: <a href="https://inpost.pl/en/find-parcel?number=${INPOST_NUMBER}" rel="noopener noreferrer">${INPOST_NUMBER}</a>`,
        time: '2026-03-01 06:45:00',
      }],
    }) }, TRACKING_NUMBER);
    expect(result).toMatchObject({ delivery_carrier: 'inpost', delivery_tracking_number: INPOST_NUMBER });
  });

  it('lets a hand-off scan stored with its link markup keep its row', () => {
    const policy = sameInstantIdentityPolicy('packeta', { supportsScanMatching: true });
    const raw = (HANDOFF.trackingDetails as Array<{ text: string }>)[4]!.text;
    const stored = { stage: 'in_transit', description: raw, location: '', providerCode: '' };
    const incoming = { ...stored, description: `The parcel has been handed over to the carrier. Tracking number: ${DPD_NUMBER}` };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, { ...stored, description: raw.replaceAll(DPD_NUMBER, '01234567890135W') })).toBe(false);
    expect(policy?.matches?.(incoming, { ...stored, location: 'Example' })).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: '' })).toBe(false);
  });

  it('reads the depot or point a sentence names as its place, and keeps a row stored with it in the sentence', () => {
    const result = parsePacketaTrackingResponse({ item: packet({ trackingDetails: [
      { text: 'Your parcel has arrived at the depot Example-East, Example Street 2/4. We’re now preparing it for delivery.', time: '2026-07-06 05:00:00' },
      { text: 'We have successfully received the parcel for transport. DEPO Example, Example Street', time: '2026-07-05 09:00:00' },
      { text: 'We have successfully received the parcel for transport.', time: '2026-07-04 09:00:00' },
    ] }) }, TRACKING_NUMBER);
    expect(result.events?.map((event) => [event.description, event.location, event.stage])).toEqual([
      ['Your parcel has arrived at the depot. We’re now preparing it for delivery.', 'Example-East, Example Street 2/4', 'in_transit'],
      ['We have successfully received the parcel for transport.', 'DEPO Example, Example Street', 'in_transit'],
      ['We have successfully received the parcel for transport.', '', 'in_transit'],
    ]);
    const policy = sameInstantIdentityPolicy('packeta', { supportsScanMatching: true });
    const incoming = { stage: 'in_transit', description: 'We have successfully received the parcel for transport.', location: 'DEPO Example, Example Street', providerCode: '' };
    const stored = { ...incoming, description: `${incoming.description} DEPO Example, Example Street`, location: '' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, { ...stored, description: `${incoming.description} DEPO Other` })).toBe(false);
    const arrival = { ...incoming, description: 'Your parcel has arrived at the depot. We’re now preparing it for delivery.', location: 'Example-East' };
    expect(policy?.matches?.(arrival, { ...arrival, description: 'Your parcel has arrived at the depot Example-East. We’re now preparing it for delivery.', location: '' })).toBe(true);
  });
});

describe('Packeta bare packet IDs', () => {
  // Synthetic numbers: Packeta's API documents a packet ID as a ten-digit
  // integer and its barcode as that ID after a Z.
  const BARE = '1234567890';
  const environment = (fetcher: typeof fetch) => ({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
  const carrier = (fetcher: typeof fetch) => adapter(environment(fetcher));

  it('suggests Packeta at low confidence for ten bare digits and asks it', () => {
    for (const number of [BARE, '1000000000', '9999999998', '123 4567 890']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('packeta');
      expect(recognitionAskedCarriers(number), number).toContain('packeta');
    }
    expect(detectCarrierMatch(`Z${BARE}`)).toMatchObject({ carrier: 'packeta', confidence: 'high' });
    expect(recognitionAskedCarriers(`Z${BARE}`)).toEqual([]);
  });

  it('leaves out lengths, a leading zero and separators Packeta does not print', () => {
    for (const number of ['123456789', '12345678901', '0123456789', '123456789-0', '1234-567-890']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('packeta');
      expect(recognitionAskedCarriers(number), number).not.toContain('packeta');
    }
    // Without its hyphen CDL's order number is ten digits; Packeta stays out of that shape.
    expect(recognitionAskedCarriers('123456789-1')).toContain('cdl');
  });

  it('keeps a checksum-backed carrier among the carriers asked', () => {
    const waybill = '1234567891';
    expect(isValidDhlExpressWaybill(waybill)).toBe(true);
    expect(recognitionAskedCarriers(waybill)).toEqual(['dhl-express', 'acs-courier', 'geniki-taxydromiki', 'packeta', 'dhl-ecommerce-es']);
    expect(recognitionAskedCarriers(BARE)).toEqual(['packeta', 'dhl-ecommerce-es', 'box-now']);
  });

  it('recognizes a known packet from its bare ID and a missing one as unknown', async () => {
    const seen: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      seen.push(String(input));
      return String(input).includes(BARE)
        ? response({ item: { ...structuredClone(HANDOFF), barcode: BARE } })
        : response({ error: 'notFound' }, 404);
    });
    await expect(carrier(fetcher).recognize!(BARE)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-03T05:45:00.000Z' });
    await expect(carrier(fetcher).recognize!('1234567892')).resolves.toEqual({ known: false });
    expect(seen).toEqual([
      `https://tracking.packeta.com/api/getPacketById/Z${BARE}/en`,
      'https://tracking.packeta.com/api/getPacketById/Z1234567892/en',
    ]);
    // A form Packeta does not issue is unknown without a request.
    await expect(carrier(fetcher).recognize!('123456789')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps rate limits, error pages and malformed replies apart from a missing packet', async () => {
    for (const [reply, kind] of [
      [() => response({}, 429), 'rate_limited'],
      [() => response('<html>Not Found</html>', 404), 'indeterminate'],
      [() => response({ error: 'serviceUnavailable' }, 200), 'indeterminate'],
      [() => response({}, 200), 'schema'],
      [() => response({ item: { ...structuredClone(HANDOFF), barcode: '1234567892' } }), 'schema'],
    ] as const) {
      await expect(carrier(vi.fn<typeof fetch>(async () => reply())).recognize!(BARE), kind).rejects.toMatchObject({ kind });
    }
    await expect(carrier(vi.fn<typeof fetch>(async () => response('not json', 200))).recognize!(BARE)).rejects.toThrow(TypeError);
  });
});
