import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { carrierErrorKind, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import {
  IndiaPostChallengeError,
  IndiaPostTracker,
  indiaPostTrackingUrl,
  normalizeIndiaPostTrackingNumber,
  parseIndiaPostTrackingHtml,
} from './adapter.js';
import { classifyIndiaPostEvent } from './status.js';
import { locatePlace } from '../../places/index.js';

// Every identifier, office, pincode and timestamp below is synthetic; both
// numbers are recorded in numbers.json as made-up values with valid check
// digits. Event wordings reuse India Post's own English labels.
const SAMPLE_NUMBER = 'JN067614884IN';
const WRONG_VALID_NUMBER = 'RR000000005IN';
const CSRF_TOKEN = 'fixtureCsrfToken0123456789012345';
const DELIVERED = JSON.parse(
  readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'),
) as { tracking_status: string; tracking_events: Array<Record<string, unknown>> };
const EXPORT_CUSTOMS = JSON.parse(
  readFileSync(new URL('./fixtures/export-customs.json', import.meta.url), 'utf8'),
) as { synced_at: string; tracking_events: Array<Record<string, unknown>> };
const FLIGHT_LEGS = JSON.parse(
  readFileSync(new URL('./fixtures/flight-legs.json', import.meta.url), 'utf8'),
) as { synced_at: string; tracking_events: Array<Record<string, unknown>> };
const INBOUND = JSON.parse(
  readFileSync(new URL('./fixtures/inbound.json', import.meta.url), 'utf8'),
) as { synced_at: string; tracking_events: Array<Record<string, unknown>> };
const INBOUND_CODES = JSON.parse(
  readFileSync(new URL('./fixtures/inbound-codes.json', import.meta.url), 'utf8'),
) as { synced_at: string; tracking_events: Array<Record<string, unknown>> };
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function componentSnapshot(trackingNumber: string, status: string): string {
  return JSON.stringify({
    data: {
      consignment_number: trackingNumber,
      status: [status, { class: 'App\\Enums\\ConsignmentFormStatus', s: 'enm' }],
    },
    memo: { name: 'track-consignment' },
    checksum: 'unit-test-checksum',
  });
}

function trackingHistoryHtml(
  trackingNumber = SAMPLE_NUMBER,
  events: Array<Record<string, unknown>> = structuredClone(DELIVERED.tracking_events),
  syncedAt?: string,
): string {
  const request = JSON.stringify({
    id: 'public-request',
    ...(syncedAt ? { synced_at: syncedAt } : {}),
    tracking_status: 'Completed',
    tracking_events: events,
  });
  return `
    <div>
      <input id="consignment_search" value="${trackingNumber}">
      <div tracking-request="${escapeAttribute(request)}"></div>
    </div>
  `;
}

// MySpeedPost's collapsible booking cards: a heading, then label and value pairs.
function bookingCard(title: string, fields: Record<string, string>): string {
  const pairs = Object.entries(fields).map(([label, value]) => `
    <div class="pr-3">
      <p class="mb-0.5 font-semibold uppercase">
        ${label}
      </p>
      <p class="font-semibold">
        ${value}
      </p>
    </div>`).join('');
  return `
    <div x-data="{ open: false }" class="rounded-2xl">
      <button type="button" @click="open = !open">
        <h3 class="flex"><span class="block h-4 w-1.5"></span><span>${title}</span></h3>
      </button>
      <div x-show="open" x-transition.origin.top><div class="grid grid-cols-2">${pairs}</div></div>
    </div>`;
}

function bookingCards(destination: string): string {
  return bookingCard('Origin', {
    'Booking Office': 'Example GPO', 'Origin Pincode': '110001', 'City / District': 'Example City',
    State: 'Example State', Country: 'INDIA',
  }) + bookingCard('Destination', { Country: destination });
}

function takeOff(trackedAt: string, office: string, eventType = 'AircraftTakeOff'): Record<string, unknown> {
  return { tracked_at: trackedAt, event: 'AIRCRAFT_DEPARTURE', event_type: eventType, office, pincode: '', remarks: '' };
}

function pageHtml(
  trackingNumber: string,
  status: string,
  content = '',
): string {
  return `
    <html><head><meta name="csrf-token" content="${CSRF_TOKEN}"></head><body>
      <div wire:snapshot="${escapeAttribute(componentSnapshot(trackingNumber, status))}"></div>
      ${content}
    </body></html>
  `;
}

function livewireResponse(
  trackingNumber: string,
  status: string,
  effects: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({
    components: [{ snapshot: componentSnapshot(trackingNumber, status), effects }],
  }), { headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.restoreAllMocks());

it('distinguishes export-customs entry and exit under the same event type', () => {
  expect(classifyIndiaPostEvent('ExportCustoms', 'Out of Export Customs').stage).toBe('in_transit');
  expect(classifyIndiaPostEvent('ExportCustoms', 'Sent to Export Customs').stage).toBe('customs');
});

it('reads the movement codes seen since as transit, no longer unknown', () => {
  for (const [code, wording] of [
    ['BagReceived', 'Bag Received for Forwarding'], ['BagReceived', 'Bag Received'],
    ['BagUnloaded', 'Bag unloaded at destination Airport'], ['SendItemToDomestic', 'Send item to domestic location (Inb)'],
    ['ItemTransfered', 'Transfer to OOE (Otb)'], ['AssignedToLoadPlan', 'Assigned to load plan'],
    ['TransportLegCompleted', 'Transport Leg Completed'],
  ]) expect(classifyIndiaPostEvent(code, wording)).toEqual({ status: 'in_transit', stage: 'in_transit' });
});

it('reads "lost" only as a whole word, not Lagos before "To" in a flight remark', () => {
  expect(classifyIndiaPostEvent('MailArrived', 'MAIL_ARRIVED', 'Flight No: ZZ0102 (From LOS To CDG)').stage).toBe('in_transit');
  expect(classifyIndiaPostEvent('ItemLost', 'Item Lost').stage).toBe('exception');
  expect(classifyIndiaPostEvent('ITEM_LOST').stage).toBe('exception');
});

describe('India Post tracking input', () => {
  it('accepts only valid India-issued S10 identifiers and builds the scraper URL', () => {
    expect(normalizeIndiaPostTrackingNumber('jn 067.614-884 in')).toBe(SAMPLE_NUMBER);
    const url = new URL(indiaPostTrackingUrl(SAMPLE_NUMBER));
    expect(url.origin).toBe('https://myspeedpost.com');
    expect(url.pathname).toBe('/track');
    expect(url.searchParams.get('n')).toBe(SAMPLE_NUMBER);
    expect(url.searchParams.get('sync')).toBe('true');

    for (const value of [
      'JN067614885IN',
      'JN067614884FR',
      'JN067614884IN&admin=true',
      '123',
    ]) {
      expect(() => normalizeIndiaPostTrackingNumber(value)).toThrow('valid 13-character S10');
    }
  });
});

describe('India Post response normalization', () => {
  it('sorts real-format events, maps stages, and excludes private response fields', () => {
    const result = parseIndiaPostTrackingHtml(trackingHistoryHtml(), SAMPLE_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Item Delivered',
      expected_delivery: null,
      timezone: 'Asia/Kolkata',
    });
    expect(result.events).toHaveLength(3);
    expect(result.events?.[0]).toMatchObject({
      location: 'Maker SO 841215',
      description: 'Item Delivered',
      stage: 'delivered',
      provider_code: 'ItemDelivered',
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('recipient_address');
    expect(JSON.stringify(result)).not.toContain('pincode_info');
    expect(JSON.stringify(result)).not.toContain('must never survive normalization');
  });

  it('keeps an office point only from a verified entry for the same office', () => {
    const events = parseIndiaPostTrackingHtml(trackingHistoryHtml(), SAMPLE_NUMBER).events ?? [];
    const byOffice = Object.fromEntries(events.map((event) => [event.location, event.point]));

    expect(byOffice['Mumbai NSH 400099']).toEqual({ latitude: 19.1136, longitude: 72.8697 });
    // The pincode's directory entry is another office.
    expect(byOffice['Dadar BPC 400014']).toBeUndefined();
    // Unverified entries can be hundreds of kilometres off.
    expect(byOffice['Maker SO 841215']).toBeUndefined();
  });

  it('distinguishes accepted, transit, delivery, failure, and return events', () => {
    expect(classifyIndiaPostEvent('ItemBooked')).toEqual({
      status: 'pending',
      stage: 'accepted',
    });
    expect(classifyIndiaPostEvent('ItemDispatched')).toEqual({
      status: 'in_transit',
      stage: 'in_transit',
    });
    expect(classifyIndiaPostEvent('OutForDelivery')).toEqual({
      status: 'out_for_delivery',
      stage: 'out_for_delivery',
    });
    expect(classifyIndiaPostEvent('DeliveryAttempted')).toEqual({
      status: 'exception',
      stage: 'failed_attempt',
    });
    expect(classifyIndiaPostEvent('ReturnToSender')).toEqual({
      status: 'exception',
      stage: 'returned',
    });
    // Nothing recognized: a scan happened, but the caller can see it was not
    // classified, and the parcel-level status falls back to plain transit.
    expect(classifyIndiaPostEvent('Something completely new')).toEqual({
      status: 'unknown',
      stage: 'in_transit',
    });
    expect(parseIndiaPostTrackingHtml(trackingHistoryHtml(SAMPLE_NUMBER, [{
      tracked_at: '2026-09-01T11:25:04.000000Z',
      event: 'Something completely new',
      event_type: 'SomethingNew',
      office: 'Maker SO',
      pincode: '841215',
    }]), SAMPLE_NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });

  it('rejects a response belonging to another consignment', () => {
    expect(() => parseIndiaPostTrackingHtml(
      trackingHistoryHtml(WRONG_VALID_NUMBER),
      SAMPLE_NUMBER,
    )).toThrow(SchemaError);
    expect(() => parseIndiaPostTrackingHtml(
      trackingHistoryHtml(WRONG_VALID_NUMBER),
      SAMPLE_NUMBER,
    )).toThrow('different shipment');
  });

  it('spells out code-only events and treats customs hand-backs as moving on', () => {
    const result = parseIndiaPostTrackingHtml(
      trackingHistoryHtml(SAMPLE_NUMBER, EXPORT_CUSTOMS.tracking_events, EXPORT_CUSTOMS.synced_at),
      SAMPLE_NUMBER,
    );
    expect(result.events?.map((event) => [event.description, event.stage])).toEqual([
      ['Transferred to Office of Exchange', 'in_transit'],
      ['Item released by export Customs', 'in_transit'],
      ['Item Returned from Customs', 'in_transit'],
      ['Item Presented to Customs', 'customs'],
      ['Bag Forwarded', 'in_transit'],
      ['Bag Dispatched', 'in_transit'],
      // Matches the prose of rows synced earlier, so a stored row is not duplicated.
      ['Item Booked', 'accepted'],
    ]);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', source_synced_at: '2026-06-20T08:00:00Z' });
    expect(classifyIndiaPostEvent('CustomReturn', 'CUSTOM_RETURN')).toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(classifyIndiaPostEvent('Item returned from export Customs/Security')).toEqual({ status: 'in_transit', stage: 'in_transit' });
  });

  it('reads a take-off on its airport\'s clock, whatever its wording, and leaves office rows alone', () => {
    const result = parseIndiaPostTrackingHtml(
      trackingHistoryHtml(SAMPLE_NUMBER, FLIGHT_LEGS.tracking_events, FLIGHT_LEGS.synced_at),
      SAMPLE_NUMBER,
    );
    expect(result.events?.map((event) => [event.time, event.description, event.location])).toEqual([
      // Labelled 20:05Z and 01:40Z: the wall clocks of Paris and Delhi.
      ['2026-07-11T20:05:00+02:00', 'Aircraft Departure', 'Paris Charles de Gaulle Airport (CDG), France'],
      ['2026-07-11T01:40:00+05:30', 'Aircraft Departure', 'Delhi Airport (DEL), India'],
      // The host hashes the time string into a stored row: these stay as labelled.
      ['2026-07-10T16:45:00Z', 'Transferred to Office of Exchange', 'Example Foreign Post Office 110002'],
      ['2026-07-09T05:40:00Z', 'Item Booked', 'Example GPO 110001'],
    ]);
    expect(result.events?.slice(0, 2).map((event) => [event.stage, event.provider_code])).toEqual([
      ['in_transit', 'AircraftTakeOff'],
      ['in_transit', 'AircraftTakeOff'],
    ]);
    expect(result).toMatchObject({
      status: 'in_transit',
      current_stage: 'in_transit',
      last_status_text: 'Aircraft Departure',
      last_update: '2026-07-11T20:05:00+02:00',
    });
    // As labelled, the newest take-off is later than the sync that reported it.
    const synced = Date.parse(FLIGHT_LEGS.synced_at);
    expect(Date.parse(String(FLIGHT_LEGS.tracking_events.at(-1)?.tracked_at))).toBeGreaterThan(synced);
    expect(Date.parse(String(result.last_update))).toBeLessThan(synced);
  });

  it('follows an airport through its clock change and keeps the label where it knows no zone', () => {
    const times = (events: Array<Record<string, unknown>>) =>
      parseIndiaPostTrackingHtml(trackingHistoryHtml(SAMPLE_NUMBER, events), SAMPLE_NUMBER).events?.map((event) => event.time);

    expect(times([
      takeOff('2026-03-28T22:10:00.000000Z', 'Office - CDG 00000003'),
      takeOff('2026-03-29T22:10:00.000000Z', 'Office - CDG 00000003'),
    ])).toEqual(['2026-03-29T22:10:00+02:00', '2026-03-28T22:10:00+01:00']);
    // An airport outside the table.
    expect(times([takeOff('2026-07-11T20:05:00.000000Z', 'Office - GRU 00000004')])).toEqual(['2026-07-11T20:05:00Z']);
    // A take-off at an office that names no airport, and another code at an airport.
    expect(times([takeOff('2026-07-11T01:40:00.000000Z', 'Office - 00000001')])).toEqual(['2026-07-11T01:40:00Z']);
    expect(times([takeOff('2026-07-11T01:40:00.000000Z', 'Office - DEL 00000002', 'Unknown')])).toEqual(['2026-07-11T01:40:00Z']);
  });

  it('keeps flight numbers and routes while ignoring unrelated or mismatched remarks', () => {
    const event = takeOff('2026-07-11T20:05:00Z', 'Office - FRA 00000003');
    const parse = (remarks: string, wording = 'UPLIFT') => parseIndiaPostTrackingHtml(
      trackingHistoryHtml(SAMPLE_NUMBER, [{ ...event, event: wording, remarks }]), SAMPLE_NUMBER,
    ).events?.[0];
    const flight = parse('Flight No: ZZ0101 (From FRA To CDG)');
    expect(flight).toMatchObject({
      description: 'Flight ZZ0101 departed: Frankfurt Airport (FRA) → Paris Charles de Gaulle Airport (CDG)',
      location: 'Frankfurt Airport (FRA), Germany',
      stage: 'in_transit',
    });
    expect(locatePlace(flight?.location)).toMatchObject({ country: 'DE', name: 'Frankfurt' });
    expect(parse('Flight No: ZZ0101 (From FRA To CDG)', 'Aircraft Departure')).toEqual(flight);
    for (const remarks of [
      'private recipient details must never survive normalization',
      'Flight No: ZZ0101 (From FRA To CDG) private recipient details',
      'Flight No: ZZ0101 (From DEL To CDG)',
    ]) {
      expect(parse(remarks)?.description).toBe('Aircraft Departure');
      expect(JSON.stringify(parse(remarks))).not.toContain('private');
    }
    expect(classifyIndiaPostEvent('AircraftTakeOff', 'UPLIFT')).toEqual({ status: 'in_transit', stage: 'in_transit' });
  });

  it('re-reads only a take-off labelled UTC', () => {
    const times = (trackedAt: string, office: string) =>
      parseIndiaPostTrackingHtml(trackingHistoryHtml(SAMPLE_NUMBER, [takeOff(trackedAt, office)]), SAMPLE_NUMBER)
        .events?.map((event) => event.time);

    expect(times('2026-07-11T20:05:00+00:00', 'Office - CDG 00000003')).toEqual(['2026-07-11T20:05:00+02:00']);
    // Another offset is kept, and a value without one is on India's clock, as for any row.
    expect(times('2026-07-11T07:10:00+05:30', 'Office - DEL 00000002')).toEqual(['2026-07-11T07:10:00+05:30']);
    expect(times('2026-07-11T20:05:00+02:00', 'Office - CDG 00000003')).toEqual(['2026-07-11T20:05:00+02:00']);
    expect(times('2026-07-11T20:05:00', 'Office - CDG 00000003')).toEqual(['2026-07-11T20:05:00+05:30']);
  });

  it('locates mail arrival at the flight destination even when the office still names the origin', () => {
    const result = parseIndiaPostTrackingHtml(trackingHistoryHtml(SAMPLE_NUMBER, [
      { ...takeOff('2026-07-11T18:00:00Z', 'Office - FRA'), remarks: 'Flight No: ZZ0101 (From FRA To CDG)' },
      {
        tracked_at: '2026-07-12T10:15:00Z', event: 'MAIL_ARRIVED', event_type: 'MailArrived',
        office: 'Office - FRA', pincode: '110002', remarks: 'Flight No: ZZ0102 (From FRA To CDG)',
        pincode_info: { is_verified: true, office_name: 'Office - FRA', latitude: 28.6, longitude: 77.2 },
      },
    ]), SAMPLE_NUMBER);
    const arrival = result.events?.[0];
    expect(arrival).toEqual({
      time: '2026-07-12T10:15:00Z',
      description: 'Flight ZZ0102 arrived: Frankfurt Airport (FRA) → Paris Charles de Gaulle Airport (CDG)',
      location: 'Paris Charles de Gaulle Airport (CDG), France',
      stage: 'in_transit', provider_code: 'MailArrived',
    });
    expect(locatePlace(arrival?.location)).toMatchObject({ name: 'Paris', country: 'FR' });
    expect(result).toMatchObject({ last_status_text: arrival?.description, last_update: arrival?.time });
    expect(result.events?.[1]?.location).toBe('Frankfurt Airport (FRA), Germany');
  });

  it('requires a matching flight remark before moving a mail arrival away from its office', () => {
    const parse = (remarks: string, eventType = 'MailArrived', office = 'Office - FRA') =>
      parseIndiaPostTrackingHtml(trackingHistoryHtml(SAMPLE_NUMBER, [{
        tracked_at: '2026-07-12T10:15:00Z', event: 'MAIL_ARRIVED', event_type: eventType, office, remarks,
      }]), SAMPLE_NUMBER).events?.[0];
    for (const remarks of [
      '', 'private recipient details', 'Flight No: ZZ0102 (From FRA To CDG) private recipient details',
      'Flight No: ZZ0102 (From DEL To CDG)',
    ]) {
      // An office India Post does not name abroad has no location.
      expect(parse(remarks)).toMatchObject({ description: 'Mail Arrived', location: '' });
      expect(JSON.stringify(parse(remarks))).not.toContain('private');
    }
    expect(parse('Flight No: ZZ0102 (From FRA To CDG)', 'ItemReceived'))
      .toMatchObject({ description: 'Mail Arrived', location: '' });
    expect(parse('', 'MailArrived', 'Example Sorting Centre'))
      .toMatchObject({ description: 'Mail Arrived', location: 'Example Sorting Centre' });
    expect(parse('Flight No: ZZ0102 (From FRA To GRU)'))
      .toMatchObject({ description: 'Flight ZZ0102 arrived: Frankfurt Airport (FRA) → GRU', location: 'GRU Airport' });
  });

  it('leaves out an office India Post does not name and the foreign-mail PIN', () => {
    const location = (office: string, pincode: string) => parseIndiaPostTrackingHtml(trackingHistoryHtml(SAMPLE_NUMBER, [{
      tracked_at: '2026-07-12T10:15:00Z', event: 'Item Received', event_type: 'ItemReceived', office, pincode, remarks: '',
    }]), SAMPLE_NUMBER).events?.[0]?.location;
    expect(location('Example GPO', '110001')).toBe('Example GPO 110001');
    expect(location('Example GPO', '999001')).toBe('Example GPO');
    // The PIN still places a scan at an office India Post does not name, unless the office is abroad.
    expect(location('Office - 00000001', '110001')).toBe('110001');
    expect(location('Office - DEL 00000002', '110037')).toBe('110037');
    for (const office of ['Office - FRA', 'Office - DEFRA', 'Office - CDG 00000003']) expect(location(office, '400099'), office).toBe('');
    expect(location('Office - 00000001', '999001')).toBe('');
  });

  it('keeps rows newest first once a take-off is back on its own clock', () => {
    const result = parseIndiaPostTrackingHtml(trackingHistoryHtml(SAMPLE_NUMBER, [
      // 18:05 UTC on Paris's clock: before the 19:30 UTC scan it would outrank as labelled.
      takeOff('2026-07-11T20:05:00.000000Z', 'Office - CDG 00000003'),
      { tracked_at: '2026-07-11T19:30:00.000000Z', event: 'Item Received', event_type: 'ItemReceived', office: 'Example Office of Exchange', pincode: '', remarks: '' },
    ]), SAMPLE_NUMBER);

    expect(result.events?.map((event) => event.time)).toEqual(['2026-07-11T19:30:00Z', '2026-07-11T20:05:00+02:00']);
    expect(result).toMatchObject({ last_status_text: 'Item Received', last_update: '2026-07-11T19:30:00Z' });
  });

  it('produces every capability carrier.json declares', () => {
    expect(CAPABILITIES).toEqual(['history', 'location', 'provider_code', 'service_name']);
    const result = parseIndiaPostTrackingHtml(trackingHistoryHtml() + bookingCard('Consignment Details', {
      'Consignment #': SAMPLE_NUMBER, 'Article Type': 'Inland Speed Post', Tariff: '55.00 INR',
    }), SAMPLE_NUMBER);
    expect(result.service_name).toBe('Inland Speed Post');
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.events?.some((event) => event.provider_code)).toBe(true);
  });
});

describe('India Post scans abroad', () => {
  const parse = (destination?: string, events = INBOUND.tracking_events) => parseIndiaPostTrackingHtml(
    trackingHistoryHtml(SAMPLE_NUMBER, events, INBOUND.synced_at) + (destination ? bookingCards(destination) : ''),
    SAMPLE_NUMBER,
  );
  const clocks = (destination?: string, events = INBOUND.tracking_events) =>
    parse(destination, events).events?.map((event) => event.time ?? `local ${String(event.local_time)}`);

  it('reads the destination post\'s scans on its clock and names the country', () => {
    const result = parse('France');
    expect(result.events?.map((event) => [event.time, event.description, event.location])).toEqual([
      // Labelled 09:10Z, 02:20Z and 12:05Z: India's 14:40, 07:50 and 17:35, the clocks of France.
      // The foreign-mail PIN places no office, and an office India Post does not name has no location.
      ['2026-07-14T14:40:00+02:00', 'Send item to domestic location (Inb)', 'EXAMPLE EXCHANGE OFFICE'],
      ['2026-07-14T07:50:00+02:00', 'Item received at office of exchange (Inb)', 'EXAMPLE EXCHANGE OFFICE'],
      ['2026-07-13T17:35:00+02:00', 'Send item to domestic location (Inb)', ''],
      // India's own rows, and the bag's, keep their labels.
      ['2026-07-12T18:40:00Z', 'Bag unloaded at destination Airport', ''],
      ['2026-07-10T08:15:00Z', 'Transfer to OOE (Otb)', 'EXAMPLE FOREIGN POST OFFICE'],
      ['2026-07-08T05:40:00Z', 'Item Booked', 'Example GPO 110001'],
    ]);
    expect(result).toMatchObject({
      destination_country: 'FR', last_update: '2026-07-14T14:40:00+02:00', timezone: 'Asia/Kolkata',
    });
    expect(result).not.toHaveProperty('last_update_local');
  });

  it('proposes the destination\'s post for the same S10 number', () => {
    expect(deliveryHandoff('india-post', SAMPLE_NUMBER, parse('France')))
      .toEqual({ carrier: 'la-poste', number: SAMPLE_NUMBER, basis: 'destination' });
    expect(deliveryHandoff('india-post', SAMPLE_NUMBER, parse())).toBeNull();
  });

  it('keeps India\'s labels without a foreign destination', () => {
    const labelled = ['2026-07-14T09:10:00Z', '2026-07-14T02:20:00Z', '2026-07-13T12:05:00Z',
      '2026-07-12T18:40:00Z', '2026-07-10T08:15:00Z', '2026-07-08T05:40:00Z'];
    expect(clocks()).toEqual(labelled);
    expect(clocks('INDIA')).toEqual(labelled);
    expect(parse('INDIA')).toMatchObject({ destination_country: 'IN' });
    // Not a country name: no destination at all.
    for (const garbage of ['12345', 'France <b>75001</b>', 'x'.repeat(81)]) {
      expect(clocks(garbage)).toEqual(labelled);
      expect(parse(garbage)).not.toHaveProperty('destination_country');
      expect(parse(garbage)).not.toHaveProperty('destination_country_name');
    }
  });

  it('keeps a wall clock without an offset where the destination has no single zone', () => {
    for (const [destination, field] of [['United States', { destination_country: 'US' }], ['Atlantis', { destination_country_name: 'Atlantis' }]] as const) {
      expect(clocks(destination)?.slice(0, 4)).toEqual([
        'local 2026-07-14T14:40:00', 'local 2026-07-14T07:50:00', 'local 2026-07-13T17:35:00', '2026-07-12T18:40:00Z',
      ]);
      expect(parse(destination)).toMatchObject({ ...field, last_update: null, last_update_local: '2026-07-14T14:40:00' });
    }
  });

  it('picks the same rows in a reply worded in bare codes', () => {
    const result = parse('France', INBOUND_CODES.tracking_events);
    expect(result.events?.map((event) => [event.time, event.provider_code, event.location])).toEqual([
      ['2026-07-14T14:40:00+02:00', 'ItemDispatched', 'EXAMPLE EXCHANGE OFFICE'],
      ['2026-07-14T07:50:00+02:00', 'ItemReceived', 'EXAMPLE EXCHANGE OFFICE'],
      ['2026-07-13T17:35:00+02:00', 'ItemDispatched', ''],
      // The arrival in France places the rows after it; it keeps its label.
      ['2026-07-12T18:40:00Z', 'MailArrived', 'Paris Charles de Gaulle Airport (CDG), France'],
      ['2026-07-10T08:15:00Z', 'ItemTransfered', 'EXAMPLE FOREIGN POST OFFICE'],
      ['2026-07-08T05:40:00Z', 'ItemBooked', 'Example GPO 110001'],
    ]);
    // An arrival in another country does not; with neither, the labels stay.
    const elsewhere = INBOUND_CODES.tracking_events.map((row) => (
      row.event_type === 'MailArrived' ? { ...row, remarks: 'Flight No: ZZ0102 (From FRA To LHR)' } : row));
    expect(clocks('France', elsewhere)?.slice(0, 3))
      .toEqual(['2026-07-14T09:10:00Z', '2026-07-14T02:20:00Z', '2026-07-13T12:05:00Z']);
  });

  it('keeps India\'s clock on a way back', () => {
    const transfer = { tracked_at: '2026-07-20T06:00:00.000000Z', event_type: 'ItemTransfered', office: 'EXAMPLE EXCHANGE OFFICE', pincode: '' };
    const received = { tracked_at: '2026-07-25T04:30:00.000000Z', event_type: 'ItemReceived', office: 'EXAMPLE FOREIGN POST OFFICE', pincode: '' };
    const returned = (events: Array<Record<string, unknown>>, ...after: Array<Record<string, unknown>>) =>
      clocks('France', [...events, ...after])?.slice(0, after.length + 1);
    expect(returned(INBOUND.tracking_events,
      { ...transfer, event: 'Transfer to OOE (Otb)', remarks: 'Transfer to OOE (Otb)' },
      { ...received, event: 'Item received at office of exchange (Inb)', remarks: 'Item received at office of exchange (Inb)' },
    )).toEqual(['2026-07-25T04:30:00Z', '2026-07-20T06:00:00Z', '2026-07-14T14:40:00+02:00']);
    expect(returned(INBOUND_CODES.tracking_events,
      { ...transfer, event: 'TRANSFER_OOE', remarks: '' }, { ...received, event: 'ITEM_RECEIVE', remarks: '' },
    )).toEqual(['2026-07-25T04:30:00Z', '2026-07-20T06:00:00Z', '2026-07-14T14:40:00+02:00']);
    // Landing in India again.
    expect(returned(INBOUND_CODES.tracking_events,
      { tracked_at: '2026-07-22T10:00:00.000000Z', event: 'MAIL_ARRIVED', event_type: 'MailArrived', office: 'Office - CDG', pincode: '', remarks: 'Flight No: ZZ0201 (From CDG To DEL)' },
      { ...received, event: 'ITEM_RECEIVE', remarks: '' },
    )).toEqual(['2026-07-25T04:30:00Z', '2026-07-22T10:00:00Z', '2026-07-14T14:40:00+02:00']);
  });
});

describe('India Post Livewire session', () => {
  it('uses a recently synced cached response without unnecessary polling', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      pageHtml(SAMPLE_NUMBER, 'Completed', trackingHistoryHtml(SAMPLE_NUMBER, undefined, '2026-09-01T12:00:00Z')),
    ));

    await expect(new IndiaPostTracker({ fetcher, now: () => new Date('2026-09-01T12:20:00Z') }).fetch(SAMPLE_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes a stale cached response the way the page\'s Refresh button does', async () => {
    const stale = [structuredClone(EXPORT_CUSTOMS.tracking_events[0]!)];
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(pageHtml(SAMPLE_NUMBER, 'Completed',
        trackingHistoryHtml(SAMPLE_NUMBER, stale, '2026-06-01T10:00:00Z'))))
      .mockResolvedValueOnce(livewireResponse(SAMPLE_NUMBER, 'Processing', { dispatches: [{ name: 'consignment_created', params: [] }] }))
      .mockResolvedValueOnce(livewireResponse(SAMPLE_NUMBER, 'Completed', {
        html: trackingHistoryHtml(SAMPLE_NUMBER, EXPORT_CUSTOMS.tracking_events, EXPORT_CUSTOMS.synced_at),
      }));

    const result = await new IndiaPostTracker({ fetcher, pollIntervalMs: 0, now: () => new Date('2026-06-20T08:05:00Z') })
      .fetch(SAMPLE_NUMBER);
    expect(result).toMatchObject({ last_status_text: 'Transferred to Office of Exchange', source_synced_at: '2026-06-20T08:00:00Z' });
    expect(result.events).toHaveLength(7);
    const refresh = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(refresh.components[0].calls).toEqual([{
      path: '', method: '__dispatch', params: ['refresh_consignment', { userTimezone: 'Europe/Zurich' }],
    }]);
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)).components[0].calls[0].method).toBe('fetchStatus');
  });

  it('keeps the cached history when a refresh fails', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(pageHtml(SAMPLE_NUMBER, 'Completed', trackingHistoryHtml())))
      .mockResolvedValueOnce(new Response('<title>Just a moment...</title>', { status: 403 }));

    // No synced_at at all cannot prove freshness either.
    await expect(new IndiaPostTracker({ fetcher }).fetch(SAMPLE_NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the cached history without a refresh when the page asks for Turnstile', async () => {
    const widget = '<div class="cf-turnstile" data-sitekey="synthetic"></div>';
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(pageHtml(SAMPLE_NUMBER, 'Completed', trackingHistoryHtml() + widget)));

    await expect(new IndiaPostTracker({ fetcher }).fetch(SAMPLE_NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects without another poll when the caller cancels during a refresh', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(pageHtml(SAMPLE_NUMBER, 'Completed', trackingHistoryHtml())))
      .mockResolvedValueOnce(livewireResponse(SAMPLE_NUMBER, 'Processing'));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const controller = new AbortController();
    const cancelled = new Error('caller cancelled');

    const lookup = new IndiaPostTracker({ fetcher, pollIntervalMs: 60_000 }).fetch(SAMPLE_NUMBER, { signal: controller.signal });
    await vi.waitFor(() => expect(timers).toHaveBeenCalledWith(expect.any(Function), 60_000));
    controller.abort(cancelled);

    await expect(lookup).rejects.toBe(cancelled);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps the cached history when the deadline passes during a refresh', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(pageHtml(SAMPLE_NUMBER, 'Completed', trackingHistoryHtml())))
      .mockResolvedValueOnce(livewireResponse(SAMPLE_NUMBER, 'Processing'));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const controller = new AbortController();

    const lookup = new IndiaPostTracker({ fetcher, pollIntervalMs: 60_000 }).fetch(SAMPLE_NUMBER, { signal: controller.signal });
    await vi.waitFor(() => expect(timers).toHaveBeenCalledWith(expect.any(Function), 60_000));
    // What the runner's step signal does when the lookup budget is spent.
    controller.abort(new DOMException('Timed out', 'TimeoutError'));

    await expect(lookup).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('submits and polls a new valid-shaped wrong number into a clean 404', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(pageHtml(WRONG_VALID_NUMBER, 'New')))
      .mockResolvedValueOnce(livewireResponse(WRONG_VALID_NUMBER, 'Processing'))
      .mockResolvedValueOnce(livewireResponse(WRONG_VALID_NUMBER, 'Completed', {
        dispatches: [{
          name: 'consignment_not_found',
          params: { consignment_number: WRONG_VALID_NUMBER },
        }],
        html: trackingHistoryHtml(WRONG_VALID_NUMBER),
      }));

    await expect(new IndiaPostTracker({
      fetcher,
      pollIntervalMs: 0,
      maxPollAttempts: 2,
    }).fetch(WRONG_VALID_NUMBER)).rejects.toBeInstanceOf(NotFoundError);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/track?');
    expect(String(fetcher.mock.calls[1]?.[0])).toBe('https://myspeedpost.com/livewire/update');
    expect(String(fetcher.mock.calls[2]?.[0])).toBe('https://myspeedpost.com/livewire/update');

    const submitted = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(submitted.components[0].calls.map((call: { method: string }) => call.method))
      .toEqual(['__dispatch', 'submit']);
    const polled = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(polled.components[0].calls).toEqual([{
      path: '',
      method: 'fetchStatus',
      params: [],
    }]);
  });

  it('reads the history a page in another state still carries, and is inconclusive without one', async () => {
    const withHistory = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      pageHtml(SAMPLE_NUMBER, 'Failed', trackingHistoryHtml(SAMPLE_NUMBER, undefined, '2026-09-01T12:00:00Z')),
    ));
    await expect(new IndiaPostTracker({ fetcher: withHistory }).fetch(SAMPLE_NUMBER))
      .resolves.toMatchObject({ status: 'delivered', source_synced_at: '2026-09-01T12:00:00Z' });
    expect(withHistory).toHaveBeenCalledTimes(1);

    const bare = vi.fn<typeof fetch>().mockResolvedValue(new Response(pageHtml(SAMPLE_NUMBER, 'Failed')));
    const error: unknown = await new IndiaPostTracker({ fetcher: bare }).fetch(SAMPLE_NUMBER).catch((caught: unknown) => caught);
    expect(carrierErrorKind(error)).toBe('indeterminate');
    expect(String(error)).toContain('in the Failed state');
  });

  it('stops polling at another state without naming what it cannot read', async () => {
    const poll = (effects: Record<string, unknown>) => vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(pageHtml(SAMPLE_NUMBER, 'New')))
      .mockResolvedValueOnce(livewireResponse(SAMPLE_NUMBER, 'Processing'))
      .mockResolvedValueOnce(livewireResponse(SAMPLE_NUMBER, 'Queued <b>', effects));

    const bare = poll({});
    const error: unknown = await new IndiaPostTracker({ fetcher: bare, pollIntervalMs: 0 }).fetch(SAMPLE_NUMBER)
      .catch((caught: unknown) => caught);
    expect(carrierErrorKind(error)).toBe('indeterminate');
    expect(String(error)).toContain('in the unrecognised state');
    expect(bare).toHaveBeenCalledTimes(3);

    const withHistory = poll({ html: trackingHistoryHtml() });
    await expect(new IndiaPostTracker({ fetcher: withHistory, pollIntervalMs: 0 }).fetch(SAMPLE_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
  });

  it('keeps Cloudflare and malformed pages retryable instead of reporting not found', async () => {
    const challenged = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      '<title>Just a moment...</title>',
      { status: 403, headers: { 'CF-Mitigated': 'challenge' } },
    ));
    await expect(new IndiaPostTracker({ fetcher: challenged }).fetch(SAMPLE_NUMBER))
      .rejects.toBeInstanceOf(IndiaPostChallengeError);

    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>maintenance</html>'));
    await expect(new IndiaPostTracker({ fetcher: malformed }).fetch(SAMPLE_NUMBER))
      .rejects.toThrow('tracking component');
  });

  it('reports a rate limit and the Turnstile check that follows it, never not found', async () => {
    const limited = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(pageHtml(SAMPLE_NUMBER, 'New')))
      .mockResolvedValueOnce(livewireResponse(SAMPLE_NUMBER, 'New', {
        dispatches: [
          { name: 'set_consignment_number', params: { consignment_number: SAMPLE_NUMBER } },
          { name: 'log_event', params: { name: 'tracking_rate_limited' } },
        ],
      }));
    const error: unknown = await new IndiaPostTracker({ fetcher: limited, pollIntervalMs: 0 }).fetch(SAMPLE_NUMBER)
      .catch((caught: unknown) => caught);
    expect(carrierErrorKind(error)).toBe('rate_limited');
    expect(limited).toHaveBeenCalledTimes(2);

    const widget = '<div class="cf-turnstile" data-sitekey="synthetic"></div>';
    const gated = vi.fn<typeof fetch>().mockResolvedValue(new Response(pageHtml(SAMPLE_NUMBER, 'New', widget)));
    await expect(new IndiaPostTracker({ fetcher: gated }).fetch(SAMPLE_NUMBER))
      .rejects.toBeInstanceOf(IndiaPostChallengeError);
    expect(gated).toHaveBeenCalledTimes(1);

    const reset = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(pageHtml(SAMPLE_NUMBER, 'New')))
      .mockResolvedValueOnce(livewireResponse(SAMPLE_NUMBER, 'New', { dispatches: [{ name: 'turnstile-reset', params: [] }] }));
    await expect(new IndiaPostTracker({ fetcher: reset, pollIntervalMs: 0 }).fetch(SAMPLE_NUMBER))
      .rejects.toBeInstanceOf(IndiaPostChallengeError);
  });

  it('reads an ordinary page carrying Cloudflare\'s passive detection loader', async () => {
    const loader = '<script>window.__CF$cv$params={r:\'0\',t:\'0\'};var a=document.createElement(\'script\');'
      + 'a.src=\'/cdn-cgi/challenge-platform/scripts/jsd/main.js\';document.head.appendChild(a);</script>';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(pageHtml(SAMPLE_NUMBER, 'Completed',
      trackingHistoryHtml(SAMPLE_NUMBER, undefined, '2026-09-01T12:00:00Z') + loader)));

    await expect(new IndiaPostTracker({ fetcher, now: () => new Date('2026-09-01T12:20:00Z') }).fetch(SAMPLE_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
  });
});
