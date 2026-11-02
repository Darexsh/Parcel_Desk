// @vitest-environment node
import { readFileSync } from 'node:fs';
import timers from 'node:timers/promises';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrawlClient } from '../../core/transport/index.js';
import { carrierErrorKind, IndeterminateError, InputRequiredError, NoHistoryError } from '../../core/errors/index.js';
import type { LookupRecord, StepRecord, StepRecorder } from '../../core/telemetry/index.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { ParcelsAppTracker, parseParcelsAppHtml, parseParcelsAppResponse } from './adapter.js';

const number = 'ZZ12345678900';
const API = 'https://parcelsapp.com/api/v2/parcels';
const announced = JSON.parse(readFileSync(new URL('./fixtures/announced.json', import.meta.url), 'utf8')) as { states: unknown[] };
const undatedLeg = JSON.parse(readFileSync(new URL('./fixtures/undated-leg.json', import.meta.url), 'utf8')) as { carriers: string[]; states: Record<string, unknown>[] };

/** The result table the page renders; the API reply itself carries no number. */
const identity = (value = number) => `<div class="tracking-info"><div class="parcel"><table class="parcel-attributes"><tr><td>Tracking number</td><td>${value}</td></tr></table></div></div>`;
const rendered = (rows: string) => identity().replace('</table>', `</table><ul class="events">${rows}</ul>`);
const row = (date: string, time: string, description: string) =>
  `<li class="event"><div class="event-time"><strong>${date}</strong><span>${time}</span></div><div class="event-content"><strong>${description}</strong></div></li>`;
const carrierRow = (date: string, time: string, description: string, carrier: string) =>
  `<li class="event"><div class="event-time"><strong>${date}</strong><span>${time}</span></div><div class="event-content"><strong>${description}</strong><div class="carrier"><div class="courier-icon"></div> ${carrier} </div></div></li>`;

it('keeps scan locations from the API while excluding a delivery-service label and Posti\'s "abroad"', () => {
  const parse = (location: unknown) => parseParcelsAppResponse({
    carriers: ['Chronopost'], states: [{ date: '2026-07-12T10:15:00Z', status: 'In transit', carrier: 0, location }],
  }, number, identity()).events?.[0];
  expect(parse('  Example   Sorting Centre, France  ')?.location).toBe('Example Sorting Centre, France');
  expect(parse('France')?.location).toBe('France');
  // A Post Office branch's postcode, which Royal Mail appends in brackets, is left out; other brackets stay.
  expect(parse('Example Post Office [ZZ9 9ZZ]')?.location).toBe('Example Post Office');
  expect(parse('Example DO [Main]')?.location).toBe('Example DO [Main]');
  // A posting office's postcode given alone names its country at most.
  expect(parse('PL99999')?.location).toBe('Poland');
  expect(parse('LV-9999')?.location).toBe('Latvia');
  for (const location of ['99999', '999999', 'ZZ99999', 'EU9999']) expect(parse(location), location).not.toHaveProperty('location');
  expect(parse('ZTO9999')?.location).toBe('ZTO9999');
  for (const location of [undefined, '', 'Type de livraison : Livraison Standard', 'ULKOMAILLA', ['France'], { city: 'Example City' }]) {
    expect(parse(location)).not.toHaveProperty('location');
  }
  // Labels that name no place, and the words before a depot's town.
  for (const location of ['US, SYSTEM, SYSTEM', 'SYSTEM', 'UNI DATA CENTER', 'Linehaul Agent', 'Centro Di Smistamento - Hub',
    'International Postal System', '目的国']) {
    expect(parse(location), location).not.toHaveProperty('location');
  }
  expect(parse('from the operational headquarters in EXAMPLE TOWN (Example Region)')?.location).toBe('EXAMPLE TOWN (Example Region)');
  expect(parse('dalla sede operativa di EXAMPLE TOWN (XX)')?.location).toBe('EXAMPLE TOWN (XX)');
  // Correios Brazil's "País" label before a unit abroad, translated.
  expect(parse('Country, EXAMPLELAND')?.location).toBe('EXAMPLELAND');
  expect(parse('Country, International Treatment Unit')?.location).toBe('International Treatment Unit');
  expect(parse('País - EXAMPLELAND')?.location).toBe('EXAMPLELAND');
  expect(parse('Country Club Road, Example City')?.location).toBe('Country Club Road, Example City');
  for (const location of ['Example System Park, US', 'Centro Di Smistamento Example Town', 'Example Data Center Road, Example City']) {
    expect(parse(location)?.location).toBe(location);
  }
  // The destination's country a line appends to its warehouse in China, and a country given twice.
  expect(parse('广州,US')?.location).toBe('广州');
  expect(parse('Shanghai, United States')?.location).toBe('Shanghai');
  expect(parse('Example City, Guangdong, GB')?.location).toBe('Example City, Guangdong');
  expect(parse('Example State, United States, United States')?.location).toBe('Example State, United States');
  for (const location of ['Shanghai, China', '示例市,TW', '東京, JP', 'Example City,UNITED STATES', 'Luxembourg, Luxembourg', 'Example City, IN, US']) {
    expect(parse(location)?.location).toBe(location);
  }
  // A part given twice in a row, read once, unless it is the country after a town of its name.
  expect(parse('SH,SH,CN')?.location).toBe('SH, CN');
  expect(parse('EXAMPLE TOWN, Example Town, DE')?.location).toBe('EXAMPLE TOWN, DE');
  expect(parse('Mexico, Mexico')?.location).toBe('Mexico, Mexico');
  expect(parse('00000,00000')).not.toHaveProperty('location');
});

it('keeps the reported place when another carrier repeats a delivery without a location', () => {
  const result = parseParcelsAppResponse({ carriers: ['Chronopost', 'DHL'], states: [
    { date: '2026-07-12T10:15:00Z', status: 'Livraison effectuée', carrier: 0, location: 'Example Sorting Centre, France' },
    { date: '2026-07-12T10:15:00Z', status: 'Delivered', carrier: 1 },
  ] }, number, identity(), 'Europe/Paris');
  expect(result.events).toHaveLength(1);
  expect(result.events?.[0]).toMatchObject({ description: 'Delivered', location: 'Example Sorting Centre, France' });
});

const captured = (data: unknown, overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
  url: `https://parcelsapp.com/en/tracking/${number}`, html: identity(), statusCode: 200, tier: 3,
  capturedResponses: [{ url: API, body: JSON.stringify(data), status: 200, truncated: false, base64Encoded: false }],
  ...overrides,
}));

function tracker(fetcher: typeof fetch, trawlUrl = 'http://browser.test') {
  return new ParcelsAppTracker({ httpClient: null, trawl: new TrawlClient(trawlUrl, fetcher) });
}

describe('ParcelsApp YTO scans', () => {
  // YTO's scan types as ParcelsApp relays them, in Chinese or in its own translation.
  const labels = {
    chinese: ['揽收扫描', '装件入车扫描', '下车扫描', '派件扫描', '入柜|入库', 'PDA正常签收扫描', '退回件扫描'],
    english: ['Pickup scan', 'Load scan into vehicle', 'Get off scan', 'Delivery scan', 'In cabinet | In storage', 'PDA normal delivery scan', 'Return package scan'],
  };
  // ParcelsApp labels the scans' China wall clock as UTC.
  const states = (names: string[], order: number[]) => order.map((index, position) => ({
    date: `2026-05-0${position + 1}T18:00:00Z`, status: names[index], carrier: 0,
  })).reverse();
  const history = (language: keyof typeof labels, order: number[]) =>
    parseParcelsAppResponse({ carriers: ['YTO Express'], states: states(labels[language], order) }, number, identity());

  it('gives both label languages the same stages and stored wording', () => {
    const chinese = history('chinese', [0, 1, 2, 3, 4, 5]);
    expect(history('english', [0, 1, 2, 3, 4, 5]).events).toEqual(chinese.events);
    expect(chinese.events?.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(chinese).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(chinese.events?.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2026-05-06T10:00:00.000Z', 'Delivered', 'delivered'],
      ['2026-05-05T10:00:00.000Z', 'In a parcel locker or pickup station', 'ready_for_pickup'],
      ['2026-05-04T10:00:00.000Z', 'Out for delivery', 'out_for_delivery'],
      ['2026-05-03T10:00:00.000Z', 'Unloaded at a sorting centre', 'in_transit'],
      ['2026-05-02T10:00:00.000Z', 'Loaded for transport', 'in_transit'],
      ['2026-05-01T10:00:00.000Z', 'Picked up', 'accepted'],
    ]);
  });

  it.each(['chinese', 'english'] as const)('reads the delivery-side scans after a return scan as the trip back (%s)', (language) => {
    const returned = history(language, [0, 1, 6, 3, 4, 5]);
    expect(returned).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned to the sender' });
    expect(returned.events?.slice(0, 4).map((event) => [event.description, event.stage])).toEqual([
      ['Returned to the sender', 'returned'],
      ['In a parcel locker or station on its way back', 'ready_for_pickup'],
      ['Out for delivery back to the sender', 'out_for_delivery'],
      ['Return to the sender started', 'exception'],
    ]);
  });

  it.each(['chinese', 'english'] as const)('keeps return transit open before sender delivery (%s)', language => {
    expect(history(language, [0, 1, 6])).toMatchObject({ status: 'exception', current_stage: 'exception' });
    expect(history(language, [0, 1, 6, 3])).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(history(language, [0, 1, 6, 3, 4])).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    expect(history(language, [0, 1, 6, 3, 4]).events?.[0]).toMatchObject({ provider_leg: 'return' });
  });

  it('leaves labels of other carriers and unknown YTO labels to the shared rules', () => {
    const other = parseParcelsAppResponse({ carriers: ['Example Parcel Co'], states: [{ date: '2026-05-01T18:00:00Z', status: '派件扫描', carrier: 0 }] }, number, identity());
    expect(other.events?.[0]).toMatchObject({ description: '派件扫描', stage: 'pending', stage_source: 'none' });
    const unknown = parseParcelsAppResponse({ carriers: ['YTO Express'], states: [{ date: '2026-05-01T18:00:00Z', status: '问题件扫描', carrier: 0 }] }, number, identity());
    expect(unknown.events?.[0]).toMatchObject({ description: '问题件扫描', stage: 'pending', stage_source: 'none' });
  });

  it("reads CDEK's relayed leg labels by CDEK's vocabulary and keeps their wording", () => {
    const labels = ['Принят в городе отправителя', 'Отправлен в город получателя', 'В транзитном городе', 'Принят в городе получателя', 'На доставке у курьера', 'Вручено'];
    const states = (count: number) => labels.slice(0, count).map((status, index) => ({ date: `2026-05-01T07:00:0${index}Z`, status, carrier: 0 })).reverse();
    const delivered = parseParcelsAppResponse({ carriers: ['CDEK'], states: states(6) }, number, identity());
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Вручено' });
    expect(delivered.events?.map((event) => [event.description, event.stage, event.stage_source])).toEqual([
      ['Вручено', 'delivered', 'carrier_map'],
      ['На доставке у курьера', 'out_for_delivery', 'carrier_map'],
      ['Принят в городе получателя', 'in_transit', 'carrier_map'],
      ['В транзитном городе', 'in_transit', 'carrier_map'],
      ['Отправлен в город получателя', 'in_transit', 'carrier_map'],
      ['Принят в городе отправителя', 'accepted', 'carrier_map'],
    ]);
    expect(parseParcelsAppResponse({ carriers: ['CDEK'], states: states(1) }, number, identity())).toMatchObject({ current_stage: 'accepted' });
  });

  it("reads Croatia Post's relayed labels by its own map and a post abroad on that office's clock", () => {
    // Shape of ParcelsApp's copy of Hrvatska pošta's tracker: its wall clocks under a UTC label.
    const parcel = (rows: string[][]) => parseParcelsAppResponse({ carriers: ['Croatia Post'],
      states: rows.map(([date, status, location]) => ({ date, status, location, carrier: 0 })) }, number, identity());
    const parsed = parcel([
      ['2026-10-14T05:46:00Z', 'The shipment has been handed over to the parcelstation', ''],
      ['2026-10-12T11:25:00Z', 'Delivery attempt', ''],
      ['2026-10-10T20:47:00Z', 'Item received in destination country', 'GBEXAA EXAMPLE HUB'],
      ['2026-10-10T04:37:00Z', 'Item received', 'GBEXAA EXAMPLE HUB'],
      ['2026-10-09T03:08:00Z', 'Item sent', '10000 EXAMPLE CITY'],
      ['2026-10-06T10:23:00Z', 'Item received', '20000 EXAMPLE TOWN'],
    ]);
    expect(parsed).toMatchObject({ current_stage: 'ready_for_pickup' });
    // A scan without an office can be the destination post's, on its clock: its wall clock stays.
    expect(parsed.events?.map((event) => [event.description, event.stage, event.time ?? event.local_time])).toEqual([
      ['The shipment has been handed over to the parcelstation', 'ready_for_pickup', '2026-10-14T05:46:00.000'],
      ['Delivery attempt', 'failed_attempt', '2026-10-12T11:25:00.000'],
      ['Item received in destination country', 'in_transit', '2026-10-10T19:47:00.000Z'],
      ['Item received', 'in_transit', '2026-10-10T03:37:00.000Z'],
      ['Item sent', 'in_transit', '2026-10-09T01:08:00.000Z'],
      ['Item received', 'accepted', '2026-10-06T08:23:00.000Z'],
    ]);
    // An office abroad in a country of several zones names no clock.
    expect(parcel([['2026-10-10T04:37:00Z', 'Item received', 'USEXAA EXAMPLE HUB']]).events?.[0])
      .toMatchObject({ local_time: '2026-10-10T04:37:00.000' });
    // A delivery once the item is on its way back reaches its sender.
    expect(parcel([['2026-10-20T09:00:00Z', 'Item delivered', '20000 EXAMPLE TOWN'],
      ['2026-10-18T09:00:00Z', 'Item returned to sender', '20000 EXAMPLE TOWN']])).toMatchObject({ current_stage: 'returned' });
  });

  it("reads Mayi Yinfu's relayed airport hand-over as transit, and its delivery abroad as a delivery", () => {
    const parcel = (states: Record<string, unknown>[]) => parseParcelsAppResponse({ carriers: ['DHL Parcel Spain', 'Mayiyinfu'],
      originCode: 'CN', destinationCode: 'ES', states }, number, identity());
    const handOver = parcel([
      { date: '2026-10-03T19:41:20Z', status: 'Delivered', carrier: 1, location: 'China' },
      { date: '2026-10-03T12:50:07Z', status: '已排航班', carrier: 1, location: 'SZ' },
    ]);
    expect(handOver).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(handOver.events?.[0]).toMatchObject({ description: 'The goods have been delivered to the airport', stage: 'in_transit', stage_source: 'carrier_map' });
    // The flight booked for the parcel is still to come: no scan.
    expect(handOver.events).toHaveLength(1);
    // The delivery the forwarder copies, and another carrier's bare "Delivered", stay deliveries.
    for (const state of [{ status: 'The shipment has been successfully delivered', carrier: 1, location: 'ES' },
      { status: 'Delivered', carrier: 1, location: 'Example City, Spain' }, { status: 'Delivered', carrier: 0, location: 'China' }]) {
      expect(parcel([{ date: '2026-10-16T15:10:00Z', ...state }])).toMatchObject({ status: 'delivered' });
    }
  });

  it('reads the same scans from the rendered page', () => {
    const scan = (day: string, description: string) =>
      `<li class="event"><div class="event-time"><strong>0${day} May 2026</strong><span>18:00</span></div><div class="event-content"><strong>${description}</strong><span class="carrier">YTO Express</span></div></li>`;
    const page = rendered([scan('2', 'PDA正常签收扫描'), scan('1', '揽收扫描')].join(''));
    expect(parseParcelsAppHtml(page, number).events?.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2026-05-02T10:00:00.000Z', 'Delivered', 'delivered'],
      ['2026-05-01T10:00:00.000Z', 'Picked up', 'accepted'],
    ]);
  });
});

describe('ParcelsApp result parsing', () => {
  it('does not treat postal-code prompts or delivery preferences as movement', () => {
    const result = parseParcelsAppResponse(announced, number, identity());
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', tracking_provider: 'ParcelsApp' });
    expect(result.events).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    // An address in place of the destination names no country.
    expect(result.destination_country).toBeUndefined();
    expect(() => parseParcelsAppResponse({ states: [{ date: '2026-08-18T00:00:00Z', status: 'Enter the recipient postal code', require_fields: [{}] }] }, number, identity())).toThrow();
    // A prompt to track the parcel on a partner's site, a drop-off place the recipient booked or their details updated is no scan either.
    const prompted = parseParcelsAppResponse({ states: [{ date: '2026-08-19T00:00:00Z', status: 'Track Sendcloud shipment by tapping the button' },
      { date: '2026-08-18T12:00:00Z', status: 'A preferred drop-off location was booked for the shipment' },
      { date: '2026-08-18T11:00:00Z', status: 'Recipient information updated' }, ...announced.states] }, number, identity());
    expect(prompted.events?.map(({ description }) => description)).toEqual(result.events?.map(({ description }) => description));
    // ParcelsApp's own check of the number comes as a state dated at the lookup: no scan, so no history.
    expect(() => parseParcelsAppResponse({ states: [{ date: '2026-08-19T00:00:00Z',
      status: 'Tracking number must contain only capital letters and digits. Please check that tracking number is correct.' }] }, number, identity()))
      .toThrow('No usable tracking events');
  });

  it.each(['json', 'html'])('classifies French preparation and a Mondial Relay hub scan separately (%s)', (transport) => {
    // Synthetic identifier, dates and depot; preserve only the wording that caused the bug.
    const states = [
      { date: '2026-01-05T08:30:00Z', status: 'Prise en charge de votre colis sur notre site logistique de VILLE-EXEMPLE.' },
      { date: '2026-01-04T09:15:00Z', status: "Colis en préparation chez l'expéditeur" },
    ];
    const parsed = transport === 'json' ? parseParcelsAppResponse({ states }, number, identity(), 'Europe/Paris')
      : parseParcelsAppHtml(rendered(row('05 Jan 2026', '08:30', states[0]!.status) + row('04 Jan 2026', '09:15', states[1]!.status)), number,
        'Europe/Paris');
    // Every logistics site logs its own "prise en charge": movement, not acceptance.
    expect(parsed).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_update: '2026-01-05T07:30:00.000Z', tracking_provider: 'ParcelsApp' });
    expect(parsed.events?.map(({ stage }) => stage)).toEqual(['in_transit', 'registered']);
    const preparationOnly = parseParcelsAppResponse({ states: [states[1]] }, number, identity());
    expect(preparationOnly).toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it.each(['json', 'html'])('reads the TIPSA labels it relays twice over (%s)', (transport) => {
    // TIPSA's wording, written twice as ParcelsApp relays it; synthetic dates and agency.
    const scans = [
      ['08', '18:50', 'ENTREGADO'],
      ['07', '08:30', 'REPARTO'],
      ['06', '15:00', 'Ausente'],
      ['06', '08:30', 'REPARTO'],
      ['05', '17:20', 'LECTURA EN AGENCIA DESTINO EJEMPLO 01'],
      ['05', '17:10', 'LEIDO EN DESTINO'],
      ['02', '22:20', 'TRANSITO'],
      ['02', '17:50', 'PENDIENTE DE ENTREGAR A TIPSA'],
    ] as const;
    const parsed = transport === 'json'
      ? parseParcelsAppResponse({ carriers: ['TIPSA'], states: scans.map(([day, time, label]) => ({
        date: `2026-05-${day}T${time}:00Z`, status: label + label, carrier: 0,
      })) }, number, identity())
      : parseParcelsAppHtml(rendered(scans.map(([day, time, label]) => carrierRow(`${day} May 2026`, time, label + label, 'TIPSA')).join('')), number);
    expect(parsed).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered' });
    // TIPSA's history is on Madrid time, Portuguese agencies included.
    expect(parsed.events?.map(({ time, description, stage }) => [time, description, stage])).toEqual([
      ['2026-05-08T16:50:00.000Z', 'Delivered', 'delivered'],
      ['2026-05-07T06:30:00.000Z', 'REPARTO', 'out_for_delivery'],
      ['2026-05-06T13:00:00.000Z', 'Ausente', 'failed_attempt'],
      ['2026-05-06T06:30:00.000Z', 'REPARTO', 'out_for_delivery'],
      ['2026-05-05T15:20:00.000Z', 'LECTURA EN AGENCIA DESTINO EJEMPLO 01', 'in_transit'],
      ['2026-05-05T15:10:00.000Z', 'LEIDO EN DESTINO', 'in_transit'],
      ['2026-05-02T20:20:00.000Z', 'TRANSITO', 'in_transit'],
      ['2026-05-02T15:50:00.000Z', 'PENDIENTE DE ENTREGAR A TIPSA', 'registered'],
    ]);
  });

  it('collapses only a label made of two identical halves', () => {
    const parsed = parseParcelsAppResponse({ states: [
      { date: '2026-05-02T10:00:00Z', status: 'ENTREGADOENTREGADA' },
      { date: '2026-05-01T10:00:00Z', status: 'REPARTO REPARTO' },
    ] }, number, identity());
    expect(parsed.events?.map(({ description }) => description)).toEqual(['ENTREGADOENTREGADA', 'REPARTO REPARTO']);
  });

  it('binds a numberless response to its rendered result', () => {
    for (const html of [identity('OTHER123'), `<input value="${number}">`, identity() + identity()]) {
      expect(() => parseParcelsAppResponse(announced, number, html)).toThrow('identity missing');
    }
  });

  it('rejects malformed timestamps and error-only responses', () => {
    // Unlike a missing date, a malformed one fails the reply, even beside dated scans.
    for (const date of ['today', '2026-02-31T03:04:00', '2026-02-31T03:04:00Z']) {
      const states = [{ date, status: 'Delivered' }, { date: '2026-08-17T03:04:00Z', status: 'In transit' }];
      expect(() => parseParcelsAppResponse({ states }, number, identity())).toThrow();
    }
    expect(() => parseParcelsAppResponse({ error: 'NO_TRACKER', states: [] }, number, identity())).toThrow();
  });

  it('counts a state without a date instead of failing the reply or reading it as the latest scan', () => {
    // Live shape (2026-09-29): an Asendia Spain leg with no date after dated US scans.
    const undated = undatedLeg.states.find((state) => !('date' in state))!;
    const dated = undatedLeg.states.filter((state) => state !== undated);
    for (const states of [undatedLeg.states, [{ ...undated, date: null, status: 'Delivered' }, ...dated]]) {
      const parsed = parseParcelsAppResponse({ ...undatedLeg, states }, number, identity());
      expect(parsed).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Dispatched by Asendia',
        last_update: '2026-03-10T18:10:00.000Z', undated_event_count: 1 });
      // WNDirect, outside the catalog, has no location and no parcel carrier's zone: its wall clock.
      expect(parsed.events?.map((scan) => scan.time ?? scan.local_time)).toEqual(dated.map((state) => state.carrier === 0
        ? DateTime.fromISO(String(state.date), { zone: 'UTC' }).toISO({ includeOffset: false })
        : DateTime.fromISO(String(state.date)).toUTC().toISO()));
    }
    expect(() => parseParcelsAppResponse({ ...undatedLeg, states: [undated] }, number, identity())).toThrow('No usable tracking events');
  });

  it('counts an offset-less date that no zone resolves, and places one that a zone resolves', () => {
    const states = [
      { date: '2026-03-11T09:00:00', status: 'Out for delivery', carrier: 0 },
      { date: '2026-03-10T18:10:00Z', status: 'Departed from the sorting centre', carrier: 0 },
    ];
    // A later wall time with no zone is no instant, so it cannot become the newest scan.
    expect(parseParcelsAppResponse({ carriers: ['bpost'], states }, number, identity())).toMatchObject({ current_stage: 'in_transit',
      last_update: '2026-03-10T18:10:00.000Z', undated_event_count: 1, events: [{ description: 'Departed from the sorting centre' }] });
    const placed = parseParcelsAppResponse({ carriers: ['bpost'], states }, number, identity(), 'Europe/Zurich');
    expect(placed).toMatchObject({ current_stage: 'out_for_delivery', last_update: '2026-03-11T08:00:00.000Z' });
    expect(placed.undated_event_count).toBeUndefined();
    // A scan that names no carrier keeps both wall clocks as local times, as scans (`unknownNetwork`).
    const nameless = parseParcelsAppResponse({ states: states.map(({ date, status }) => ({ date, status })) }, number, identity());
    expect(nameless).toMatchObject({ current_stage: 'out_for_delivery', last_update: null });
    expect(nameless.events?.map((scan) => [scan.time, scan.local_time])).toEqual([
      [undefined, '2026-03-11T09:00:00.000'], [undefined, '2026-03-10T18:10:00.000'],
    ]);
    expect(nameless.undated_event_count).toBeUndefined();
  });

  it('reads the undated state the page prints as "aN Inv NaN" as the JSON reply does', () => {
    // The page formats a missing date through Date.parse, so every field is NaN.
    const page = rendered(undatedLeg.states.map((state) => {
      const date = typeof state.date === 'string' ? DateTime.fromISO(state.date, { zone: 'UTC', locale: 'en' }) : null;
      return carrierRow(date?.toFormat('dd LLL yyyy') ?? 'aN Inv NaN', date?.toFormat('HH:mm') ?? 'aN:aN',
        String(state.status), undatedLeg.carriers[Number(state.carrier)]!);
    }).join(''));
    const html = parseParcelsAppHtml(page, number);
    const json = parseParcelsAppResponse(undatedLeg, number, identity());
    expect(html).toMatchObject({ undated_event_count: 1, last_update: json.last_update, current_stage: json.current_stage });
    // This page fixture has no location fields; its scan clocks and wording still agree.
    expect(html.events).toEqual(json.events?.map((event) => {
      const scan = { ...event };
      delete scan.location;
      return scan;
    }));
    expect(new Set(html.reported_carriers as string[])).toEqual(new Set(json.reported_carriers as string[]));
    expect(() => parseParcelsAppHtml(rendered(carrierRow('aN Inv NaN', 'aN:aN', 'Departed from Asendia', 'Asendia Spain')), number))
      .toThrow('No usable tracking events');
  });

  describe('a 1 January 00:00 placeholder', () => {
    const carriers = ['DPD Germany', 'Chronopost France'];
    const dated = [
      { date: '2026-09-24T14:05:00Z', status: 'Package delivered', carrier: 0 },
      { date: '2026-09-23T08:30:00Z', status: 'Colis en cours d\'acheminement', carrier: 1 },
      { date: '2026-09-22T19:10:00Z', status: 'Colis pris en charge', carrier: 1 },
    ];
    // The steps of DPD's progress bar, which ParcelsApp lists after the dated scans.
    const steps = (date: string) => ['Package info handed over to DPD', 'Package on the way', 'Package at the parcel delivery center',
      'Package out for delivery'].map((status) => ({ date, status, carrier: 0 }));
    const page = (states: { date: string; status: string; carrier: number }[]) => rendered(states.map(({ date, status, carrier }) => {
      const labeled = DateTime.fromISO(date, { zone: 'UTC', locale: 'en' });
      return carrierRow(labeled.toFormat('dd LLL yyyy'), labeled.toFormat('HH:mm'), status, carriers[carrier]!);
    }).join(''));

    it('is counted as undated when it lies months before every other scan, in the JSON reply and on the page', () => {
      const states = [...dated, ...steps('2026-01-01T00:00:00Z')];
      const json = parseParcelsAppResponse({ carriers, states }, number, identity());
      expect(json).toMatchObject({ current_stage: 'delivered', last_update: '2026-09-24T12:05:00.000Z', undated_event_count: 4 });
      expect(json.events?.map((scan) => scan.description)).toEqual(['Delivered', 'Colis en cours d\'acheminement', 'Colis pris en charge']);
      const html = parseParcelsAppHtml(page(states), number);
      expect(html).toMatchObject({ undated_event_count: 4, last_update: json.last_update, current_stage: json.current_stage });
      expect(html.events).toEqual(json.events);
    });

    it('keeps a scan at that minute among the scans of the turn of the year, or with no other scan', () => {
      const yearEnd = [
        { date: '2026-01-02T09:00:00Z', status: 'Package delivered', carrier: 0 },
        { date: '2026-01-01T00:00:00Z', status: 'Package on the way', carrier: 0 },
        { date: '2025-12-31T17:00:00Z', status: 'Package info handed over to DPD', carrier: 0 },
      ];
      // Sixty days before the first other scan is still within a shipment's span.
      const early = [{ ...dated[2]!, date: '2026-03-02T00:00:00Z' }, ...steps('2026-01-01T00:00:00Z')];
      for (const states of [yearEnd, steps('2026-01-01T00:00:00Z'), early, [...dated, ...steps('2026-01-01T00:01:00Z')]]) {
        const json = parseParcelsAppResponse({ carriers, states }, number, identity());
        expect(json.undated_event_count, states[0]!.date).toBeUndefined();
        expect(json.events?.length).toBe(new Set(states.map(({ date, status }) => `${date}|${status}`)).size);
        expect(parseParcelsAppHtml(page(states), number).events).toEqual(json.events);
      }
    });
  });

  it('keeps unknown historical wording pending rather than inheriting delivered', () => {
    const result = parseParcelsAppResponse({ states: [
      { date: '2026-08-18T03:04:00Z', status: 'Delivered by mailbox, PIN: PRIVATE' },
      { date: '2026-08-17T03:04:00Z', status: 'Additional information provided' },
    ] }, number, identity());
    expect(result.current_stage).toBe('delivered');
    expect(result.events?.[1]!.stage).toBe('pending');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('keeps a Quickpac pre-advice from reporting the parcel as delivered', () => {
    // Observed wording (2026-09-21); synthetic number and dates.
    const result = parseParcelsAppResponse({
      carriers: ['Planzer', 'Quickpac'],
      states: [{ date: '2026-06-10T12:22:20Z', carrier: 1, status: 'Shipment recorded by sender (data delivered)' }],
    }, number, identity(), 'Europe/Zurich');
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered' });
    expect(result.events?.[0]).toMatchObject({ stage: 'registered', description: 'Shipment recorded by sender (data delivered)' });
  });

  it('re-reads each scan in its carrier\'s or location\'s zone instead of the UTC ParcelsApp labels', () => {
    // Live shapes (2026-09-22): the carrier's local clock as "+00:00" or shifted into "+02:00".
    const result = parseParcelsAppResponse({
      carriers: ['India Post', 'Universal Postal Union', 'Swiss Post'],
      states: [
        { date: '2026-06-12T13:30:00+02:00', status: 'Delivered', carrier: 2 },
        { date: '2026-06-11T18:10:00+02:00', status: 'Shipment was sorted', carrier: 1, location: 'Example Parcel Centre, Switzerland' },
        { date: '2026-06-08T15:20:00Z', status: 'Arrived at international sorting center', carrier: 1, location: 'EXAMPLE AIR HUB' },
        { date: '2026-06-05T20:30:00Z', status: 'Item booked', carrier: 0 },
      ],
    }, number, identity());
    expect(result.events?.map((scan) => scan.time)).toEqual([
      '2026-06-12T09:30:00.000Z', // Swiss Post: 11:30 in Zurich
      '2026-06-11T14:10:00.000Z', // unmapped carrier, located in Switzerland
      '2026-06-08T15:20:00.000Z', // no zone to resolve: kept as labeled
      '2026-06-05T15:00:00.000Z', // India Post: 20:30 in Kolkata
    ]);
  });

  it('reads Correos de Chile\'s scans on Santiago\'s clock', () => {
    // Correos de Chile's page shows the scan at 10:43, in Chile's summer time.
    for (const name of ['Correos Chile', 'Correos de Chile', 'CorreosChile', 'Chile Post', 'Chile Correos', 'Correos Chile (CorreosChile)']) {
      const payload = { carriers: [name], states: [{ date: '2026-09-11T10:43:00Z', status: 'En tránsito', carrier: 0 }] };
      expect(parseParcelsAppResponse(payload, number, identity()).events?.[0]?.time, name).toBe('2026-09-11T13:43:00.000Z');
    }
  });

  it('reads Correios Brazil\'s scans on Brasília\'s clock, in Brazil and abroad', () => {
    // Correios Brazil's own tracker and 17TRACK's -03:00 copies have these digits.
    for (const name of ['Brazil Post', 'Correios Brazil']) {
      const payload = {
        carriers: [name],
        states: [
          { date: '2026-09-29T08:06:00Z', status: 'Item presented to import Customs', carrier: 0, location: 'EXAMPLE CITY, Brazil' },
          { date: '2026-09-14T17:29:00Z', status: 'Need to inform recipient\'s CPF/CNPJ', carrier: 0, location: 'Country, International Treatment Unit' },
          { date: '2026-09-14T17:28:00Z', status: 'Item in transfer - please wait', carrier: 0, location: 'Country, CHILE' },
        ],
      };
      expect(parseParcelsAppResponse(payload, number, identity()).events?.map((scan) => scan.time)).toEqual([
        '2026-09-29T11:06:00.000Z', '2026-09-14T20:29:00.000Z', '2026-09-14T20:28:00.000Z',
      ]);
    }
  });

  it('falls back to the parcel carrier\'s zone when a scan names no usable carrier or place', () => {
    const payload = { carriers: ['Example Parcel Co'], states: [{ date: '2026-06-10T14:05:00+00:00', status: 'Return to sender', carrier: 0 }] };
    expect(parseParcelsAppResponse(payload, number, identity(), 'Europe/Zurich').events?.[0]?.time).toBe('2026-06-10T12:05:00.000Z');
    expect(parseParcelsAppHtml(rendered(row('10 Jun 2026', '14:05', 'Return to sender')), number, 'Europe/Zurich').events?.[0]?.time)
      .toBe('2026-06-10T12:05:00.000Z');
    // With none, ParcelsApp's UTC label is still a wall clock: no instant.
    for (const result of [parseParcelsAppResponse(payload, number, identity()),
      parseParcelsAppHtml(rendered(row('10 Jun 2026', '14:05', 'Return to sender')), number),
      parseParcelsAppHtml(rendered(carrierRow('10 Jun 2026', '14:05', 'Return to sender', 'Example Parcel Co')), number)]) {
      expect(result).toMatchObject({ last_update: null, events: [{ local_time: '2026-06-10T14:05:00.000' }] });
      expect(result.events?.[0]).not.toHaveProperty('time');
    }
  });

  it('keeps a scan located in another country as labeled instead of reading it in the parcel carrier\'s zone', () => {
    // Live shape (2026-09-29): Asendia USA scans on a number filed under Swiss
    // Post, labeled with the UTC instants of Asendia's own feed.
    const times = (payload: Record<string, unknown>) =>
      parseParcelsAppResponse(payload, number, identity(), 'Europe/Zurich').events?.map((scan) => scan.time);
    expect(times(undatedLeg)).toEqual([
      '2026-03-10T18:10:00.000Z', '2026-03-10T15:40:00.000Z', '2026-03-10T06:15:00.000Z',
      '2026-03-10T00:00:00.000Z', // WNDirect, with no location, on Zurich time
      '2026-03-09T21:30:00.000Z',
    ]);
    const read = (location: string, carriers = ['Example Parcel Co']) => parseParcelsAppResponse({
      carriers, states: [{ date: '2026-07-02T18:30:00+00:00', status: 'In transit', carrier: 0, location }],
    }, number, identity(), 'Europe/Zurich').events?.[0];
    const scan = (location: string, carriers?: string[]) => read(location, carriers)?.time;
    // A country with several clocks, by name or code: a catalog carrier keeps
    // its label, and a network outside the catalog its wall clock.
    for (const location of ['EXAMPLE CITY, CA, United States', 'EXAMPLE CITY, CA, US', 'EXAMPLE CITY, Brazil']) {
      expect(scan(location, ['bpost'])).toBe('2026-07-02T18:30:00.000Z');
      expect(read(location)).toMatchObject({ local_time: '2026-07-02T18:30:00.000' });
      expect(read(location)).not.toHaveProperty('time');
    }
    // The parcel carrier's country, or a place with no country it can tell.
    for (const location of ['Example Hub, Switzerland', 'Example Hub', 'Example City, ON']) {
      expect(scan(location)).toBe('2026-07-02T16:30:00.000Z');
    }
    // The country a carrier name ends with is a guess too: it can be a branch.
    expect(scan('EXAMPLE CITY, United States', ['Cainiao (China)'])).toBe('2026-07-02T18:30:00.000Z');
    expect(times({ states: [{ date: '2026-07-02T18:30:00+00:00', status: 'In transit', location: 'EXAMPLE CITY, Brazil' }] }))
      .toEqual([undefined]);
  });

  it('reads every CTTYEX scan on Beijing time, the later ones abroad too, as its tracker prints them', () => {
    // CTTYEX's wording, as its tracker and the aggregators write it; synthetic dates and place.
    const states = [
      { date: '2026-07-08T09:10:00Z', status: 'Item arrives at destination airport', carrier: 0, location: 'EXAMPLE CITY, Germany' },
      { date: '2026-07-06T23:40:00Z', status: 'Departure from the airport of origin domestic', carrier: 0 },
      { date: '2026-07-05T10:00:00Z', status: 'Order information received', carrier: 0 },
    ];
    const json = parseParcelsAppResponse({ carriers: ['CTTYEX'], states }, number, identity(), 'Asia/Shanghai');
    expect(json.events?.map((scan) => [scan.time, scan.local_time])).toEqual([
      ['2026-07-08T01:10:00.000Z', undefined], // China's clock, not its place's
      ['2026-07-06T15:40:00.000Z', undefined],
      ['2026-07-05T02:00:00.000Z', undefined],
    ]);
    expect(json).toMatchObject({ current_stage: 'in_transit', last_update: '2026-07-08T01:10:00.000Z' });
    const html = parseParcelsAppHtml(rendered(carrierRow('08 Jul 2026', '09:10', 'Item arrives at destination airport', 'CTTYEX')
      + carrierRow('06 Jul 2026', '23:40', 'Departure from the airport of origin domestic', 'CTTYEX')), number, 'Asia/Shanghai');
    expect(html.events?.map((scan) => scan.time ?? scan.local_time)).toEqual(['2026-07-08T01:10:00.000Z', '2026-07-06T15:40:00.000Z']);
  });

  it('keeps a scan at a US military post office on its wall clock', () => {
    // APO, FPO and DPO with AA, AE or AP name a region of the US armed forces:
    // "AE" there is not the United Arab Emirates, and the base can be anywhere
    // in the region. Synthetic scans.
    const parse = (location: string) => parseParcelsAppResponse({
      carriers: ['bpost'], states: [{ date: '2026-07-02T18:30:00Z', status: 'Delivered', carrier: 0, location }],
    }, number, identity(), 'Europe/Brussels');
    for (const location of ['Fpo, AE', 'APO, AE 09001', 'DPO AP', 'FPO, AA 34001']) {
      const result = parse(location);
      expect(result.events, location).toEqual([expect.objectContaining({ local_time: '2026-07-02T18:30:00.000', location })]);
      expect(result.events?.[0], location).not.toHaveProperty('time');
      expect(result, location).toMatchObject({ status: 'delivered', last_update: null });
      expect(result, location).not.toHaveProperty('undated_event_count');
    }
    expect(parse('Example City, AE').events?.[0]?.time).toBe('2026-07-02T14:30:00.000Z');
    // A wall clock borrows no zone from its network's scans in the US for it.
    const usps = parseParcelsAppResponse({ carriers: ['USPS'], states: [
      { date: '2026-07-04T09:10:00Z', status: 'Delivered', carrier: 0, location: 'APO, AE 09001' },
      { date: '2026-06-28T07:00:00Z', status: 'Departed', carrier: 0, location: 'EXAMPLE CITY, NY 10001' },
    ] }, number, identity(), 'America/New_York');
    expect(usps.events?.map((scan) => scan.time ?? scan.local_time)).toEqual(['2026-07-04T09:10:00.000', '2026-06-28T11:00:00.000Z']);
  });

  it.each([
    ['DPD UK', '2026-07-02T17:30:00.000Z'],
    ['DPD Germany', '2026-07-02T16:30:00.000Z'],
    ['Hermes UK', '2026-07-02T17:30:00.000Z'],
  ])('lets a scan location refine the country-qualified name %s', (name, local) => {
    const scan = (location?: string) => parseParcelsAppResponse({
      carriers: [name], states: [{ date: '2026-07-02T18:30:00+00:00', status: 'In transit', carrier: 0, ...(location ? { location } : {}) }],
    }, number, identity()).events?.[0]?.time;
    expect(scan()).toBe(local);
    expect(scan('Example Hub, Spain')).toBe('2026-07-02T16:30:00.000Z');
    expect(scan('Example Hub, United States')).toBe('2026-07-02T18:30:00.000Z');
  });

  it('uses a bare brand clock only when all catalog networks agree', () => {
    // DPD's catalog includes the UK, so a bare group name has no single clock.
    const scans = (carriers: string[], dates: string[], extra: Record<string, unknown> = {}) => parseParcelsAppResponse({
      carriers, states: dates.map((date) => ({ date, status: 'In transit', carrier: 0, ...extra })),
    }, number, identity()).events?.map((scan) => scan.time);
    // Its scans keep their wall clocks rather than ParcelsApp's UTC label.
    expect(scans(['DPD Group'], ['2026-07-02T18:30:00+00:00', '2026-01-14T09:15:00+00:00'])).toEqual([undefined, undefined]);
    expect(parseParcelsAppResponse({ carriers: ['DPD Group'], states: [{ date: '2026-07-02T18:30:00+00:00', status: 'In transit', carrier: 0 }] },
      number, identity()).events?.[0]?.local_time).toBe('2026-07-02T18:30:00.000');
    expect(scans(['GLS'], ['2026-07-02T18:30:00+00:00'])).toEqual(['2026-07-02T16:30:00.000Z']);
    expect(scans(['Hermes'], ['2026-01-14T09:15:00+00:00'])).toEqual(['2026-01-14T08:15:00.000Z']);
    // A network the name or location places elsewhere keeps that country's clock.
    expect(scans(['DPD UK'], ['2026-07-02T18:30:00+00:00'])).toEqual(['2026-07-02T17:30:00.000Z']);
    expect(scans(['DPD Group'], ['2026-07-02T18:30:00+00:00'], { location: 'Example Hub, United Kingdom' }))
      .toEqual(['2026-07-02T17:30:00.000Z']);
    // A location it cannot place may be a network outside the catalog: no brand clock, and the wall clock stays.
    for (const location of ['EXAMPLE CITY, CA, US', 'Example City, ON', 'Example Hub']) {
      expect(scans(['GLS'], ['2026-07-02T18:30:00+00:00'], { location })).toEqual([undefined]);
    }
    // A name's country can be a branch: the scan's own location comes first.
    expect(scans(['Cainiao (China)'], ['2026-07-02T18:30:00+00:00'], { location: 'Example Hub, Spain' }))
      .toEqual(['2026-07-02T16:30:00.000Z']);
    expect(scans(['Cainiao (China)'], ['2026-07-02T18:30:00+00:00'])).toEqual(['2026-07-02T10:30:00.000Z']);
    // DHL eCommerce keeps no local clock, so the bare brand has no zone of its own.
    expect(scans(['DHL'], ['2026-07-02T18:30:00+00:00'])).toEqual(['2026-07-02T18:30:00.000Z']);
    expect(parseParcelsAppResponse({ carriers: ['DHL'], states: [{ date: '2026-07-02T18:30:00+00:00', status: 'In transit', carrier: 0 }] },
      number, identity(), 'Europe/Zurich').events?.[0]?.time).toBe('2026-07-02T16:30:00.000Z');
  });

  it('reports the carriers it aggregated and resolves a bare brand with the number', () => {
    const reply = (carriers: string[]) => ({
      carriers, services: carriers.map((name) => ({ slug: name.toLowerCase().replace(/ /g, '-'), name, isFinished: true })),
      states: [{ date: '2026-07-02T08:30:00+00:00', status: 'Delivered', carrier: 0 }],
    });
    // A Swiss DPD depot prefix picks DPD Switzerland out of the DPD networks.
    const swiss = '06080000000002';
    expect(parseParcelsAppResponse(reply(['DPD Group']), swiss, identity(swiss))).toMatchObject({
      reported_carriers: ['DPD Group'], discovered_carrier: 'dpd',
    });
    // Another depot matches both DPD networks: the brand stays a hint only.
    const other = '06460000000002';
    const unresolved = parseParcelsAppResponse(reply(['DPD Group']), other, identity(other));
    expect(unresolved.reported_carriers).toEqual(['DPD Group']);
    expect(unresolved.discovered_carrier).toBeUndefined();
    // Of two carriers on one journey, the one whose rules fit the number.
    const journey = reply(['Swiss Post', 'DPD Group']);
    journey.states.push({ date: '2026-07-01T16:00:00+00:00', status: 'In transit', carrier: 1 });
    expect(parseParcelsAppResponse(journey, swiss, identity(swiss)).discovered_carrier).toBe('dpd');
    expect(parseParcelsAppResponse(reply(['Swiss Post']), number, identity()).discovered_carrier).toBe('swiss-post');
  });

  it('takes the hint from the carrier every scan names, not from carriers asked without an answer', () => {
    // Live shape (2026-09-28): the carriers ParcelsApp tried, with every scan from one of them.
    const reply = (carriers: string[], states: Record<string, unknown>[]) => parseParcelsAppResponse({
      carriers, services: carriers.map((name) => ({ slug: name.toLowerCase(), name })), states,
    }, '123456784', identity('123456784'));
    const scan = (carrier?: number) => ({ date: '2026-07-02T08:30:00+00:00', status: 'Shipment in transit', ...(carrier === undefined ? {} : { carrier }) });
    expect(reply(['TNT', 'TNT', 'Example Transport'], [scan(0), scan(1)])).toMatchObject({
      reported_carriers: ['TNT', 'Example Transport'], discovered_carrier: 'tnt',
    });
    expect(reply(['TNT', 'Example Transport'], [scan(0), scan(1)]).discovered_carrier).toBeUndefined();
    expect(reply(['TNT', 'Example Transport'], [scan(0), scan()]).discovered_carrier).toBeUndefined();
    expect(reply(['Example Transport', 'TNT'], [scan(0)]).discovered_carrier).toBeUndefined();
    // Its link to another tracker is listed as "url", which names no carrier.
    expect(reply(['TNT', 'url'], [scan(0), scan()])).toMatchObject({ reported_carriers: ['TNT'], discovered_carrier: 'tnt' });
  });

  it('reads scans named "Finland Post" on Posti\'s clock and proposes Posti', () => {
    // The name is the catalog's Posti, so its scans take the carrier's zone
    // before their own location, as every catalog carrier's do.
    const finnish = 'RR123456785FI';
    const reply = (carriers: string[]) => parseParcelsAppResponse({
      carriers,
      states: [
        { date: '2026-07-03T14:20:00+00:00', status: 'Item has left the country of origin', carrier: 0, location: 'Example Hub, Germany' },
        { date: '2026-07-02T18:30:00+00:00', status: 'Item is being transported', carrier: 0 },
        { date: '2026-01-14T09:15:00+00:00', status: 'Item registered', carrier: 0 },
      ],
    }, finnish, identity(finnish));
    const named = reply(['Finland Post']);
    expect(named.events?.map((scan) => scan.time)).toEqual([
      '2026-07-03T11:20:00.000Z', // located abroad, still 14:20 in Helsinki
      '2026-07-02T15:30:00.000Z', // summer: EEST
      '2026-01-14T07:15:00.000Z', // winter: EET
    ]);
    expect(named).toMatchObject({ reported_carriers: ['Finland Post'], discovered_carrier: 'posti' });
    expect(reply(['Posti']).events?.map((scan) => scan.time)).toEqual(named.events?.map((scan) => scan.time));
    // A second listed name, here the postal union's feed, changes nothing when every scan names Finland Post.
    expect(reply(['Finland Post', 'Universal Postal Union'])).toMatchObject({
      reported_carriers: ['Finland Post', 'Universal Postal Union'], discovered_carrier: 'posti',
    });
    // A name outside the catalog takes its location's clock, or keeps its wall clock.
    expect(reply(['Example Parcel Co']).events?.map((scan) => scan.time ?? scan.local_time)).toEqual([
      '2026-07-03T12:20:00.000Z', '2026-07-02T18:30:00.000', '2026-01-14T09:15:00.000',
    ]);
  });

  it('reads scans named "Spain Post" on Correos\'s Madrid clock and proposes Correos', () => {
    // ParcelsApp relays Correos' wall clocks labelled as UTC, under its own name for the operator.
    const spanish = 'RR123456785ES';
    const reply = parseParcelsAppResponse({
      carriers: ['Spain Post'],
      states: [
        { date: '2026-07-02T18:30:00Z', status: 'En reparto', carrier: 0, location: '2830594' },
        { date: '2026-01-14T09:15:00Z', status: 'Admitido', carrier: 0 },
      ],
    }, spanish, identity(spanish));
    expect(reply.events?.map((scan) => scan.time)).toEqual([
      '2026-07-02T16:30:00.000Z', // summer: CEST
      '2026-01-14T08:15:00.000Z', // winter: CET
    ]);
    expect(reply).toMatchObject({ reported_carriers: ['Spain Post'], discovered_carrier: 'correos-spain' });
  });

  it('reads Correos\'s copies of an origin post\'s scans on that post\'s clock', () => {
    const times = (item: string) => parseParcelsAppResponse({
      carriers: ['Spain Post'],
      states: [
        { date: '2026-10-05T09:11:05Z', status: 'Llegada a oficina de cambio', carrier: 0 },
        { date: '2026-09-29T17:01:00Z', status: 'En aduana de origen', carrier: 0 },
        { date: '2026-09-29T16:56:00Z', status: 'En oficina de cambio', carrier: 0 },
      ],
    }, item, identity(item)).events?.map((scan) => scan.time ?? `local ${scan.local_time}`);
    // The S10 code's suffix names the origin; Correos's own scans stay on Madrid's clock.
    expect(times('RR123456785IN')).toEqual(['2026-10-05T07:11:05.000Z', '2026-09-29T11:31:00.000Z', '2026-09-29T11:26:00.000Z']);
    // An origin on several clocks leaves the wall clock, and Spain's own items keep Madrid's.
    expect(times('RR123456785US')).toEqual(['2026-10-05T07:11:05.000Z', 'local 2026-09-29T17:01:00.000', 'local 2026-09-29T16:56:00.000']);
    expect(times('RR123456785ES')).toEqual(['2026-10-05T07:11:05.000Z', '2026-09-29T15:01:00.000Z', '2026-09-29T14:56:00.000Z']);
    // The rendered page gives the same instants.
    const page = identity('RR123456785IN').replace('</table>', `</table><ul class="events">${
      carrierRow('29 Sep 2026', '17:01', 'En aduana de origen', 'Spain Post')}${carrierRow('29 Sep 2026', '16:56', 'En oficina de cambio', 'Spain Post')}</ul>`);
    expect(parseParcelsAppHtml(page, 'RR123456785IN').events?.map((scan) => scan.time))
      .toEqual(['2026-09-29T11:31:00.000Z', '2026-09-29T11:26:00.000Z']);
  });

  it("reads Correo Uruguayo's copies of a sending post's scans on the clock of the country they name", () => {
    const time = (location: string) => parseParcelsAppResponse({
      carriers: ['Correo Uruguayo'], originCode: 'CN', destinationCode: 'UY',
      states: [{ date: '2026-10-10T13:51:00Z', status: 'ADMISION PAIS DE ORIGEN', carrier: 0, location }],
    }, number, identity()).events?.map((scan) => scan.time ?? `local ${scan.local_time}`);
    // China Post's own row of the posting is at 05:51 UTC.
    expect(time('CHINA')).toEqual(['2026-10-10T05:51:00.000Z']);
    // A country of several clocks leaves the wall clock; Correo Uruguayo's own scans stay on Montevideo's.
    expect(time('UNITED STATES')).toEqual(['local 2026-10-10T13:51:00.000']);
    expect(time('MONTEVIDEO')).toEqual(['2026-10-10T16:51:00.000Z']);
  });

  it('reads scans named "Evri" on Evri UK\'s London clock and proposes Evri UK', () => {
    // Live shape (2026-10-16): Evri UK's wall clocks labelled "+00:00", an hour
    // after the instants of Evri UK's own history in summer.
    const barcode = 'H00A0A0000000002';
    const reply = parseParcelsAppResponse({
      carriers: ['Evri'],
      states: [
        { date: '2026-07-02T18:30:00+00:00', status: 'We\'re processing your parcel at our hub', carrier: 0 },
        { date: '2026-01-14T09:15:00+00:00', status: 'We\'re expecting your parcel to arrive with us soon', carrier: 0 },
      ],
    }, barcode, identity(barcode));
    expect(reply.events?.map((scan) => scan.time)).toEqual(['2026-07-02T17:30:00.000Z', '2026-01-14T09:15:00.000Z']);
    expect(reply).toMatchObject({ reported_carriers: ['Evri'], discovered_carrier: 'evri-uk' });
  });

  it('reads DHL Express scans on the clock of the facility their location names', () => {
    // Live shape (2026-10-06): the facility's clock labeled UTC. Ship24 gives the
    // same clocks with the offsets below.
    const state = (location?: string, date = '2026-10-05T12:00:00Z') => ({ date, status: 'Processed', carrier: 0, ...(location ? { location } : {}) });
    const scans = (states: unknown[], carriers = ['DHL Express']) => parseParcelsAppResponse({ carriers, states }, number, identity());
    const scan = (location?: string, carriers?: string[]) => scans([state(location)], carriers).events?.[0]?.time;
    expect(scan('EXAMPLE CITY - FRANCE')).toBe('2026-10-05T10:00:00.000Z');
    expect(scan('EXAMPLE CITY - NETHERLANDS, THE')).toBe('2026-10-05T10:00:00.000Z');
    expect(scan('EXAMPLE-CITY - UK')).toBe('2026-10-05T11:00:00.000Z');
    expect(scan('EXAMPLE HUB - Ohio - USA')).toBe('2026-10-05T16:00:00.000Z');
    expect(scan('EXAMPLE GATEWAY - California - USA')).toBe('2026-10-05T19:00:00.000Z');
    expect(scan('EXAMPLE CITY - VIRGINIA,VA - USA')).toBe('2026-10-05T16:00:00.000Z');
    expect(scan('EXAMPLE CITY - ON - CANADA')).toBe('2026-10-05T16:00:00.000Z');
    expect(scan('EXAMPLE SERVICE AREA - ONTARIO - CANADA')).toBe('2026-10-05T16:00:00.000Z');
    expect(scan('TENERIFE - SPAIN')).toBe('2026-10-05T11:00:00.000Z');
    // The shape is DHL Express's own: another carrier's label stands.
    expect(scan('EXAMPLE CITY - FRANCE', ['bpost'])).toBe('2026-10-05T12:00:00.000Z');
  });

  it('gives no instant to a DHL Express clock whose facility it cannot place', () => {
    const state = (location: string | undefined, date: string) => ({ date, status: 'Processed', carrier: 0, ...(location ? { location } : {}) });
    const scans = (states: unknown[]) => parseParcelsAppResponse({ carriers: ['DHL Express'], states }, number, identity());
    // An older one is left out and counted.
    const earlier = scans([state('EXAMPLE CITY - FRANCE', '2026-10-05T12:00:00Z'), state('EXAMPLE CITY - USA', '2026-10-03T12:00:00Z')]);
    expect(earlier).toMatchObject({ undated_event_count: 1, last_update: '2026-10-05T10:00:00.000Z' });
    expect(earlier.events).toHaveLength(1);
    // The latest one leaves the reply unable to say where the parcel is, whatever the order of its states.
    for (const location of ['EXAMPLE CITY - USA', 'EXAMPLE CITY - EXAMPLELAND', 'EXAMPLE CITY', undefined]) {
      expect(() => scans([state(location, '2026-10-05T12:00:00Z')])).toThrow(IndeterminateError);
      expect(() => scans([state('EXAMPLE CITY - FRANCE', '2026-10-03T12:00:00Z'), state(location, '2026-10-05T12:00:00Z')])).toThrow(IndeterminateError);
    }
    // The rendered page prints no location at all.
    expect(() => parseParcelsAppHtml(rendered(carrierRow('05 Oct 2026', '12:00', 'Processed', 'DHL Express')), number)).toThrow(IndeterminateError);
  });

  it('keeps the UTC instants ParcelsApp gives TNT international scans', () => {
    // Checked against tnt.com's offsets (2026-09-28); a TNT France number keeps the French clock.
    const scan = (trackingNumber: string) => parseParcelsAppResponse({
      carriers: ['TNT'], states: [{ date: '2026-07-02T11:20:00+00:00', status: 'Shipment in transit', carrier: 0, location: 'Example Hub, China' }],
    }, trackingNumber, identity(trackingNumber)).events?.[0]?.time;
    expect(scan('123456784')).toBe('2026-07-02T11:20:00.000Z');
    expect(scan('1000000000000001')).toBe('2026-07-02T09:20:00.000Z');
  });

  it.each(['json', 'html'])('keeps the UTC instants ParcelsApp gives Paack scans, with the stages of Paack\'s own lookup (%s)', (transport) => {
    // Live shape (2026-10-07): Paack's labels at Paack's own instants, located
    // only by country. Read on the Paris clock they came out two hours early.
    const states = [
      { date: '2026-07-02T15:40:00Z', status: 'In Paack’s distribution centre', carrier: 0, location: 'FR' },
      { date: '2026-07-02T09:15:00Z', status: 'Order details received', carrier: 0, location: 'FR' },
    ];
    const page = rendered([carrierRow('02 Jul 2026', '15:40', 'In Paack’s distribution centre', 'Paack'),
      carrierRow('02 Jul 2026', '09:15', 'Order details received', 'Paack')].join(''));
    const result = transport === 'json'
      ? parseParcelsAppResponse({ carriers: ['Paack'], states }, number, identity(), 'Europe/Paris')
      : parseParcelsAppHtml(page, number, 'Europe/Paris');
    expect(result.events?.map((scan) => [scan.time, scan.description, scan.stage, scan.stage_source])).toEqual([
      ['2026-07-02T15:40:00.000Z', 'Shipment accepted', 'accepted', 'carrier_map'],
      ['2026-07-02T09:15:00.000Z', 'Shipment registered', 'registered', 'carrier_map'],
    ]);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', discovered_carrier: 'paack' });
  });

  it("stores ParcelsApp's English for Sending scans in the tracker's own wording", () => {
    const result = parseParcelsAppResponse({ carriers: ['Sending'], states: [
      { date: '2026-07-02T21:05:00Z', status: 'Out in national route', carrier: 0, location: 'Example Town' },
      { date: '2026-07-02T16:10:00Z', status: 'Reception in the delegation', carrier: 0, location: 'Example Town' },
    ] }, number, identity(), 'Europe/Madrid');
    expect(result.events?.map((scan) => [scan.description, scan.stage, scan.stage_source])).toEqual([
      ['Salida en ruta nacional', 'in_transit', 'carrier_map'],
      ['Mercancia recogida', 'accepted', 'carrier_map'],
    ]);
    expect(result).toMatchObject({ current_stage: 'in_transit', discovered_carrier: 'sending' });
  });

  it('keeps the UTC instants ParcelsApp gives Vinted Go scans', () => {
    // Vinted Go's own instants have ParcelsApp's UTC digits, in the Netherlands
    // and Spain alike; read on its catalog clock they came out two hours early.
    const result = parseParcelsAppResponse({ carriers: ['VintedGO'], states: [
      { date: '2026-07-02T09:16:45Z', status: 'At sorting center in Example City, ES', carrier: 0, location: 'Example City, ES' },
      { date: '2026-07-01T19:09:46Z', status: 'At sorting center in Example Town, NL', carrier: 0, location: 'Example Town, NL' },
      { date: '2026-06-30T13:53:22Z', status: 'Shipment created', carrier: 0 },
    ] }, number, identity(), 'Europe/Paris');
    expect(result.events?.map((scan) => scan.time)).toEqual([
      '2026-07-02T09:16:45.000Z', '2026-07-01T19:09:46.000Z', '2026-06-30T13:53:22.000Z',
    ]);
  });

  it('keeps the UTC instants ParcelsApp gives Austrian Post scans', () => {
    // Austrian Post's own instants have ParcelsApp's UTC digits; read on the
    // Vienna clock they came out two hours early.
    const result = parseParcelsAppResponse({ carriers: ['Austria Post'], states: [
      { date: '2026-07-02T23:24:38Z', status: 'Item distributed', carrier: 0, location: 'Example Town, Austria' },
      { date: '2026-07-02T09:57:03Z', status: 'The sender has provided electronic shipment information', carrier: 0 },
    ] }, number, identity(), 'Europe/Vienna');
    expect(result.events?.map((scan) => scan.time)).toEqual(['2026-07-02T23:24:38.000Z', '2026-07-02T09:57:03.000Z']);
  });

  it('keeps the UTC instants ParcelsApp gives Straightship scans', () => {
    // Straightship's page writes its clocks in UTC, and its rows have
    // ParcelsApp's digits; read on its Vancouver clock they came out seven
    // hours late, after the moment ParcelsApp returned them.
    const result = parseParcelsAppResponse({ carriers: ['Straightship'], states: [
      { date: '2026-10-19T02:51:27Z', status: 'Package is received at a Straightship station (Example City, ON)', carrier: 0, location: 'Example City, ON' },
      { date: '2026-10-09T03:26:10Z', status: 'Package information is created in the system', carrier: 0 },
    ] }, number, identity(), 'America/Toronto');
    expect(result.events?.map((scan) => scan.time)).toEqual(['2026-10-19T02:51:27.000Z', '2026-10-09T03:26:10.000Z']);
  });

  it('keeps the UTC instants ParcelsApp gives PostNL\'s scans in Britain', () => {
    // FIC lists the same scans two hours after ParcelsApp's digits, on Dutch summer
    // time; read on PostNL's Amsterdam clock they came out two hours early.
    const result = parseParcelsAppResponse({ carriers: ['PostNL'], states: [
      { date: '2026-10-22T01:23:00Z', status: 'The item is on transport to the country of destination', carrier: 0, location: 'United Kingdom' },
      { date: '2026-10-22T01:21:00Z', status: 'The item is received by PostNL', carrier: 0, location: 'United Kingdom' },
    ] }, number, identity(), 'Europe/Budapest');
    expect(result.events?.map((scan) => scan.time)).toEqual(['2026-10-22T01:23:00.000Z', '2026-10-22T01:21:00.000Z']);
  });

  it('reads iMile\'s scans on the destination\'s clock, wherever they happened', () => {
    // iMile's page writes every scan on the recipient country's clock and ParcelsApp has its
    // digits; read on iMile's catalog zone they came out two hours early in Italy, and nine
    // hours early in Colombia. A take-off ParcelsApp places at the departing airport abroad
    // is on the destination's clock too, and the zone routing passes, iMile's, plays no part.
    const parse = (destinationCode: string) => parseParcelsAppResponse({ carriers: ['iMile'], destinationCode, states: [
      { date: '2026-09-24T17:14:34Z', status: '【Example center】Your order has been received.', carrier: 0, location: 'Example center' },
      { date: '2026-09-19T19:00:00Z', status: '【EXA】The flight has taken off.', carrier: 0, location: 'Example Intl (EXA), Miami, United States' },
      { date: '2026-09-17T19:16:16Z', status: 'Order submitted, pending to receive.', carrier: 0 },
    ] }, number, identity(), 'Asia/Dubai');
    expect(parse('IT').events?.map((scan) => scan.time)).toEqual(['2026-09-24T15:14:34.000Z', '2026-09-19T17:00:00.000Z', '2026-09-17T17:16:16.000Z']);
    expect(parse('CO').events?.map((scan) => scan.time)).toEqual(['2026-09-24T22:14:34.000Z', '2026-09-20T00:00:00.000Z', '2026-09-18T00:16:16.000Z']);
    // A destination of several clocks leaves them wall clocks, as iMile's own lookup does.
    expect(parse('AU').events?.map((scan) => [scan.time, scan.local_time])).toEqual([
      [undefined, '2026-09-24T17:14:34.000'], [undefined, '2026-09-19T19:00:00.000'], [undefined, '2026-09-17T19:16:16.000'],
    ]);
  });

  it("reads JS Express's scans on their place's clock, China's at home only", () => {
    // JS Express's own feed gives these digits with the offset of each scan's place, and its
    // partners' scans abroad came out six hours early on China's clock.
    const result = parseParcelsAppResponse({ carriers: ['JS Express'], states: [
      { date: '2026-10-20T22:29:37Z', status: 'PROCESSED AT HUB', carrier: 0 },
      { date: '2026-10-18T14:47:08Z', status: 'Released From Import Customs', carrier: 0, location: 'Example Airport (EXB), New York, United States' },
      { date: '2026-10-16T11:22:00Z', status: 'COLLECTED FROM AIRPORT TERMINAL', carrier: 0, location: 'EXAMPLE TOWN' },
      { date: '2026-10-15T22:08:00Z', status: 'Item Flight landing', carrier: 0, location: 'Example Airport (EXA), Example Town, Netherlands' },
      { date: '2026-10-15T12:45:59Z', status: 'Item Flight departure', carrier: 0, location: 'China' },
      { date: '2026-10-15T10:35:00Z', status: 'UPLIFTED FROM TRANSSHIPMENT HUB', carrier: 0, location: 'HONG KONG' },
      { date: '2026-10-14T08:57:08Z', status: 'Item departed from origin.', carrier: 0, location: 'South China Transit Center' },
      { date: '2026-10-13T17:40:54Z', status: 'Item has been collected', carrier: 0, location: 'China' },
    ] }, number, identity(), 'Asia/Shanghai');
    expect(Object.fromEntries(result.events!.map((scan) => [scan.description, scan.time ?? `local ${scan.local_time}`]))).toEqual({
      'PROCESSED AT HUB': 'local 2026-10-20T22:29:37.000',
      // A US state named for certain gives its clock.
      'Released From Import Customs': '2026-10-18T18:47:08.000Z',
      'COLLECTED FROM AIRPORT TERMINAL': 'local 2026-10-16T11:22:00.000',
      'Item Flight landing': '2026-10-15T20:08:00.000Z',
      // A flight's departure filed in China keeps its wall clock, as JS Express's own rows do.
      'Item Flight departure': 'local 2026-10-15T12:45:59.000',
      'UPLIFTED FROM TRANSSHIPMENT HUB': '2026-10-15T02:35:00.000Z',
      'Item departed from origin.': '2026-10-14T00:57:08.000Z',
      'Item has been collected': '2026-10-13T09:40:54.000Z',
    });
  });

  it("reads ECMS's scans on their facility's clock, Japan's at Narita", () => {
    // ECMS's own tracker gives these digits "+09:00" at Narita; China's clock put them an hour late.
    const result = parseParcelsAppResponse({ carriers: ['ECMS Express'], destinationCode: 'US', states: [
      { date: '2026-07-26T09:07:00Z', status: 'Shipment arrived at destination facility.', carrier: 0,
        location: 'Example International Airport, United States' },
      { date: '2026-07-24T17:05:16Z', status: 'Flight departure', carrier: 0, location: 'Example Town' },
      { date: '2026-07-23T14:14:23Z', status: 'Shipment departed from origin facility.', carrier: 0,
        location: 'Narita International Airport, Example Town, Japan' },
      { date: '2026-07-20T10:02:29Z', status: 'Shipment arrived at origin facility.', carrier: 0, location: 'Example Town, China' },
    ] }, number, identity(), 'Asia/Shanghai');
    expect(Object.fromEntries(result.events!.map((scan) => [scan.description, scan.time ?? `local ${scan.local_time}`]))).toEqual({
      // The United States keep several clocks, and a town alone names none.
      'Shipment arrived at destination facility.': 'local 2026-07-26T09:07:00.000',
      'Flight departure': 'local 2026-07-24T17:05:16.000',
      'Shipment departed from origin facility.': '2026-07-23T05:14:23.000Z',
      'Shipment arrived at origin facility.': '2026-07-20T02:02:29.000Z',
    });
  });

  it("reads KTD's scans on their place's clock, so its copies of SwiftX's hub scans stay one with them", () => {
    // Live shape: KTD files SwiftX's scan at SwiftX's digits, and its flight's take-off and
    // landing on their own places' clocks. On China's clock the flight took 75 minutes.
    const result = parseParcelsAppResponse({ carriers: ['KTD', 'SwiftX'], originCode: 'CN', destinationCode: 'US', states: [
      { date: '2026-10-27T03:10:56Z', status: 'Arrived at Origin Hub', carrier: 1, location: 'US, EXAMPLE TOWN, ORD HUB' },
      { date: '2026-10-27T03:10:56Z', status: 'Arrived at Origin Hub', carrier: 0, location: 'EXAMPLE TOWN, Illinois, United States' },
      { date: '2026-10-17T03:30:00Z', status: 'Arrived at the airport', carrier: 0, location: 'Chicago' },
      { date: '2026-10-17T02:15:00Z', status: 'Take off', carrier: 0, location: 'Shanghai' },
    ] }, number, identity(), 'UTC');
    expect(result.events?.map((scan) => [scan.description, scan.time ?? `local ${scan.local_time}`])).toEqual([
      // SwiftX's ORD hub and the state KTD names both give Central time.
      ['Arrived at Origin Hub', '2026-10-27T08:10:56.000Z'],
      // A town alone keeps its wall clock for the places step.
      ['Arrived at the airport', 'local 2026-10-17T03:30:00.000'],
      ['Take off', '2026-10-16T18:15:00.000Z'],
    ]);
  });

  it('reads Asendia scans filed under another name in their place\'s clock, not as UTC', () => {
    // Live shape (2026-09-30): an eBay shipment whose Asendia scans ParcelsApp
    // files under "EasyShip", on local clocks. Ship24's instants agree.
    const result = parseParcelsAppResponse({
      carriers: ['Asendia United States', 'EasyShip'],
      states: [
        { date: '2026-03-20T06:40:00Z', status: 'Arrived at delivery centre', carrier: 1, location: 'Japan, Japan' },
        { date: '2026-03-12T05:20:00Z', status: 'Departure transit facility', carrier: 1, location: 'Switzerland, Switzerland' },
        { date: '2026-03-05T18:45:10Z', status: 'Dispatched by Asendia', carrier: 1, location: 'United States, United States' },
        { date: '2026-03-04T22:30:00Z', status: 'Check-in Asendia facility', carrier: 1, location: 'EXAMPLE CITY, IL, United States' },
      ],
    }, number, identity());
    expect(result.events?.map((scan) => scan.time)).toEqual([
      '2026-03-19T21:40:00.000Z', // 06:40 in Tokyo
      '2026-03-12T04:20:00.000Z', // 05:20 in Zurich
      '2026-03-06T00:45:10.000Z', // the US alone: Illinois's clock, from the scan before it
      '2026-03-05T04:30:00.000Z', // 22:30 in Illinois
    ]);
  });

  it('tells a state or province from the country its code also names by the town', () => {
    // UPS writes US scans as "City, IL" and German ones as "City, DE": only the town tells.
    const times = (carriers: string[], states: Record<string, unknown>[]) =>
      parseParcelsAppResponse({ carriers, states }, number, identity()).events?.map((scan) => scan.time);
    const scan = (date: string, location: string) => ({ date, status: 'In transit', carrier: 0, location });
    expect(times(['UPS'], [
      scan('2026-07-02T09:00:00Z', 'Wilmington, DE'),
      scan('2026-07-02T14:05:00Z', 'Example Hub, DE'),
      scan('2026-07-01T22:10:00Z', 'Hodgkins, IL'),
      scan('2026-07-01T08:00:00Z', 'Tel Aviv, IL'),
      scan('2026-06-30T06:00:00Z', 'Indianapolis, IN'),
      scan('2026-06-30T02:00:00Z', 'Salem, IN'),
    ])).toEqual([
      '2026-07-02T13:00:00.000Z', // Delaware
      '2026-07-02T12:05:00.000Z', // no Delaware town: Germany
      '2026-07-02T03:10:00.000Z', // Illinois
      '2026-07-01T05:00:00.000Z', // Israel
      '2026-06-30T10:00:00.000Z', // Indiana
      '2026-06-29T20:30:00.000Z', // India's Salem is far bigger than Indiana's
    ]);
    // Canada's provinces, NL and SK included; "Mississauga, ON, CA" is not California.
    expect(times(['FedEx'], [
      scan('2026-07-02T14:05:00Z', 'Mississauga, ON, CA'),
      scan('2026-07-02T09:00:00Z', 'Regina, SK'),
      scan('2026-07-01T09:00:00Z', 'Example City, BC V6B 1A1'),
      scan('2026-07-01T08:00:00Z', "St. John's, NL"),
      scan('2026-06-30T08:00:00Z', 'Eindhoven, NL'),
      scan('2026-06-30T07:00:00Z', 'Bratislava, SK'),
    ])).toEqual([
      '2026-07-02T18:05:00.000Z', // Ontario
      '2026-07-02T15:00:00.000Z', // Saskatchewan, no summer time
      '2026-07-01T16:00:00.000Z', // British Columbia
      '2026-07-01T10:30:00.000Z', // Newfoundland
      '2026-06-30T06:00:00.000Z', // the Netherlands
      '2026-06-30T05:00:00.000Z', // Slovakia
    ]);
    // FedEx's country code before the postcode, after a town and its region;
    // with two parts, a state and its ZIP code.
    expect(times(['FedEx'], [
      scan('2026-07-03T15:11:00Z', 'EXAMPLE TOWN, RR, IT 12345'),
      scan('2026-07-02T21:52:00Z', 'EXAMPLE TOWN, GL, NL 1234'),
      scan('2026-07-02T16:05:00Z', 'EXAMPLE TOWN, NW, DE 12345'),
      scan('2026-07-02T09:00:00Z', 'MISSISSAUGA, ON, CA L5T 2V1'),
      scan('2026-07-01T09:00:00Z', 'MEMPHIS, TN, US 38118'),
      scan('2026-07-01T06:00:00Z', 'INDIANAPOLIS, IN 46241'),
    ])).toEqual([
      '2026-07-03T13:11:00.000Z', // Italy
      '2026-07-02T19:52:00.000Z', // the Netherlands
      '2026-07-02T14:05:00.000Z', // Germany, not Delaware, in a reply that is in North America
      '2026-07-02T13:00:00.000Z', // Ontario
      '2026-07-01T14:00:00.000Z', // Tennessee
      '2026-07-01T10:00:00.000Z', // Indiana
    ]);
    // A location that names no place leaves the reply in North America.
    expect(times(['UNI Express'], [scan('2026-11-11T20:34:39Z', 'Example Town IL'), scan('2026-11-06T16:50:03Z', 'UNI DATA CENTER')]))
      .toEqual(['2026-11-12T02:34:39.000Z', '2026-11-06T16:50:03.000Z']);
  });

  it('reads the US scans of carriers that relay local clocks in their state\'s zone', () => {
    // Live shapes (2026-09-30): UPS's own instants, FedEx's own page and
    // UniUni's own feed agree with these readings.
    const times = (carriers: string[], states: Record<string, unknown>[]) =>
      parseParcelsAppResponse({ carriers, states }, number, identity()).events?.map((scan) => scan.time);
    const scan = (date: string, location: string, status = 'In transit', carrier = 0) => ({ date, status, carrier, location });
    expect(times(['UPS'], [
      scan('2026-07-02T14:05:00Z', 'Example City, CA, US'),
      scan('2026-07-01T09:30:00Z', 'Example City, NY 10001'),
      scan('2026-06-30T20:15:00Z', 'Example City, GA'),
      scan('2026-06-29T08:00:00Z', 'Example City, DE'),
      scan('2026-01-15T09:30:00Z', 'Example City, NY'),
    ])).toEqual([
      '2026-07-02T21:05:00.000Z', // Pacific
      '2026-07-01T13:30:00.000Z', // Eastern
      '2026-07-01T00:15:00.000Z', // Georgia, as the reply is in the US
      '2026-06-29T06:00:00.000Z', // DE names Germany first, as UPS writes it for German scans
      '2026-01-15T14:30:00.000Z', // Eastern, in winter
    ]);
    // Every located scan in a US state places the reply in the US; one abroad does not.
    expect(times(['FedEx'], [scan('2026-09-08T10:09:00Z', 'Example City, KY'), scan('2026-09-07T23:37:00Z', 'Example City, TN')]))
      .toEqual(['2026-09-08T14:09:00.000Z', '2026-09-08T04:37:00.000Z']);
    expect(times(['FedEx'], [scan('2026-09-08T10:09:00Z', 'Example City, GA'), scan('2026-09-07T08:00:00Z', 'Example Hub, France')]))
      .toEqual(['2026-09-08T10:09:00.000Z', '2026-09-07T06:00:00.000Z']);
    // DHL eCommerce's Webtrack names these clocks (2026-10-11): CT, ET, PT, and BST in the UK.
    expect(times(['DHL eCommerce'], [
      scan('2026-10-10T09:57:00Z', 'HEATHROW, GB'),
      scan('2026-10-06T15:35:58Z', 'Example City, IL, US'),
      scan('2026-10-02T14:56:49Z', 'Example City, KY, US'),
      scan('2026-06-04T12:13:00Z', 'Example City, OR, US'),
    ])).toEqual(['2026-10-10T08:57:00.000Z', '2026-10-06T20:35:58.000Z', '2026-10-02T18:56:49.000Z', '2026-06-04T19:13:00.000Z']);
    // OnTrac's dates are already UTC.
    expect(times(['OnTrac'], [scan('2026-09-25T21:49:19Z', 'EXAMPLE CITY, CA, 92000'), scan('2026-09-24T02:25:10Z', 'EXAMPLE CITY, NY, 10001')]))
      .toEqual(['2026-09-25T21:49:19.000Z', '2026-09-24T02:25:10.000Z']);
    // UniUni writes "City ST"; a copy of the same scan from another carrier moves with it.
    expect(parseParcelsAppResponse({ carriers: ['UNI Express', 'Cainiao'], states: [
      scan('2026-09-05T15:10:54Z', 'Example Township PA', 'Delivered. (Recipient\'s front door)'),
      scan('2026-09-05T15:10:54Z', '', 'Package delivered,front door/porch', 1),
      scan('2026-09-04T21:31:33Z', 'Example City NY', 'Gateway transit out'),
    ] }, number, identity()).events?.map((event) => [event.time, event.description])).toEqual([
      ['2026-09-05T19:10:54.000Z', 'Delivered'],
      ['2026-09-05T01:31:33.000Z', 'Gateway transit out'],
    ]);
  });

  it('lends a scan placed only in the US or Canada the clock of its network\'s nearest scan a state places', () => {
    const times = (carriers: string[], states: Record<string, unknown>[]) =>
      parseParcelsAppResponse({ carriers, states }, number, identity()).events?.map((scan) => scan.time);
    const scan = (date: string, location: string, status = 'In transit', carrier = 0) => ({ date, status, carrier, location });
    // Live shape (2026-10-11): FedEx's own page dates the first scan, under the
    // shipper's ZIP code, on the clock of the pickup's state.
    expect(times(['FedEx'], [
      scan('2026-10-07T12:17:00Z', 'Example City, TN, US 12345', 'Delivered'),
      scan('2026-10-06T15:44:00Z', 'EXAMPLE CITY, TN, US 12345', 'Picked up'),
      scan('2026-10-06T10:43:00Z', 'US 12345', 'Shipment information sent to FedEx'),
    ])).toEqual(['2026-10-07T17:17:00.000Z', '2026-10-06T20:44:00.000Z', '2026-10-06T15:43:00.000Z']);
    // The scan just before it by wall clock, in the country the location names.
    expect(times(['UPS'], [
      scan('2026-07-02T09:00:00Z', 'United States'),
      scan('2026-07-01T22:10:00Z', 'Example City, CA, US'),
      scan('2026-07-01T08:00:00Z', 'Canada'),
      scan('2026-06-30T14:05:00Z', 'Example City, ON, CA'),
    ])).toEqual(['2026-07-02T16:00:00.000Z', '2026-07-02T05:10:00.000Z', '2026-07-01T12:00:00.000Z', '2026-06-30T18:05:00.000Z']);
    // No scan of its network in that country, or only another network's: as labeled.
    expect(times(['FedEx'], [scan('2026-07-02T09:00:00Z', 'US 12345'), scan('2026-07-01T14:05:00Z', 'Example City, ON, CA')]))
      .toEqual(['2026-07-02T09:00:00.000Z', '2026-07-01T18:05:00.000Z']);
    expect(times(['FedEx', 'UPS'], [scan('2026-07-02T09:00:00Z', 'US 12345'), scan('2026-07-01T22:10:00Z', 'Example City, NY', 'In transit', 1)]))
      .toEqual(['2026-07-02T09:00:00.000Z', '2026-07-02T02:10:00.000Z']);
  });

  it('leaves a UPS or FedEx scan with no location that nothing places a wall time, not the label\'s instant', () => {
    const parse = (carriers: string[], states: Record<string, unknown>[], timezone: string | null = null) =>
      parseParcelsAppResponse({ carriers, states }, number, identity(), timezone);
    const scan = (date: string, location: string, status = 'In transit', carrier = 0) => ({ date, status, carrier, location });
    // Live shape: UPS's own tracker dates its customs scan at the clearing
    // agency on the destination's clock; read as labeled, it came 11 hours after it.
    const ups = [
      scan('2026-10-17T23:41:00Z', '', 'The package is at the clearing agency awaiting final release.'),
      scan('2026-10-17T07:15:00Z', 'Example City, HI, US', 'Arrived at Facility'),
      scan('2026-10-16T22:30:00Z', 'Example City, KY, US', 'Arrived at Facility'),
    ];
    const read = parse(['UPS'], ups);
    expect(read.events?.map((event) => event.time)).toEqual(['2026-10-17T17:15:00.000Z', '2026-10-17T02:30:00.000Z']);
    expect(read.undated_event_count).toBe(1);
    expect(read.current_stage).not.toBe('customs');
    // Routing's zone still dates it, as it dates any scan nothing places.
    expect(parse(['UPS'], ups, 'Australia/Sydney').events?.map((event) => event.time))
      .toEqual(['2026-10-17T17:15:00.000Z', '2026-10-17T12:41:00.000Z', '2026-10-17T02:30:00.000Z']);
    // FedEx's own page dates "Order Created" on a local clock, not always the pickup's.
    const fedex = parse(['FedEx'], [scan('2026-07-02T09:00:00Z', 'Example City, NY'), scan('2026-07-01T21:40:00Z', '', 'Order Created')]);
    expect(fedex.events?.map((event) => event.time)).toEqual(['2026-07-02T13:00:00.000Z']);
    expect(fedex.undated_event_count).toBe(1);
    // Another carrier's scan with no location keeps its label.
    expect(parse(['OnTrac'], [scan('2026-07-01T21:40:00Z', '')]).events?.map((event) => event.time)).toEqual(['2026-07-01T21:40:00.000Z']);
  });

  it('keeps the day of FedEx\'s pickup, which FedEx dates without a time, instead of a midnight', () => {
    const scan = (date: string, location: string, status: string) => ({ date, status, carrier: 0, location });
    const read = (carriers: string[], states: Record<string, unknown>[]) =>
      parseParcelsAppResponse({ carriers, states }, number, identity()).events?.map(({ time, local_time, stage }) => ({ time, local_time, stage }));
    // Live shape: FedEx's own feed sends "Picked up" with a 00:00:00 time and no
    // offset; ParcelsApp writes it at 00:00, with a no-break space.
    expect(read(['FedEx'], [
      scan('2026-08-12T05:41:00Z', 'Example City, GA', 'Arrived at FedEx location'),
      scan('2026-08-11T00:00:00Z', 'Example City, GA', 'Picked\u00a0Up'),
    ])).toEqual([
      { time: '2026-08-12T09:41:00.000Z', local_time: undefined, stage: 'in_transit' },
      { time: undefined, local_time: '2026-08-11', stage: 'accepted' },
    ]);
    // A FedEx pickup at another time, another FedEx scan at 00:00 and another
    // carrier's pickup at 00:00 keep their instants.
    expect(read(['FedEx'], [
      scan('2026-08-12T00:00:00Z', 'Example City, GA', 'Departed FedEx Location'),
      scan('2026-08-11T16:20:00Z', 'Example City, GA', 'Picked Up'),
    ])?.map(({ time }) => time)).toEqual(['2026-08-12T04:00:00.000Z', '2026-08-11T20:20:00.000Z']);
    expect(read(['OnTrac'], [scan('2026-08-11T00:00:00Z', 'Example City, GA', 'Picked Up')])?.map(({ time }) => time))
      .toEqual(['2026-08-11T00:00:00.000Z']);
    // The rendered page gives the same day.
    expect(parseParcelsAppHtml(rendered(carrierRow('11 Aug 2026', '00:00', 'Picked Up', 'FedEx')), number).events?.[0])
      .toMatchObject({ local_time: '2026-08-11' });
    expect(parseParcelsAppHtml(rendered(carrierRow('11 Aug 2026', '00:00', 'Picked Up', 'FedEx')), number).events?.[0]?.time).toBeUndefined();
  });

  it('keeps the day of the steps USPS dates without a time, instead of a US midnight', () => {
    const read = (states: Record<string, unknown>[]) => parseParcelsAppResponse({ carriers: ['USPS'], states }, number, identity())
      .events?.map(({ description, time, local_time }) => [description, time ?? local_time]);
    // Live shape: ParcelsApp writes them at 00:00 with no place, and a placed
    // scan's Pacific clock read them at 07:00 UTC. The facility scan of the
    // evening before keeps the next day's step.
    const facility = 'EXAMPLE CITY CA DISTRIBUTION CENTER';
    expect(read([
      { date: '2026-10-26T00:00:00Z', status: 'In Transit to Next Facility', carrier: 0 },
      { date: '2026-10-24T00:00:00Z', status: 'In Transit to Next Facility', carrier: 0 },
      { date: '2026-10-23T19:42:00Z', status: 'Arrived at USPS Regional Facility', carrier: 0, location: facility },
      { date: '2026-10-13T00:00:00Z', status: 'Pre-Shipment Info Sent to USPS, USPS Awaiting Item', carrier: 0 },
    ])).toEqual([
      ['In Transit to Next Facility', '2026-10-26'],
      ['Arrived at USPS Regional Facility', '2026-10-24T02:42:00.000Z'],
      ['In Transit to Next Facility', '2026-10-24'],
      ['Pre-Shipment Info Sent to USPS, USPS Awaiting Item', '2026-10-13'],
    ]);
    // The step at another time, and another USPS scan at 00:00, keep their instants.
    expect(read([
      { date: '2026-10-25T18:24:00Z', status: 'In Transit to Next Facility', carrier: 0 },
      { date: '2026-10-25T00:00:00Z', status: 'Departed USPS Regional Facility', carrier: 0, location: facility },
    ])).toEqual([
      ['In Transit to Next Facility', '2026-10-26T01:24:00.000Z'],
      ['Departed USPS Regional Facility', '2026-10-25T07:00:00.000Z'],
    ]);
    // The rendered page gives the same day.
    expect(parseParcelsAppHtml(rendered(carrierRow('24 Oct 2026', '00:00', 'In Transit to Next Facility', 'USPS')), number).events
      ?.map(({ time, local_time }) => [time, local_time])).toEqual([[undefined, '2026-10-24']]);
  });

  it('keeps the days of a network whose every scan the reply writes at 00:00', () => {
    const scan = (date: string, status: string, carrier = 0) => ({ date, status, carrier, location: 'Example_Hub (Example State)' });
    const read = (carriers: string[], states: Record<string, unknown>[]) =>
      parseParcelsAppResponse({ carriers, states }, number, identity()).events?.map(({ time, local_time }) => time ?? local_time);
    // Shape of ParcelsApp's copies of Shiprocket's scans: days at 00:00, which Shiprocket gives to the minute.
    expect(read(['Shiprocket'], [
      scan('2026-10-15T00:00:00Z', 'Order Arrived at Facility'),
      scan('2026-10-14T00:00:00Z', 'In Transit - Trip Arrived'),
      scan('2026-10-13T00:00:00Z', 'In Transit - Shipment picked up'),
    ])).toEqual(['2026-10-15', '2026-10-14', '2026-10-13']);
    // Three scans on one day, a network with a scan at another time, or with only two scans, keep their instants.
    const instants = (states: Record<string, unknown>[], carriers = ['Shiprocket']) => read(carriers, states)?.every((value) => String(value).endsWith('Z'));
    expect(instants([scan('2026-10-13T00:00:00Z', 'Order Arrived at Facility'), scan('2026-10-13T00:00:00Z', 'In Transit - Trip Arrived'),
      scan('2026-10-13T00:00:00Z', 'In Transit - Shipment picked up')])).toBe(true);
    expect(instants([scan('2026-10-15T00:00:00Z', 'Order Arrived at Facility'), scan('2026-10-14T09:12:00Z', 'In Transit - Trip Arrived'),
      scan('2026-10-13T00:00:00Z', 'In Transit - Shipment picked up')])).toBe(true);
    expect(instants([scan('2026-10-14T00:00:00Z', 'In Transit - Trip Arrived'), scan('2026-10-13T00:00:00Z', 'In Transit - Shipment picked up')]))
      .toBe(true);
    // Another network's scans in the same reply keep theirs.
    expect(read(['Shiprocket', 'Example Parcel Co'], [
      scan('2026-10-16T08:30:00Z', 'Delivered', 1),
      scan('2026-10-15T00:00:00Z', 'Order Arrived at Facility'),
      scan('2026-10-14T00:00:00Z', 'In Transit - Trip Arrived'),
      scan('2026-10-13T00:00:00Z', 'In Transit - Shipment picked up'),
    ])?.[0]).toMatch(/^2026-10-16T08:30:00/);
  });

  it('keeps the days of a network whose scans the reply clocks by a count of seconds on one minute', () => {
    const scan = (date: string, status: string, carrier = 0) => ({ date, status, carrier });
    const parse = (carriers: string[], states: Record<string, unknown>[], timezone: string | null = null) =>
      parseParcelsAppResponse({ carriers, states }, number, identity(), timezone);
    const read = (carriers: string[], states: Record<string, unknown>[], timezone: string | null = null) =>
      parse(carriers, states, timezone).events?.map(({ time, local_time }) => time ?? local_time);
    // Shape of ParcelsApp's copies of CDEK's scans: their days, each at 07:00 with seconds counting them, which
    // CDEK's own lookup gives at their instants. The latest stays a scan with no time.
    const labels = ['Принят в городе отправителя', 'Отправлен в город получателя', 'В транзитном городе', 'Принят в городе получателя',
      'На доставке у курьера', 'Вручено'];
    const cdek = labels.map((status, index) => scan(`2026-10-${12 + index}T07:00:0${index}Z`, status)).reverse();
    const delivered = parse(['CDEK'], cdek);
    expect(delivered.events?.map(({ time, local_time }) => time ?? local_time))
      .toEqual(['2026-10-17', '2026-10-16', '2026-10-15', '2026-10-14', '2026-10-13', '2026-10-12']);
    expect(delivered).toMatchObject({ status: 'delivered', last_status_text: 'Вручено', last_update: null });
    // A count from 01, at 23:00, keeps the days of its digits.
    expect(read(['Example Parcel Co'], [scan('2026-10-15T23:00:04Z', 'Delivered'), scan('2026-10-14T23:00:03Z', 'Out for delivery'),
      scan('2026-10-14T23:00:02Z', 'In transit'), scan('2026-10-13T23:00:01Z', 'Accepted')])).toEqual(['2026-10-15', '2026-10-14', '2026-10-14', '2026-10-13']);
    // So does one from 00:00:01 that SEUR's clock would put on the UTC day before, in winter.
    expect(read(['SEUR'], [scan('2026-01-15T00:00:03.000Z', 'Entregado'), scan('2026-01-14T00:00:02.000Z', 'En reparto'),
      scan('2026-01-13T00:00:01.000Z', 'Admitido')], 'Europe/Madrid')).toEqual(['2026-01-15', '2026-01-14', '2026-01-13']);
    // Scans to the minute, seconds that skip, go back or carry milliseconds, a count on one day or of two scans keep their instants.
    const instants = (states: Record<string, unknown>[]) => read(['CDEK'], states)?.every((value) => String(value).endsWith('Z'));
    const run = (clocks: string[], days = clocks.map((_, index) => 15 - index)) =>
      clocks.map((clock, index) => scan(`2026-10-${days[index]}T${clock}Z`, labels[5 - index]!));
    expect(instants(run(['07:00:02', '07:00:01', '07:00:00']))).toBe(false);
    expect(instants(run(['16:05:00', '09:41:00', '11:20:00']))).toBe(true);
    expect(instants(run(['07:00:05', '07:00:02', '07:00:00']))).toBe(true);
    expect(instants(run(['07:00:02', '07:00:01', '07:00:02']))).toBe(true);
    expect(instants(run(['07:00:02.250', '07:00:01.250', '07:00:00.250']))).toBe(true);
    expect(instants(run(['07:00:02', '07:00:01.250', '07:00:00']))).toBe(true);
    expect(instants(run(['07:00:02', '07:01:01', '07:00:00']))).toBe(true);
    expect(instants(run(['07:00:02', '07:00:01', '07:00:00'], [15, 15, 15]))).toBe(true);
    expect(instants(run(['07:00:01', '07:00:00']))).toBe(true);
    // Another network's scans in the same reply keep theirs.
    const mixed = read(['CDEK', 'Example Parcel Co'], [scan('2026-10-18T08:30:00Z', 'Delivered', 1), ...cdek]);
    expect(mixed?.[0]).toMatch(/^2026-10-18T08:30:00/);
    expect(mixed?.slice(1)).toEqual(['2026-10-17', '2026-10-16', '2026-10-15', '2026-10-14', '2026-10-13', '2026-10-12']);
    // The rendered page prints no seconds: there, a network's every scan on one minute, three or more over two days or more, is enough.
    const page = (rows: [string, string, string][]) => parseParcelsAppHtml(rendered(rows.map(([day, time, carrier], index) =>
      carrierRow(`${day} Oct 2026`, time, labels[5 - index]!, carrier)).join('')), number).events?.map(({ time, local_time }) => time ?? local_time);
    expect(page([['15', '07:00', 'CDEK'], ['14', '07:00', 'CDEK'], ['13', '07:00', 'CDEK']])).toEqual(['2026-10-15', '2026-10-14', '2026-10-13']);
    expect(page([['15', '16:05', 'CDEK'], ['14', '07:00', 'CDEK'], ['13', '07:00', 'CDEK']])?.every((value) => String(value).endsWith('Z'))).toBe(true);
    expect(page([['15', '07:00', 'CDEK'], ['15', '07:00', 'CDEK'], ['15', '07:00', 'CDEK']])?.every((value) => String(value).endsWith('Z'))).toBe(true);
    expect(page([['16', '08:30', 'Example Parcel Co'], ['15', '07:00', 'CDEK'], ['14', '07:00', 'CDEK'], ['13', '07:00', 'CDEK']])?.[0])
      .toMatch(/^2026-10-16T08:30:00/);
  });

  it('reads USPS, Canada Post, GOFO and SpeedPAK scans in the state, province or country their location names', () => {
    // Live shapes (2026-10-10): each carrier's local clock labeled UTC. USPS's
    // page, Canada Post's digits, GOFO's US feed and Orange Connex's offsets
    // agree with these readings.
    const times = (carriers: string[], states: Record<string, unknown>[]) =>
      parseParcelsAppResponse({ carriers, states }, number, identity()).events?.map((scan) => scan.time);
    const scan = (date: string, location: string, status = 'In transit', carrier = 0) => ({ date, status, carrier, location });
    expect(times(['USPS'], [
      scan('2026-09-11T08:25:00Z', 'EXAMPLE CITY, NY 10001'),
      scan('2026-09-02T08:53:00Z', 'EXAMPLE CITY MI DISTRIBUTION CENTER'),
      scan('2026-08-28T05:01:00Z', 'EXAMPLE CITY CA NETWORK DISTRIBUTION CENTER'),
    ])).toEqual(['2026-09-11T12:25:00.000Z', '2026-09-02T12:53:00.000Z', '2026-08-28T12:01:00.000Z']);
    expect(times(['Canada Post'], [
      scan('2026-10-03T11:55:00Z', 'ISC EXAMPLE CITY IL (USPS), USA'),
      scan('2026-10-01T12:58:00Z', 'EXAMPLE CITY, ON, Canada'),
    ])).toEqual(['2026-10-03T16:55:00.000Z', '2026-10-01T16:58:00.000Z']);
    expect(times(['SpeedPAK'], [
      scan('2026-02-18T13:12:47Z', 'Example City Minnesota, United States of America'),
      scan('2026-02-02T21:42:33Z', 'Example City Il, United States of America'),
      scan('2026-01-28T11:47:02Z', 'Example City, People\'s Republic of China'),
    ])).toEqual(['2026-02-18T19:12:47.000Z', '2026-02-03T03:42:33.000Z', '2026-01-28T03:47:02.000Z']);
    // GOFO's US scans; a copy from another carrier, with no state, moves with its scan.
    expect(parseParcelsAppResponse({ carriers: ['GoFo Express', 'Cainiao'], states: [
      scan('2026-10-03T16:01:13Z', 'Example City, FL', 'Delivered, Door/Yard.'),
      scan('2026-10-03T16:01:13Z', 'Example City', 'Delivered', 1),
      scan('2026-10-03T08:54:20Z', 'Example City, FL', 'Out for Delivery'),
    ] }, number, identity()).events?.map((event) => [event.time, event.description])).toEqual([
      ['2026-10-03T20:01:13.000Z', 'Delivered'],
      ['2026-10-03T12:54:20.000Z', 'Out for Delivery'],
    ]);
  });

  it('lends a wall-clock scan with no place the clock of its network\'s nearest placed scan, as a guess', () => {
    const times = (carriers: string[], states: Record<string, unknown>[], timezone: string | null = null) =>
      parseParcelsAppResponse({ carriers, states }, number, identity(), timezone).events?.map((scan) => scan.time);
    const scan = (date: string, location?: string, carrier = 0) => ({ date, status: 'In transit', carrier, ...(location ? { location } : {}) });
    // The scan just before it; for the first scans, the one just after.
    expect(times(['USPS'], [
      scan('2026-08-30T23:05:00Z'),
      scan('2026-08-30T18:00:00Z', 'EXAMPLE CITY IN DISTRIBUTION CENTER'),
      scan('2026-08-28T11:42:00Z'),
      scan('2026-08-28T05:01:00Z', 'EXAMPLE CITY CA DISTRIBUTION CENTER'),
      scan('2026-08-23T21:51:00Z'),
    ])).toEqual([
      '2026-08-31T03:05:00.000Z', // Eastern, from Indiana
      '2026-08-30T22:00:00.000Z',
      '2026-08-28T18:42:00.000Z', // Pacific, from California
      '2026-08-28T12:01:00.000Z',
      '2026-08-24T04:51:00.000Z', // Pacific, from the scan after it
    ]);
    // Only a zone the location allows: a scan in the US skips a Canadian or a Chinese one.
    expect(times(['Canada Post'], [
      scan('2026-10-10T06:10:00Z', 'USA'),
      scan('2026-10-03T11:55:00Z', 'ISC EXAMPLE CITY IL (USPS), USA'),
      scan('2026-10-02T01:11:00Z', 'EXAMPLE-A, Canada'),
      scan('2026-10-01T12:58:00Z', 'EXAMPLE CITY, ON, Canada'),
    ])).toEqual(['2026-10-10T11:10:00.000Z', '2026-10-03T16:55:00.000Z', '2026-10-02T05:11:00.000Z', '2026-10-01T16:58:00.000Z']);
    expect(times(['SpeedPAK'], [
      scan('2026-02-02T21:42:33Z', 'Example City Il, United States of America'),
      scan('2026-02-02T10:09:00Z', 'United States of America'),
      scan('2026-01-31T17:07:00Z', 'People\'s Republic of China'),
    ])).toEqual(['2026-02-03T03:42:33.000Z', '2026-02-02T16:09:00.000Z', '2026-01-31T09:07:00.000Z']);
    // 4PX's "US" alone takes the US scan before it.
    expect(parseParcelsAppResponse({ carriers: ['4PX Express'], states: [
      { date: '2026-05-25T09:36:43Z', status: 'Arrived at usps regional facility', carrier: 0, location: 'US    EXAMPLE CITY NY DISTRIBUTION CENTER' },
      { date: '2026-05-25T07:39:05Z', status: 'In transit to next facility', carrier: 0, location: 'US    ' },
      { date: '2026-05-25T06:10:36Z', status: 'Departed usps regional facility', carrier: 0, location: 'US    EXAMPLE CITY NY DISTRIBUTION CENTER' },
    ] }, number, identity()).events?.map((event) => event.time))
      .toEqual(['2026-05-25T13:36:43.000Z', '2026-05-25T11:39:05.000Z', '2026-05-25T10:10:36.000Z']);
    // With nothing to borrow, routing's zone, unless the location rules it out.
    expect(times(['EMS'], [scan('2026-09-11T23:38:00+00:00', 'Example Office')], 'Europe/London')).toEqual(['2026-09-11T22:38:00.000Z']);
    expect(times(['EMS'], [scan('2026-09-11T23:38:00+00:00', 'Example Office'), scan('2026-09-10T11:36:00+00:00', 'Example City, Germany')],
      'Europe/London')).toEqual(['2026-09-11T21:38:00.000Z', '2026-09-10T09:36:00.000Z']);
    expect(times(['EMS'], [scan('2026-09-11T23:38:00+00:00', 'United States')], 'Europe/London')).toEqual(['2026-09-11T23:38:00.000Z']);
    // Canada Post's "USA" names the US for other carriers' guesses too.
    expect(times(['Yodel'], [scan('2026-09-11T23:38:00Z', 'Example City, USA')])).toEqual(['2026-09-11T23:38:00.000Z']);
  });

  it('copies a placed scan of another carrier, reads known clocks, and keeps the label of a wall-clock scan with no other zone', () => {
    const reply = (carriers: string[], states: Record<string, unknown>[]) => parseParcelsAppResponse({ carriers, states }, number, identity());
    const scan = (date: string, location?: string, carrier = 0, status = 'In transit') => ({ date, status, carrier, ...(location ? { location } : {}) });
    // The same digits and wording as another carrier's placed scan: a copy, on
    // its clock, and one scan with it. A scan of the network before it lends
    // that clock to the next with other wording.
    expect(reply(['EMS', 'Japan Post'], [
      scan('2026-07-08T14:50:00+00:00', '10001', 0, 'Delivered'),
      scan('2026-07-08T14:50:00Z', 'UNITED KINGDOM', 1, 'Delivered'),
      scan('2026-07-08T06:11:00+00:00', '10001', 0, 'Out for delivery'),
      scan('2026-07-08T06:11:00Z', 'UNITED KINGDOM', 1, 'Item out for physical delivery'),
    ]).events?.map((event) => [event.time, event.description])).toEqual([
      ['2026-07-08T13:50:00.000Z', 'Delivered'],
      ['2026-07-08T05:11:00.000Z', 'Out for delivery'],
      ['2026-07-08T05:11:00.000Z', 'Item out for physical delivery'],
    ]);
    // GOFO's labels on Pacific time and Cainiao's origin leg on China time,
    // whatever their neighbours; Cainiao's other scans borrow as any other.
    expect(reply(['GoFo Express', 'Cainiao'], [
      scan('2026-10-03T16:01:13Z', 'Example City, FL', 0, 'Delivered'),
      scan('2026-10-03T16:01:13Z', 'Example City', 1, 'Delivered'),
      scan('2026-10-01T21:26:36Z', undefined, 1, 'Leaving customs'),
      scan('2026-09-28T03:35:09Z', undefined, 1, 'Order received successfully'),
      scan('2026-09-27T12:34:50Z', undefined, 0, 'Shipping Label Created'),
    ]).events?.map((event) => event.time)).toEqual([
      '2026-10-03T20:01:13.000Z',
      '2026-10-02T01:26:36.000Z',
      '2026-09-27T19:35:09.000Z',
      '2026-09-27T19:34:50.000Z',
    ]);
    // With no other zone, ParcelsApp's label, as before these steps: never an undated scan.
    for (const [carriers, states] of [
      [['Canada Post'], [scan('2026-10-10T06:10:00Z', 'USA'), scan('2026-10-01T12:58:00Z', 'EXAMPLE CITY, ON, Canada')]],
      [['USPS', 'UPS'], [scan('2026-10-10T06:10:00Z'), scan('2026-10-04T15:24:00Z', 'Example City, NY', 1)]],
      [['EMS'], [scan('2026-10-10T06:10:00Z', '10001'), scan('2026-10-04T15:24:00Z', 'EXAMPLE CITY')]],
      [['Cainiao'], [scan('2026-10-10T06:10:00Z'), scan('2026-10-04T15:24:00Z', 'Example Town')]],
      [['EcoScooting'], [scan('2026-10-10T06:10:00Z'), scan('2026-10-04T15:24:00Z')]],
    ] as const) {
      const result = reply([...carriers], [...states]);
      expect(result, carriers.join()).toMatchObject({ last_update: '2026-10-10T06:10:00.000Z' });
      expect(result.undated_event_count, carriers.join()).toBeUndefined();
    }
    // A 4PX scan nothing places keeps its label.
    expect(reply(['4PX Express'], [scan('2026-05-23T10:00:38Z')]).last_update).toBe('2026-05-23T10:00:38.000Z');
    // The rendered page prints no location: routing's zone, a known clock, or the label.
    const page = rendered(carrierRow('10 Oct 2026', '06:10', 'Out for delivery', 'USPS')
      + carrierRow('27 Sep 2026', '12:34', 'Shipping Label Created', 'GoFo Express'));
    expect(parseParcelsAppHtml(page, number).events?.map((event) => event.time)).toEqual(['2026-10-10T06:10:00.000Z', '2026-09-27T19:34:00.000Z']);
    expect(parseParcelsAppHtml(page, number, 'America/New_York').events?.[0]?.time).toBe('2026-10-10T10:10:00.000Z');
  });

  it('reads 4PX scans under its fixed fields on the wall clock of their dates', () => {
    // Live shape: 4PX's fixed fields, and dates that are the wall clocks 4PX's
    // page shows, under a UTC label. The page gives the offsets: its scans up
    // to the departing flight on China time, the rest in the US.
    const result = parseParcelsAppResponse({ carriers: ['4PX Express'], destinationCode: 'US', states: [
      { date: '2026-05-26T14:30:03Z', status: 'Delivered, in/at mailbox', carrier: 0, location: 'US  NY  EXAMPLE CITY 10001' },
      { date: '2026-05-25T09:36:43Z', status: 'Arrived at usps regional facility', carrier: 0, location: 'US    EXAMPLE CITY NY DISTRIBUTION CENTER' },
      { date: '2026-05-23T18:00:38Z', status: 'Customs clearance agent received the shipment in destnation country.\n', carrier: 0 },
      { date: '2026-05-23T12:22:00Z', status: 'Arrival to the destination airport', carrier: 0 },
      { date: '2026-05-23T01:27:00Z', status: 'Departure from the original airport', carrier: 0 },
      { date: '2026-05-21T20:35:30Z', status: 'Pickup scanned, in transit to warehouse', carrier: 0, location: 'CN' },
      { date: '2026-05-21T17:08:01Z', status: 'Shipping label created, usps awaiting item', carrier: 0, location: 'US  NY  EXAMPLE CITY 10001' },
      { date: '2026-05-21T17:04:13Z', status: 'Parcel information received', carrier: 0 },
    ] }, number, identity());
    expect(result.events?.map((scan) => [scan.time, scan.location])).toEqual([
      ['2026-05-26T18:30:03.000Z', 'US NY EXAMPLE CITY 10001'], // 14:30:03 in New York
      ['2026-05-25T13:36:43.000Z', 'US EXAMPLE CITY NY DISTRIBUTION CENTER'],
      // In the US, from the US scans after them, as guesses: 18:00:38 and
      // 12:22 in New York on 4PX's page.
      ['2026-05-23T22:00:38.000Z', undefined],
      ['2026-05-23T16:22:00.000Z', undefined],
      ['2026-05-22T17:27:00.000Z', undefined], // China time
      ['2026-05-21T21:08:01.000Z', 'US NY EXAMPLE CITY 10001'], // the US label, 17:08:01 in New York
      ['2026-05-21T12:35:30.000Z', 'CN'],
      ['2026-05-21T09:04:13.000Z', undefined], // China time, not the label's US one after it
    ]);
    expect(result.undated_event_count).toBeUndefined();
  });

  it('reads 4PX scans on their wall clocks where its fields and its destination partner\'s places mix', () => {
    // Live shape: a bare "FR" from 4PX's fields beside the partner's towns, and
    // dates that are the wall clocks of 4PX's page, which gives each its
    // place's offset. The partner's first sorting center has no place.
    const result = parseParcelsAppResponse({ carriers: ['4PX Express'], destination: 'France', states: [
      { date: '2026-10-16T15:55:00Z', status: 'Your shipment has departed from the transit origin', carrier: 0, location: 'FR' },
      { date: '2026-10-16T09:41:20Z', status: 'Your shipment has arrived at sorting center', carrier: 0, location: 'Example Town' },
      { date: '2026-10-16T09:29:01Z', status: 'Your shipment has arrived at the transit destination', carrier: 0, location: 'FR' },
      { date: '2026-10-16T04:08:35Z', status: 'Your shipment has been processed at sorting center and ready for shipping', carrier: 0 },
      { date: '2026-10-15T08:30:00Z', status: 'Arrival to the destination airport', carrier: 0 },
      { date: '2026-10-15T04:18:58Z', status: 'Departure from the original airport', carrier: 0 },
      { date: '2026-10-07T19:45:38Z', status: 'Shipment picked up', carrier: 0, location: 'Example City,China' },
    ] }, number, identity());
    expect(result.events?.map((scan) => scan.time)).toEqual([
      '2026-10-16T13:55:00.000Z', // 15:55 in France
      '2026-10-16T07:41:20.000Z', // in France, from the scan before it, a guess
      '2026-10-16T07:29:01.000Z',
      '2026-10-16T02:08:35.000Z', // in the destination, from a scan placed there
      '2026-10-15T06:30:00.000Z',
      '2026-10-14T20:18:58.000Z',
      '2026-10-07T11:45:38.000Z',
    ]);
    expect(result.destination_country).toBe('FR');
  });

  it('reads 4PX scans whose places ParcelsApp rewrote on the wall clock of their dates', () => {
    // Live shape (2026-10-11): "United States", "Hong Kong", "US 12345" in
    // place of 4PX's fields, and dates that are the wall clocks themselves.
    // 4PX's page gives the offsets.
    const result = parseParcelsAppResponse({ carriers: ['4PX Express'], destination: 'United States', states: [
      { date: '2026-03-23T13:49:00Z', status: 'Delivered, front door/porch', carrier: 0, location: 'EXAMPLE CITY, IN, US 12345' },
      { date: '2026-03-21T09:40:00Z', status: 'Arrived at usps regional facility', carrier: 0,
        location: 'EXAMPLE CITY IN DISTRIBUTION CENTER, US 12345' },
      { date: '2026-03-19T21:35:00Z', status: 'Handed over to last mile', carrier: 0 },
      { date: '2026-03-18T03:06:00Z', status: 'Hand over to airline', carrier: 0 },
      { date: '2026-03-17T09:53:32Z', status: 'Depart from facility to service provider', carrier: 0, location: 'Hong Kong' },
      { date: '2026-03-14T02:40:00Z', status: 'Picked up by shipping partner, usps awaiting item', carrier: 0, location: 'EXAMPLE CITY, IL, US 12345' },
      { date: '2026-03-09T15:04:41Z', status: 'Parcel information received', carrier: 0 },
    ] }, number, identity());
    expect(result.events?.map((scan) => scan.time)).toEqual([
      '2026-03-23T17:49:00.000Z', // 13:49 in Indiana
      '2026-03-21T13:40:00.000Z',
      '2026-03-20T02:35:00.000Z', // in the US: Illinois's clock, from the scan before it, a guess
      '2026-03-17T19:06:00.000Z',
      '2026-03-17T01:53:32.000Z',
      '2026-03-14T07:40:00.000Z',
      '2026-03-09T07:04:41.000Z',
    ]);
    expect(result.undated_event_count).toBeUndefined();
    expect(result.destination_country).toBe('US');
  });

  it('reads Cainiao\'s warehouse and origin sorting center on China time', () => {
    // AliExpress's feed dates the same scans +08:00; ParcelsApp labels the digits UTC.
    const result = parseParcelsAppResponse({ carriers: ['Cainiao'], destinationCode: 'FR', states: [
      { date: '2026-10-16T13:52:01Z', status: 'Departed from sorting center', carrier: 0, location: 'Example Town' },
      { date: '2026-10-16T11:54:16Z', status: 'Processing at sorting center', carrier: 0, location: 'Example Town' },
      { date: '2026-10-16T08:01:25Z', status: 'Package shipped out from warehouse', carrier: 0 },
      { date: '2026-10-16T06:30:00Z', status: 'Package ready for shipping from warehouse', carrier: 0 },
      { date: '2026-10-16T03:07:09Z', status: 'Shipment information received by warehouse electronically', carrier: 0 },
    ] }, number, identity());
    expect(result.events?.map((scan) => scan.time)).toEqual([
      '2026-10-16T05:52:01.000Z',
      '2026-10-16T03:54:16.000Z',
      '2026-10-16T00:01:25.000Z',
      '2026-10-15T22:30:00.000Z',
      '2026-10-15T19:07:09.000Z',
    ]);
  });

  it('reads Cainiao\'s import customs and last mile on the destination\'s clock, the UK\'s last mile as labeled', () => {
    // Cainiao's own feed (2026-10-11): its origin leg on China time, import
    // customs and the last mile on the destination's clock, the UK's last mile
    // on GMT in July.
    const times = (destinationCode: string, states: Record<string, unknown>[]) =>
      parseParcelsAppResponse({ carriers: ['Cainiao'], destinationCode, states }, number, identity()).events?.map((scan) => scan.time);
    const scan = (date: string, status: string, location?: string) => ({ date, status, carrier: 0, ...(location ? { location } : {}) });
    const states = [
      scan('2026-07-10T14:00:00Z', 'Delivered'),
      scan('2026-07-08T09:00:00Z', 'Import customs clearance complete'),
      scan('2026-07-01T10:00:00Z', 'Leave the warehouse'),
    ];
    expect(times('BE', states)).toEqual(['2026-07-10T12:00:00.000Z', '2026-07-08T07:00:00.000Z', '2026-07-01T02:00:00.000Z']);
    expect(times('GB', states)).toEqual(['2026-07-10T14:00:00.000Z', '2026-07-08T08:00:00.000Z', '2026-07-01T02:00:00.000Z']);
    expect(times('RE', states)).toEqual(['2026-07-10T10:00:00.000Z', '2026-07-08T05:00:00.000Z', '2026-07-01T02:00:00.000Z']);
    // A parcel bound for Portugal clears customs and is sorted in Spain, then
    // delivered in Portugal; a neighbour placed there lends the sorting no clock.
    expect(times('PT', [
      scan('2026-07-10T16:23:11Z', 'Delivered', 'Example Town'),
      scan('2026-07-10T06:09:16Z', 'Your shipment has been accepted by delivery carrier', 'Portugal'),
      scan('2026-07-09T12:03:35Z', 'Your shipment has arrived at sorting center', 'Example Hub'),
      scan('2026-07-08T19:29:00Z', 'Leaving customs'),
      scan('2026-07-08T18:36:00Z', 'Import customs clearance complete'),
    ])).toEqual([
      '2026-07-10T15:23:11.000Z', '2026-07-10T05:09:16.000Z', '2026-07-09T10:03:35.000Z', '2026-07-08T17:29:00.000Z',
      '2026-07-08T16:36:00.000Z',
    ]);
    // The local carrier's first scans, in Cainiao's words.
    expect(times('IT', [
      scan('2026-07-10T17:00:00Z', 'Package arrived at facility of the local delivery company'),
      scan('2026-07-10T15:06:00Z', 'First parcel scan along Example Post’s logistic network'),
    ])).toEqual(['2026-07-10T15:00:00.000Z', '2026-07-10T13:06:00.000Z']);
    // A destination of several clocks lends only the clock of a scan placed
    // there, as a guess, and none from outside it.
    expect(times('US', [
      scan('2026-10-03T16:01:13Z', 'In transit', 'Example City, FL'),
      scan('2026-10-01T21:26:36Z', 'Leaving customs'),
      scan('2026-09-30T08:00:00Z', 'In transit', 'Example City, China'),
    ])).toEqual(['2026-10-03T20:01:13.000Z', '2026-10-02T01:26:36.000Z', '2026-09-30T00:00:00.000Z']);
  });

  it('reads the seller\'s step Cainiao relays on China time, which as labeled comes after it is first returned', () => {
    const reply = parseParcelsAppResponse({ carriers: ['Cainiao'], destinationCode: 'FR', states: [
      { date: '2026-07-01T18:00:00Z', status: 'Pending shipping by the seller', carrier: 0 },
    ] }, number, identity());
    expect(reply.events?.map((scan) => scan.time)).toEqual(['2026-07-01T10:00:00.000Z']);
    expect(reply.last_update).toBe('2026-07-01T10:00:00.000Z');
  });

  it('reads MailAmericas\' origin leg and Tax ID checks on the origin\'s clock, its scans in the destination on that one\'s', () => {
    // On a parcel to Colombia (2026-10-16), the Tax ID checks precede
    // ParcelsApp's first answer only on China's clock, and the scans there
    // match Cainiao's import customs on Colombia's.
    const states = [
      { date: '2026-07-12T08:00:00Z', status: 'Tax ID. Form received', carrier: 0 },
      { date: '2026-07-11T12:30:00Z', status: 'Delivery branch. Received at Distribution Branch', carrier: 0, location: 'Example Town' },
      { date: '2026-07-10T02:00:00Z', status: 'Destination customs. Released', carrier: 0, location: 'Colombia' },
      { date: '2026-07-09T04:45:00Z', status: 'Arrived at destination country. Delivered by Airline', carrier: 0 },
      { date: '2026-07-09T04:41:00Z', status: 'Arrived at linehaul office', carrier: 1 },
      { date: '2026-07-07T12:00:00Z', status: 'Transit to destination country. Flight', carrier: 0 },
      { date: '2026-07-06T14:00:00Z', status: 'Order created. Label printed', carrier: 0 },
    ];
    expect(parseParcelsAppResponse({ carriers: ['MailAmericas', 'Cainiao'], originCode: 'CN', destinationCode: 'CO', states }, number,
      identity()).events?.map((scan) => scan.time)).toEqual([
      '2026-07-12T00:00:00.000Z',
      '2026-07-11T17:30:00.000Z', // Colombia's clock, from the customs scan before it
      '2026-07-10T07:00:00.000Z',
      '2026-07-09T09:45:00.000Z', // from the customs scan after it
      '2026-07-09T04:41:00.000Z', // Cainiao's linehaul office, on either side's clock, as labeled
      '2026-07-07T04:00:00.000Z',
      '2026-07-06T06:00:00.000Z',
    ]);
    // With no place around them, their wording places them: AliExpress's own receipt by the
    // local delivery company has the digits of "Container reception" at -05:00.
    const unplaced = [
      { date: '2026-07-10T05:55:00Z', status: 'Container reception', carrier: 0 },
      { date: '2026-07-10T02:02:00Z', status: 'Destination customs. Released', carrier: 0 },
    ];
    expect(parseParcelsAppResponse({ carriers: ['MailAmericas', 'Cainiao'], originCode: 'CN', destinationCode: 'CO', states: unplaced }, number,
      identity()).events?.map((scan) => scan.time)).toEqual(['2026-07-10T10:55:00.000Z', '2026-07-10T07:02:00.000Z']);
  });

  it('stages MailAmericas\' Spanish hand-overs as transit and its finished process as the delivery', () => {
    const states = [
      { date: '2026-07-14T15:00:00Z', status: 'Proceso finalizado. Entregado', carrier: 0, location: 'Example Town' },
      { date: '2026-07-11T12:30:00Z', status: 'Recepción correo de destino. Entregado a Distribuidor', carrier: 0, location: 'Example Town' },
      { date: '2026-07-09T04:45:00Z', status: 'Arribado a país destino. Entregado por Aerolínea', carrier: 0, location: 'Example Town' },
    ];
    expect(parseParcelsAppResponse({ carriers: ['MailAmericas'], destinationCode: 'CO', states }, number, identity())
      .events?.map((scan) => scan.stage)).toEqual(['delivered', 'in_transit', 'in_transit']);
  });

  it('reads a town of the state a country\'s code also names in that state, not the country', () => {
    const times = (location: string) => parseParcelsAppResponse({ carriers: ['Example Courier'], states: [
      { date: '2026-07-10T12:00:00Z', status: 'In transit', carrier: 0, location },
    ] }, number, identity()).events?.map((scan) => scan.time ?? scan.local_time);
    // Its state dates only the scans of carriers on local clocks: this one keeps its wall clock.
    expect(times('Denver, CO')).toEqual(['2026-07-10T12:00:00.000']);
    expect(times('Example Town, Colombia')).toEqual(['2026-07-10T17:00:00.000Z']);
  });

  it('reads EcoScooting\'s last mile in Portugal for a "CNPRT" reference, otherwise in Spain', () => {
    // EcoScooting's own instants (2026-10-11): its China leg on China time, its
    // order and Spanish sorting center on Madrid's, its last mile on the
    // destination's.
    const times = (trackingNumber: string) => parseParcelsAppResponse({ carriers: ['EcoScooting'], states: [
      { date: '2026-07-10T09:00:00Z', status: 'Out for Delivery. Your shipment is out for delivery', carrier: 0 },
      { date: '2026-07-08T09:00:00Z', status: 'Sorting Center Inbound. Your shipment has arrived at sorting center', carrier: 0 },
      { date: '2026-07-01T09:00:00Z', status: 'Shipment is in transit to Cainiao Express', carrier: 0 },
    ] }, trackingNumber, identity(trackingNumber)).events?.map((scan) => scan.time);
    const reference = 'CNPRT00000000000000000001';
    expect(times(reference)).toEqual(['2026-07-10T08:00:00.000Z', '2026-07-08T07:00:00.000Z', '2026-07-01T01:00:00.000Z']);
    expect(times(number)).toEqual(['2026-07-10T07:00:00.000Z', '2026-07-08T07:00:00.000Z', '2026-07-01T01:00:00.000Z']);
    // The reference's country dates the scans; the result reports only a destination the reply names.
    expect(parseParcelsAppResponse({ carriers: ['EcoScooting'], states: [
      { date: '2026-07-10T09:00:00Z', status: 'Out for Delivery. Your shipment is out for delivery', carrier: 0 },
    ] }, reference, identity(reference)).destination_country).toBeUndefined();
    const page = identity(reference).replace('</table>', `</table><ul class="events">${
      carrierRow('10 Jul 2026', '09:00', 'Out for Delivery. Your shipment is out for delivery', 'EcoScooting')}</ul>`);
    expect(parseParcelsAppHtml(page, reference).events?.[0]?.time).toBe('2026-07-10T08:00:00.000Z');
  });

  it('gives copies of a GOFO scan with an offset of its own that instant', () => {
    // Live shape (2026-10-10): GOFO France's own offsets, and other carriers'
    // copies of the same scan with its digits labeled UTC.
    const result = parseParcelsAppResponse({ carriers: ['GoFo Express', 'YTO Express', 'Cirro Parcel France', 'EQuick China'], states: [
      { date: '2026-06-18T12:08:37+00:00', status: 'Delivered by Mailbox', carrier: 1, location: 'EXAMPLE CITY,EXAMPLE REGION' },
      { date: '2026-06-18T12:08:37+00:00', status: 'Delivered by Mailbox', carrier: 2, location: 'EXAMPLE CITY,EXAMPLE REGION' },
      { date: '2026-06-18T12:08:37+00:00', status: 'Delivered by Mailbox', carrier: 3, location: 'EXAMPLE CITY,EXAMPLE REGION' },
      { date: '2026-06-18T12:08:37+02:00', status: 'Delivered by Mailbox', carrier: 0, location: 'EXAMPLE CITY,EXAMPLE REGION' },
      { date: '2026-01-15T10:35:08+01:00', status: 'Arrived at sorting center', carrier: 0, location: 'EXAMPLE CITY' },
      { date: '2026-01-15T10:35:08+00:00', status: 'Arrived at sorting center', carrier: 3, location: 'EXAMPLE CITY' },
    ] }, number, identity());
    expect(result.events?.map((scan) => scan.time)).toEqual(['2026-06-18T10:08:37.000Z', '2026-01-15T09:35:08.000Z']);
    expect(result.undated_event_count).toBeUndefined();
  });

  it('takes the offset of a Poland Post scan at a place as its instant, whatever zone routing passes', () => {
    // Poczta Polska's own tracker has the same digits and offset for its sender platform's
    // item data and its office scans, and none for a relay from abroad.
    const payload = { carriers: ['Example Line', 'Poland Post'], states: [
      { date: '2026-10-21T13:14:20Z', status: 'Parcel has been packed and is ready for outbound shipping', carrier: 0, location: 'China' },
      { date: '2026-10-20T11:11:00+02:00', status: 'Electronic shipment data received', carrier: 1, location: 'Electronic Sender' },
      { date: '2026-07-16T13:11:00+02:00', status: 'Przyjęta w kraju przeznaczenia', carrier: 1 },
      { date: '2026-07-14T14:25:00+02:00', status: 'Obsługa celna', carrier: 1, location: 'International Postal System' },
      { date: '2026-07-06T17:11:00+02:00', status: 'Nadanie przesyłki', carrier: 1, location: 'Placówka Pocztowa Example 1' },
    ] };
    for (const zone of [null, 'Asia/Shanghai']) {
      const times = parseParcelsAppResponse(payload, number, identity(), zone).events?.map((scan) => scan.time);
      expect([times?.[1], times?.[4]]).toEqual(['2026-10-20T09:11:00.000Z', '2026-07-06T15:11:00.000Z']);
    }
    // With no partner post to name a clock, the relays keep the reading they had: the label, or routing's zone.
    expect(parseParcelsAppResponse(payload, number, identity(), 'Asia/Shanghai').events?.slice(2, 4).map((scan) => scan.time))
      .toEqual(['2026-07-16T03:11:00.000Z', '2026-07-14T04:25:00.000Z']);
  });

  it('reads a scan at a labelled country or a posting postcode on that country\'s clock', () => {
    // La Poste's own tracker dates these scans at 13:34 and 09:12 UTC.
    const polish = 'LX123456785PL';
    const payload = { carriers: ['Poland Post'], destinationCode: 'FR', states: [
      { date: '2026-10-23T11:12:00Z', status: 'Your shipment is ready to leave the foreign territory.', carrier: 0, location: 'Country: Poland' },
      { date: '2026-10-22T15:34:32+02:00', status: 'Posting/collection', carrier: 0, location: 'Placówka Pocztowa Example 1' },
      { date: '2026-10-22T15:34:00Z', status: 'Your shipment has been deposited by the sender with postal partner.', carrier: 0, location: 'PL99999' },
    ] };
    expect(parseParcelsAppResponse(payload, polish, identity(polish)).events?.map((scan) => [scan.time, scan.location])).toEqual([
      ['2026-10-23T09:12:00.000Z', 'Poland'], ['2026-10-22T13:34:32.000Z', 'Placówka Pocztowa Example 1'], ['2026-10-22T13:34:00.000Z', 'Poland'],
    ]);
    // The same scans can come with La Poste's clock shifted into Poland's offset; no office's offset dates them.
    const [ready, posting, deposit] = payload.states;
    const shifted = { ...payload, states: [{ ...ready, date: '2026-10-23T13:12:00+02:00' }, posting, { ...deposit, date: '2026-10-22T17:34:00+02:00' }] };
    expect(parseParcelsAppResponse(shifted, polish, identity(polish)).events?.map((scan) => scan.time)).toEqual([
      '2026-10-23T09:12:00.000Z', '2026-10-22T13:34:32.000Z', '2026-10-22T13:34:00.000Z',
    ]);
  });

  it('reads Poland Post\'s relays of a partner post\'s scans as written, on that post\'s clock', () => {
    // A Latvian item to Poland: the relays carry Riga's wall clock under Poland's offset.
    const latvian = 'RR123456785LV';
    const payload = { carriers: ['Poland Post'], destinationCode: 'PL', states: [
      { date: '2026-10-22T10:05:00+02:00', status: 'Doręczono', carrier: 0, location: 'Placówka Pocztowa Example 1' },
      { date: '2026-10-21T08:30:00+02:00', status: 'Obsługa celna', carrier: 0, location: 'International Postal System' },
      { date: '2026-10-20T12:10:00+02:00', status: 'Wysłanie z kraju nadania', carrier: 0 },
    ] };
    for (const zone of [null, 'Europe/Riga']) {
      expect(parseParcelsAppResponse(payload, latvian, identity(latvian), zone).events?.map((scan) => scan.time))
        .toEqual(['2026-10-22T08:05:00.000Z', '2026-10-21T05:30:00.000Z', '2026-10-20T09:10:00.000Z']);
    }
  });

  it("leaves out ParcelsApp's summary of a Russian Post delivery, on the delivery office's wall clock", () => {
    const domestic = '10000000000001';
    // Russian Post's own states come on Moscow's clock; the summary on the office's, here seven hours ahead of UTC.
    const delivery = { date: '2026-10-22T09:58:40+00:00', status: 'Вручение адресату почтальоном', carrier: 0, location: 'Example City, 000000' };
    const summary = { date: '2026-10-22T13:58:40+00:00', status: 'Вручено 22 октября', location: 'Example Town' };
    const reply = (...states: object[]) => parseParcelsAppResponse({ carriers: ['Russian Post'], states: [...states,
      { date: '2026-10-16T11:30:40+00:00', status: 'Arrived at the Post office', carrier: 0, location: 'Example Town, 000000' }] },
    domestic, identity(domestic)).events?.map(({ time, local_time, stage }) => [time ?? local_time, stage]);
    const dated = [['2026-10-22T06:58:40.000Z', 'delivered'], ['2026-10-16T08:30:40.000Z', 'in_transit']];
    // With no carrier, or Russian Post's, the summary repeats the delivery whole hours away.
    expect(reply(summary, delivery)).toEqual(dated);
    expect(reply({ ...summary, carrier: 0 }, delivery)).toEqual(dated);
    // Alone, or minutes off a delivery, it stays.
    expect(reply(summary)).toEqual([['2026-10-22T13:58:40.000', 'delivered'], dated[1]]);
    expect(reply(summary, { ...delivery, date: '2026-10-22T09:28:40+00:00' })).toHaveLength(3);
  });

  it('reads a network nothing places on its copies\' clock, and a later acceptance by another carrier as a hand-over', () => {
    // A line provider outside the catalog files DHLink's scans at the same
    // digits with no place; DPD takes the parcel once it is cleared.
    const xzg = 'XZG000000000WL';
    const scans: [string, string, number][] = [
      ['2026-06-20T02:25:00+00:00', 'Parcel handed', 2],
      ['2026-06-16T18:40:00Z', 'Customs import clearance completed, awaiting pickup by local carrier', 0],
      ['2026-06-16T18:40:00Z', 'Customs import clearance completed, awaiting pickup by local carrier', 1],
      ['2026-06-11T16:43:00Z', 'Package handed over to airline', 0],
      ['2026-06-11T16:43:00Z', 'Package handed over to airline', 1],
      ['2026-06-09T20:51:00Z', 'Order information has been sent to DPD.', 0],
      ['2026-06-09T19:04:00Z', 'Package received & scanned at warehouse', 0],
      ['2026-06-09T19:04:00Z', 'Package received & scanned at warehouse', 1],
    ];
    const carriers = ['Example Line', 'DHLink', 'DPD Group'];
    const json = parseParcelsAppResponse({ carriers, states: scans.map(([date, status, carrier]) => ({ date, status, carrier })) }, xzg, identity(xzg));
    const page = identity(xzg).replace('</table>', `</table><ul class="events">${scans.map(([date, status, carrier]) =>
      carrierRow(DateTime.fromISO(date, { zone: 'UTC' }).toFormat('dd LLL yyyy'), date.slice(11, 16), status, carriers[carrier]!)).join('')}</ul>`);
    // DPD Group's scan keeps its wall clock; four days after the line's, it is still later.
    const expected = [
      [undefined, 'in_transit'], ['2026-06-16T10:40:00.000Z', 'in_transit'], ['2026-06-11T08:43:00.000Z', 'in_transit'],
      ['2026-06-09T12:51:00.000Z', 'registered'], ['2026-06-09T11:04:00.000Z', 'accepted'],
    ];
    for (const parsed of [json, parseParcelsAppHtml(page, xzg)]) {
      expect(parsed.events?.map(({ time, stage }) => [time, stage])).toEqual(expected);
      expect(parsed.current_stage).toBe('in_transit');
    }
    // DPD's own acceptance, before any other carrier moved the parcel, stays one.
    expect(parseParcelsAppResponse({ carriers, states: [{ date: '2026-06-20T02:25:00+00:00', status: 'Parcel handed', carrier: 2 },
      { date: '2026-06-09T20:51:00Z', status: 'Order information has been sent to DPD.', carrier: 0 }] }, xzg, identity(xzg)).current_stage).toBe('accepted');
    // Within a day of another carrier's dated move, a wall clock is not known to be later. Above the move it is still
    // the hand-over, so it does not set the parcel back; below it, it keeps its acceptance.
    const handed = (date: string) => parseParcelsAppResponse({ carriers, states: [{ date, status: 'Parcel handed', carrier: 2 },
      ...[0, 1].map((carrier) => ({ date: '2026-06-16T18:40:00Z', status: scans[1]![1], carrier }))] }, xzg, identity(xzg));
    expect(handed('2026-06-17T08:00:00+00:00').events?.[0]).toMatchObject({ local_time: '2026-06-17T08:00:00.000', stage: 'in_transit' });
    expect(handed('2026-06-16T08:00:00+00:00')).toMatchObject({ current_stage: 'in_transit' });
    expect(handed('2026-06-16T08:00:00+00:00').events?.[1]).toMatchObject({ local_time: '2026-06-16T08:00:00.000', stage: 'accepted' });
  });

  it("reads a forwarder's wall-clock pickup hours after another network's dated moves as the hand-over", () => {
    // Live shape: a forwarder outside the catalog dates its steps by a wall clock,
    // DPD Poland by its own; the forwarder's reference is the number asked.
    const reference = 'ZZZZ000000000';
    const states = [
      { date: '2026-10-20T16:44:18Z', status: 'Goods have been picked up from warehouse', carrier: 0 },
      { date: '2026-10-20T11:09:42+00:00', status: 'Sent abroad', carrier: 1, location: 'Example, Poland' },
      { date: '2026-10-20T11:06:29+00:00', status: 'Receipt of the package at the DPD branch', carrier: 1, location: 'Example, Poland' },
      { date: '2026-10-20T10:49:27Z', status: 'Arrived at overseas warehouse on 10/19, waiting for sorting', carrier: 0 },
      { date: '2026-10-19T23:59:50+00:00', status: 'Package picked up by the courier', carrier: 1 },
      { date: '2026-10-14T09:31:14Z', status: 'Arrived at port, waiting for customs clearance', carrier: 0 },
      { date: '2026-09-05T14:39:03Z', status: 'Container loaded, vessel name and voyage EXAMPLE', carrier: 0 },
    ];
    const parsed = parseParcelsAppResponse({ carriers: ['Example Forwarding', 'DPD Poland'], states }, reference, identity(reference));

    expect(parsed.events?.slice(0, 3).map(({ time, local_time, stage }) => [time ?? local_time, stage])).toEqual([
      ['2026-10-20T16:44:18.000', 'in_transit'], ['2026-10-20T10:49:27.000', 'in_transit'], ['2026-10-20T09:09:42.000Z', 'in_transit'],
    ]);
    expect(parsed.current_stage).toBe('in_transit');
  });

  it('reads XZG on China\'s clock with or without DHLink\'s copies, whatever zone routing passes', () => {
    // Live shape: XZG's own tracker and DHLink's give these digits, on China's clock.
    const xzg = 'XZG000000000WL';
    const times = (carriers: string[], states: [string, string, number][], timezone: string | null = null) =>
      parseParcelsAppResponse({ carriers, destinationCode: 'CH', states: states.map(([date, status, carrier]) => ({ date, status, carrier })) },
        xzg, identity(xzg), timezone).events?.map(({ time }) => time);
    const own: [string, string, number][] = [
      ['2026-06-16T18:40:00Z', 'Customs import clearance completed, awaiting pickup by local carrier', 0],
      ['2026-06-09T20:51:26Z', 'Order information has been sent to DPD.', 0],
      ['2026-06-09T19:04:07Z', 'Package received & scanned at warehouse', 0],
    ];
    const expected = ['2026-06-16T10:40:00.000Z', '2026-06-09T12:51:26.000Z', '2026-06-09T11:04:07.000Z'];
    expect(times(['XZG'], own)).toEqual(expected);
    expect(times(['XZG', 'DPD Group'], own, 'Europe/Zurich')).toEqual(expected);
    // DHLink's copies take DHLink's catalog zone, so each scan stays one.
    expect(times(['XZG', 'DHLink'], [...own, ['2026-06-16T18:40:00Z', own[0]![1], 1], ['2026-06-09T19:04:07Z', own[2]![1], 1]],
      'Europe/Zurich')).toEqual(expected);
    // A location in another country rules the home clock out.
    expect(parseParcelsAppResponse({ carriers: ['XZG'], states: [
      { date: '2026-06-16T18:40:00Z', status: 'Arrived', carrier: 0, location: 'Example Town, Switzerland' },
    ] }, xzg, identity(xzg)).events?.[0]?.time).toBe('2026-06-16T16:40:00.000Z');
  });

  it('reads SwiftX\'s EWR hub on Eastern time, so DHLink\'s copies of its scans stay one with them', () => {
    // Live shape: DHLink relays SwiftX's hub scans on China's clock, and
    // SwiftX's copies carry the hub's wall clock; its label is on GMT-07:00.
    const eyt = 'EYT0000000000HZ';
    const scans = (timezone: string | null = null) => parseParcelsAppResponse({ carriers: ['DHLink', 'SwiftX'], originCode: 'CN', destinationCode: 'US',
      states: [
        { date: '2026-07-08T21:17:44Z', status: 'Departed Origin Hub', carrier: 0, location: 'EWR HUB, United States' },
        { date: '2026-07-08T11:05:12Z', status: 'Arrived at Origin Hub', carrier: 0, location: 'EWR HUB, United States' },
        { date: '2026-07-08T09:17:44Z', status: 'Departed Origin Hub', carrier: 1, location: 'US, EXAMPLE TOWN, EWR HUB' },
        { date: '2026-07-07T23:05:12Z', status: 'Arrived at Origin Hub', carrier: 1, location: 'US, EXAMPLE TOWN, EWR HUB' },
        { date: '2026-06-26T10:12:09Z', status: 'Package received and scanned at warehouse', carrier: 0 },
        { date: '2026-06-24T18:20:31Z', status: 'Shipping Label Created', carrier: 1, location: 'US, SYSTEM, SYSTEM' },
      ] }, eyt, identity(eyt), timezone).events?.map(({ time, description }) => [time, description]);
    const expected = [
      ['2026-07-08T13:17:44.000Z', 'Departed Origin Hub'], ['2026-07-08T03:05:12.000Z', 'Arrived at Origin Hub'],
      ['2026-06-26T02:12:09.000Z', 'Package received and scanned at warehouse'], ['2026-06-25T01:20:31.000Z', 'Shipping Label Created'],
    ];
    expect(scans()).toEqual(expected);
    expect(scans('America/Los_Angeles')).toEqual(expected);
  });

  it("drops a partner's copy that DHLink relays on its US wall clock beside its own row on China's", () => {
    // Live shape: DHLink's feed has SwiftX's label at SwiftX's digits and at DHLink's,
    // the same instant; read on China's clock, the copy came 15 hours early.
    const ktd = 'KTDWE0000000000';
    const own = { date: '2026-10-09T10:32:09Z', status: 'Shipping Label Created', carrier: 0, location: 'SYSTEM, United States' };
    const copy = { ...own, date: '2026-10-08T19:32:09Z' };
    const warehouse = { date: '2026-10-09T00:33:06Z', status: 'Package received & scanned at warehouse', carrier: 0 };
    const times = (states: Record<string, unknown>[], destinationCode = 'US') => parseParcelsAppResponse({ carriers: ['DHLink'],
      originCode: 'CN', destinationCode, states }, ktd, identity(ktd), 'Asia/Shanghai').events?.map(({ time }) => time);
    expect(times([own, warehouse, copy])).toEqual(['2026-10-09T02:32:09.000Z', '2026-10-08T16:33:06.000Z']);
    // Alone, or on a parcel to another country, a row keeps its clock.
    expect(times([warehouse, copy])).toEqual(['2026-10-08T16:33:06.000Z', '2026-10-08T11:32:09.000Z']);
    expect(times([own, warehouse, copy], 'MX')).toHaveLength(3);
  });

  it("drops DHLink's copy of a SwiftX scan at SwiftX's digits when the reply has SwiftX's own row and not DHLink's", () => {
    // Live shape: DHLink's feed relays SwiftX's label and hub scans at SwiftX's digits under the town and
    // state; read on China's clock, each came 13 to 15 hours early beside SwiftX's own row.
    const swx = 'SWX000000000000000001';
    const result = parseParcelsAppResponse({ carriers: ['SwiftX', 'DHLink'], originCode: 'CN', destinationCode: 'US', states: [
      { date: '2026-10-29T11:51:17Z', status: 'Arrived at Destination Hub', carrier: 0, location: 'US, EXAMPLE TOWN, LAX HUB' },
      { date: '2026-10-29T11:51:17Z', status: 'Arrived at Destination Hub', carrier: 1, location: 'EXAMPLE TOWN, California, United States' },
      { date: '2026-10-27T03:10:56Z', status: 'Arrived at Origin Hub', carrier: 0, location: 'US, EXAMPLE TOWN, ORD HUB' },
      { date: '2026-10-27T03:10:56Z', status: 'Arrived at Origin Hub', carrier: 1, location: 'EXAMPLE TOWN, Illinois, United States' },
      { date: '2026-10-09T00:33:06Z', status: 'Package received & scanned at warehouse', carrier: 1 },
      { date: '2026-10-08T19:32:09Z', status: 'Shipping Label Created', carrier: 0, location: 'US, SYSTEM, SYSTEM' },
      { date: '2026-10-08T19:32:09Z', status: 'Shipping Label Created', carrier: 1, location: 'SYSTEM, United States' },
    ] }, swx, identity(swx), 'UTC');
    expect(result.events?.map(({ time, description }) => [time, description])).toEqual([
      ['2026-10-29T18:51:17.000Z', 'Arrived at Destination Hub'], ['2026-10-27T08:10:56.000Z', 'Arrived at Origin Hub'],
      ['2026-10-09T02:32:09.000Z', 'Shipping Label Created'],
      // DHLink's own row stays on China's clock.
      ['2026-10-08T16:33:06.000Z', 'Package received & scanned at warehouse'],
    ]);
  });

  it('reads SwiftX\'s listed sites in their zone, its labels on GMT-07:00 in every season and its other scans on Pacific time', () => {
    const swx = 'SWX000000000000000001';
    const times = (states: Record<string, unknown>[]) =>
      parseParcelsAppResponse({ carriers: ['SwiftX'], states }, swx, identity(swx)).events?.map(({ time }) => time);
    expect(times([
      { date: '2026-01-17T06:15:30Z', status: 'Arrived at Destination Hub', carrier: 0, location: 'US, EXAMPLE CITY, ABC HUB' },
      { date: '2026-01-14T22:40:05Z', status: 'Departed Origin Hub', carrier: 0, location: 'US, EXAMPLE TOWN, EWR HUB' },
      { date: '2026-01-12T03:42:21Z', status: 'Shipping Label Created', carrier: 0, location: 'US, SYSTEM, SYSTEM' },
    ])).toEqual(['2026-01-17T14:15:30.000Z', '2026-01-15T03:40:05.000Z', '2026-01-12T10:42:21.000Z']);
    // A label at the hub keeps the label's clock.
    expect(times([{ date: '2026-01-12T03:42:21Z', status: 'Shipping Label Created', carrier: 0, location: 'US, EXAMPLE TOWN, EWR HUB' }]))
      .toEqual(['2026-01-12T10:42:21.000Z']);
    // The rendered page prints no site, but names the label.
    expect(parseParcelsAppHtml(identity(swx).replace('</table>', `</table><ul class="events">${
      carrierRow('12 Jan 2026', '03:42', 'Shipping Label Created', 'SwiftX')}</ul>`), swx).events?.[0]?.time).toBe('2026-01-12T10:42:00.000Z');
  });

  it("dates SwiftX's New Jersey warehouse and the deliveries it sends out on Eastern time", () => {
    // Live shape: SwiftX's own tracker gives these scans -04:00, to the second.
    const swx = 'SWX000000000000000001';
    const times = (states: Record<string, unknown>[]) =>
      parseParcelsAppResponse({ carriers: ['SwiftX'], states }, swx, identity(swx)).events?.map(({ time, description }) => [time, description]);
    expect(times([
      { date: '2026-10-26T07:13:03Z', status: 'Out for Delivery', carrier: 0, location: 'US, EXAMPLE TOWN, EWR_NJ Warehouse' },
      { date: '2026-10-23T11:12:29Z', status: 'Delivery failed', carrier: 0, location: 'US, Example Village' },
      { date: '2026-10-23T06:39:42Z', status: 'Out for Delivery', carrier: 0, location: 'US, EXAMPLE TOWN, EWR_NJ Warehouse' },
      { date: '2026-10-23T02:45:41Z', status: 'Arrived At Warehouse', carrier: 0, location: 'US, EXAMPLE TOWN, EWR_NJ Warehouse' },
      { date: '2026-10-23T02:44:16Z', status: 'Departed Destination Hub', carrier: 0, location: 'US, EXAMPLE TOWN, EWR HUB' },
      { date: '2026-10-19T10:22:17Z', status: 'Shipping Label Created', carrier: 0, location: 'US, SYSTEM, SYSTEM' },
    ])).toEqual([
      ['2026-10-26T11:13:03.000Z', 'Out for Delivery'], ['2026-10-23T15:12:29.000Z', 'Delivery failed'],
      ['2026-10-23T10:39:42.000Z', 'Out for Delivery'], ['2026-10-23T06:45:41.000Z', 'Arrived At Warehouse'],
      ['2026-10-23T06:44:16.000Z', 'Departed Destination Hub'], ['2026-10-19T17:22:17.000Z', 'Shipping Label Created'],
    ]);
    // A delivery with no listed site before it keeps SwiftX's Pacific time.
    expect(times([
      { date: '2026-10-23T11:12:29Z', status: 'Delivered', carrier: 0, location: 'US, Example Village' },
      { date: '2026-10-23T06:39:42Z', status: 'Out for Delivery', carrier: 0, location: 'US, EXAMPLE CITY, ABC Warehouse' },
    ])?.map(([time]) => time)).toEqual(['2026-10-23T18:12:29.000Z', '2026-10-23T13:39:42.000Z']);
  });

  it('reads the networks ParcelsApp names its own way on their home clock', () => {
    const times = (carriers: string[], states: Record<string, unknown>[], trackingNumber = number) =>
      parseParcelsAppResponse({ carriers, states }, trackingNumber, identity(trackingNumber)).events?.map((scan) => scan.time);
    const scan = (date: string, location?: string) => ({ date, status: 'In transit', carrier: 0, ...(location ? { location } : {}) });
    // Live shapes (2026-10-10). The network's own instants on its clock, wherever the scan was.
    expect(times(['Italy Post'], [scan('2026-10-02T10:07:00Z', 'from the operational headquarters of EXAMPLE (XX)')]))
      .toEqual(['2026-10-02T08:07:00.000Z']);
    expect(times(['New Zealand Post'], [scan('2026-01-11T07:40:00Z'), scan('2025-12-17T11:15:00Z', 'Hong Kong')]))
      .toEqual(['2026-01-10T18:40:00.000Z', '2025-12-16T22:15:00.000Z']);
    expect(times(['Singapore Post'], [scan('2026-07-07T14:44:00+00:00')])).toEqual(['2026-07-07T06:44:00.000Z']);
    expect(times(['SunYou - Sytrack'], [scan('2021-07-20T11:30:00Z', '1000')])).toEqual(['2021-07-20T03:30:00.000Z']);
    // Landmark Global's page clock is US Central's, whatever zone the check suggests.
    const landmark = { carriers: ['Landmark Global'], states: [scan('2026-10-14T09:00:00Z', 'Example City, Germany'), scan('2026-01-14T09:00:00Z')] };
    for (const hint of [null, 'Europe/Zurich']) {
      expect(parseParcelsAppResponse(landmark, number, identity(number), hint).events?.map((event) => event.time))
        .toEqual(['2026-10-14T14:00:00.000Z', '2026-01-14T15:00:00.000Z']);
    }
    // Local clocks checked at home: another country's location comes first.
    expect(times(['South Korea Post'], [scan('2026-09-30T13:48:00Z', 'Example Post Office'), scan('2026-09-29T12:00:00Z', 'Example City, Germany')]))
      .toEqual(['2026-09-30T04:48:00.000Z', '2026-09-29T10:00:00.000Z']);
    expect(times(['Posten Norge - Norway Post'], [scan('2026-09-30T09:38:23Z'), scan('2026-09-30T06:17:37Z', 'Example Town, Denmark, 1000')]))
      .toEqual(['2026-09-30T07:38:23.000Z', '2026-09-30T04:17:37.000Z']);
    for (const name of ['Royal Mail', 'Parcelforce', 'Parcelforce Worldwide']) {
      expect(times([name], [scan('2026-09-16T14:39:39Z', 'Example DO')])).toEqual(['2026-09-16T13:39:39.000Z']);
    }
    expect(times(['Japan Post'], [scan('2026-10-02T10:27:00Z', 'Example Town')])).toEqual(['2026-10-02T01:27:00.000Z']);
    for (const name of ['Yodel', 'InPost UK', 'Collect+']) {
      expect(times([name], [scan('2026-09-29T21:42:44Z'), scan('2026-09-28T09:00:00Z', 'Example City, Poland')]))
        .toEqual(['2026-09-29T20:42:44.000Z', '2026-09-28T07:00:00.000Z']);
    }
    expect(times(['Pekaes'], [scan('2026-10-14T09:00:00Z', 'Example City, Latvia'), scan('2026-10-13T07:39:54Z', 'EXAMPLE TOWN'), scan('2026-10-13T05:10:00Z')]))
      .toEqual(['2026-10-14T06:00:00.000Z', '2026-10-13T05:39:54.000Z', '2026-10-13T03:10:00.000Z']);
    // A DPD UK depot number named "DPD France": DPD UK's clock. A French one keeps Paris.
    const dpd = [scan('2026-07-22T14:17:00Z')];
    expect(times(['DPD France'], dpd, '15500000000000')).toEqual(['2026-07-22T13:17:00.000Z']);
    expect(times(['DPD France'], dpd, '10000000000000')).toEqual(['2026-07-22T12:17:00.000Z']);
    expect(parseParcelsAppHtml(rendered(carrierRow('02 Oct 2026', '10:07', 'In transit', 'Italy Post')), number).events?.[0]?.time)
      .toBe('2026-10-02T08:07:00.000Z');
  });

  it('reads SunYou\'s destination leg on the destination\'s clock', () => {
    // SunYou's own feed dates its origin leg "+08:00" and its destination leg
    // "+02:00" for a parcel to Spain, where EcoScooting's own instants agree.
    const parse = (destinationCode?: string) => parseParcelsAppResponse({
      carriers: ['SunYou - Sytrack', 'EcoScooting'], ...(destinationCode ? { destinationCode } : {}), states: [
        { date: '2026-07-14T14:40:24Z', status: 'Delivery Success. Your shipment has been delivered successfully', carrier: 1 },
        { date: '2026-07-14T14:40:24Z', status: 'Delivered', carrier: 0, location: 'Example City' },
        { date: '2026-07-13T18:48:40Z', status: 'Delivery Failed, Reason: Consignee Is Not Available', carrier: 0, location: 'Example Town' },
        { date: '2026-07-12T20:56:13Z', status: 'Hand Over To Last Mile', carrier: 0, location: 'Example Hub' },
        { date: '2026-07-10T05:29:00Z', status: 'Arrived At Destination Country Airport', carrier: 0 },
        { date: '2026-07-09T15:34:00Z', status: 'Departed From Port Of Origin', carrier: 0 },
        { date: '2026-07-06T03:53:06Z', status: 'Pre-Shipment Info Sent To Spain', carrier: 0 },
      ] }, number, identity());
    // EcoScooting's delivery and SunYou's are one scan again.
    expect(parse('ES').events?.map((scan) => [scan.time, scan.description])).toEqual([
      ['2026-07-14T12:40:24.000Z', 'Delivered'],
      ['2026-07-13T16:48:40.000Z', 'Delivery Failed, Reason: Consignee Is Not Available'],
      ['2026-07-12T18:56:13.000Z', 'Hand Over To Last Mile'],
      ['2026-07-10T03:29:00.000Z', 'Arrived At Destination Country Airport'],
      ['2026-07-09T07:34:00.000Z', 'Departed From Port Of Origin'],
      ['2026-07-05T19:53:06.000Z', 'Pre-Shipment Info Sent To Spain'],
    ]);
    // A destination with several clocks, or none named, gives that leg only a guess.
    expect(parse('US').events?.slice(1, 4).map((scan) => scan.time)).toEqual([
      '2026-07-13T18:48:40.000Z', '2026-07-12T20:56:13.000Z', '2026-07-10T05:29:00.000Z',
    ]);
  });

  it('reads Speedaf\'s scans on China time up to the departing flight, then on the destination\'s', () => {
    // Cainiao's copies of the same scans carry the same digits.
    const parse = (destinationCode: string, departed = true) => parseParcelsAppResponse({
      carriers: ['Speedaf'], destinationCode, states: [
        { date: '2026-07-14T15:12:31Z', status: 'Cause of problem Rescheduled delivery', carrier: 0 },
        { date: '2026-07-14T11:05:10Z', status: 'Customs Clearance Completed', carrier: 0 },
        ...departed ? [{ date: '2026-07-11T20:30:00Z', status: 'Cargo flight departured', carrier: 0 }] : [],
        { date: '2026-07-11T15:40:12Z', status: 'Delivery to the airport', carrier: 0 },
        { date: '2026-07-09T14:22:05Z', status: 'Example warehouse, order has been received', carrier: 0 },
      ] }, number, identity()).events?.map((scan) => scan.time);
    expect(parse('RE')).toEqual([
      '2026-07-14T11:12:31.000Z', '2026-07-14T07:05:10.000Z', '2026-07-11T12:30:00.000Z', '2026-07-11T07:40:12.000Z', '2026-07-09T06:22:05.000Z',
    ]);
    expect(parse('NG')?.slice(0, 2)).toEqual(['2026-07-14T14:12:31.000Z', '2026-07-14T10:05:10.000Z']);
    // Without the flight, every scan is still in China.
    expect(parse('NG', false)?.slice(0, 2)).toEqual(['2026-07-14T07:12:31.000Z', '2026-07-14T03:05:10.000Z']);
  });

  it('reads Cainiao\'s copies in a Speedaf reply on Speedaf\'s clocks, either side of the departing flight', () => {
    // Cainiao's "Arrived at linehaul office" has the digits of Speedaf's "Cargo flight arrived" in the destination.
    const result = parseParcelsAppResponse({ carriers: ['Speedaf', 'Cainiao'], destinationCode: 'RE', states: [
      { date: '2026-07-14T09:30:00Z', status: 'Arrived at linehaul office', carrier: 1 },
      { date: '2026-07-14T09:30:00Z', status: 'Cargo flight arrived', carrier: 0 },
      { date: '2026-07-11T20:30:00Z', status: 'Cargo flight departured', carrier: 0 },
      { date: '2026-07-09T14:22:05Z', status: 'Order received successfully', carrier: 1 },
    ] }, number, identity(), 'Africa/Lagos');
    expect(result.events?.map((scan) => [scan.description, scan.time])).toEqual(expect.arrayContaining([
      ['Arrived at linehaul office', '2026-07-14T05:30:00.000Z'],
      ['Order received successfully', '2026-07-09T06:22:05.000Z'],
    ]));
  });

  it('reads Cainiao\'s copies of YFH\'s scans, which keep the seconds YFH leaves out, on YFH\'s clock', () => {
    // Live shape: YFH writes its scans to the minute with a place, Cainiao the same digits to the
    // second with none. Cainiao's own tracker gives them GMT+08:00; read on ParcelsApp's UTC
    // label they came eight hours after YFH's.
    const states = [
      { date: '2026-10-29T12:11:55Z', status: 'Customs clearance in progress', carrier: 0 },
      { date: '2026-10-29T12:11:00Z', status: 'Customs clearance in progress', carrier: 1, location: 'France' },
      { date: '2026-10-24T16:04:25Z', status: 'Shipment departed from facility', carrier: 0 },
      { date: '2026-10-24T16:04:00Z', status: 'Shipment departed from sorting center', carrier: 1, location: 'Example, China' },
      { date: '2026-10-23T18:51:18Z', status: 'Shipment picked up', carrier: 0 },
      { date: '2026-10-23T18:51:00Z', status: 'Shipment picked up', carrier: 1, location: 'Example, China' },
    ];
    const parse = (rows: typeof states) => parseParcelsAppResponse({ carriers: ['Cainiao', 'YFH'], destinationCode: 'FR', states: rows },
      number, identity()).events?.map((scan) => [scan.time, scan.location ?? null]);
    // The departure's wording differs; it takes the clock of Cainiao's copies around it.
    expect(parse(states)).toEqual([
      ['2026-10-29T04:11:55.000Z', null], ['2026-10-29T04:11:00.000Z', 'France'],
      ['2026-10-24T08:04:25.000Z', null], ['2026-10-24T08:04:00.000Z', 'Example, China'],
      ['2026-10-23T10:51:18.000Z', null], ['2026-10-23T10:51:00.000Z', 'Example, China'],
    ]);
    // A scan at another minute, or one with seconds of its own, is no copy to the minute.
    expect(parse([states[0]!, { ...states[1]!, date: '2026-10-29T12:12:00Z' }])?.[0]).toEqual(['2026-10-29T12:11:55.000Z', null]);
    expect(parse([states[0]!, { ...states[1]!, date: '2026-10-29T12:11:30Z' }])?.[0]).toEqual(['2026-10-29T12:11:55.000Z', null]);
  });

  it('reads China Post\'s scans in China, and those no place dates, on Beijing\'s clock', () => {
    // 17TRACK's copies of the same scans carry "+08:00"; ParcelsApp labels the digits UTC.
    const result = parseParcelsAppResponse({ carriers: ['China Post'], states: [
      { date: '2026-07-03T09:12:12Z', status: 'In transit', carrier: 0, location: 'Example Town ENG GB AB1' },
      { date: '2026-07-01T10:10:00Z', status: '启运【HK】', carrier: 0, location: 'HK' },
      { date: '2026-06-29T23:01:26Z', status: 'Customs clearance completed', carrier: 0, location: 'Shenzhen' },
      { date: '2026-06-28T21:40:07Z', status: 'Departed from sorting center', carrier: 0, location: 'Example City, Guangdong' },
      { date: '2026-06-28T10:05:16Z', status: 'China Post has received the mail', carrier: 0, location: '示例市 12345678' },
      { date: '2026-06-28T01:00:00Z', status: 'Electronic information received', carrier: 0 },
    ] }, number, identity());
    expect(result.events?.map((scan) => scan.time)).toEqual([
      '2026-07-03T01:12:12.000Z', // a place it cannot tell
      '2026-07-01T02:10:00.000Z', // Hong Kong
      '2026-06-29T15:01:26.000Z', // a mainland city alone
      '2026-06-28T13:40:07.000Z',
      '2026-06-28T02:05:16.000Z',
      '2026-06-27T17:00:00.000Z', // no place
    ]);
    // A place the steps date keeps its own clock.
    expect(parseParcelsAppResponse({ carriers: ['China Post'], states: [
      { date: '2026-07-04T09:12:12Z', status: 'Arrived', carrier: 0, location: 'Example Town, United Kingdom' },
    ] }, number, identity()).events?.map((scan) => scan.time)).toEqual(['2026-07-04T08:12:12.000Z']);
  });

  it('reads China Post\'s copies of the destination post\'s scans on the destination\'s clock', () => {
    // UPU's copies at the destination's office of exchange have the same digits.
    const states = [
      { date: '2026-08-26T16:19:00Z', status: 'Successfully delivered', carrier: 0, location: '哥伦' },
      { date: '2026-08-25T13:26:00Z', status: 'Departed from 境外经转局', carrier: 0 },
      { date: '2026-08-25T12:44:00Z', status: 'Arrive at the place of destination', carrier: 0 },
    ];
    const parse = (destinationCode: string) => parseParcelsAppResponse({ carriers: ['China Post'], originCode: 'CN', destinationCode, states },
      number, identity()).events?.map((scan) => scan.time ?? `wall ${scan.local_time}`);
    expect(parse('CO')).toEqual(['2026-08-26T21:19:00.000Z', '2026-08-25T18:26:00.000Z', '2026-08-25T04:44:00.000Z']);
    // Australia has several clocks: its scans keep their wall clock, and "哥伦" names no other destination.
    expect(parse('AU')).toEqual(['2026-08-26T08:19:00.000Z', 'wall 2026-08-25T13:26:00.000', '2026-08-25T04:44:00.000Z']);
  });

  it("reads China Post's English copies of the destination post's scans by their place or their twin", () => {
    // UPU dates its scan at a US ZIP Code on that office's clock, and China Post's copy has its digits.
    const times = (destinationCode: string, carriers: string[], states: Record<string, unknown>[]) => parseParcelsAppResponse(
      { carriers, originCode: 'CN', destinationCode, states }, number, identity()).events?.map((scan) => scan.time ?? `wall ${scan.local_time}`);
    expect(times('US', ['China Post', 'Universal Postal Union'], [
      { date: '2026-09-17T11:25:00Z', status: 'Delivered', carrier: 0, location: 'Delivered' },
      { date: '2026-09-17T11:25:00Z', status: 'Final delivery', carrier: 1, location: '12345' },
      { date: '2026-09-17T06:10:00Z', status: 'Out for Delivery', carrier: 0, location: 'EXAMPLE CITY, NY 12345' },
      { date: '2026-09-15T04:44:00Z', status: 'Arrive at the place of destination', carrier: 0 },
    ])).toEqual(['2026-09-17T15:25:00.000Z', 'wall 2026-09-17T06:10:00.000', '2026-09-14T20:44:00.000Z']);
    // New Zealand Post's own delivery has the minute of China Post's copy at its own code.
    expect(times('NZ', ['China Post', 'New Zealand Post'], [
      { date: '2026-10-14T12:50:32Z', status: 'Your item has been delivered', carrier: 1 },
      { date: '2026-10-14T12:50:00Z', status: 'Final delivery', carrier: 0, location: 'XYZ' },
      { date: '2026-10-12T10:00:00Z', status: 'Arrive at the place of destination', carrier: 0, location: 'XYZ' },
    ])).toEqual(['2026-10-13T23:50:32.000Z', '2026-10-13T23:50:00.000Z', '2026-10-12T02:00:00.000Z']);
    // Elsewhere a ZIP Code is no US office's, and China Post's copy keeps China's clock.
    expect(times('DE', ['China Post', 'Universal Postal Union'], [
      { date: '2026-09-17T11:25:00Z', status: 'Delivered', carrier: 0, location: 'Delivered' },
      { date: '2026-09-17T11:25:00Z', status: 'Final delivery', carrier: 1, location: '12345' },
    ])?.at(-1)).toBe('2026-09-17T03:25:00.000Z');
  });

  it("dates UPU's scans at an office the destination's code names by the office's place", () => {
    // 4-72 dates the delivery UPU copies at such an office at the same digits, as China Post's copy has them.
    const parse = (destinationCode: string, location: string) => dateLocalClocks('parcelsapp', parseParcelsAppResponse({
      carriers: ['China Post', 'Universal Postal Union'], originCode: 'CN', destinationCode, states: [
        { date: '2026-08-26T16:19:00Z', status: 'Successfully delivered', carrier: 0, location: '哥伦' },
        { date: '2026-08-26T16:19:00Z', status: 'Entrega final', carrier: 1, location },
      ] }, number, identity())).events?.find((scan) => scan.description === 'Entrega final')?.time;
    expect(parse('CO', 'COQQQA')).toBe('2026-08-26T16:19:00-05:00');
    // A town's name is no office: "MADRID" on a parcel to Morocco is in Madrid.
    expect(parse('MA', 'MADRID')).toBe('2026-08-26T16:19:00+02:00');
    // Elsewhere the code keeps ParcelsApp's label.
    expect(parse('ES', 'COQQQA')).toBe('2026-08-26T16:19:00.000Z');
  });

  it('reads CTT\'s copies on the clock of each side of the border, which its offices of exchange tell', () => {
    // CTT's own tracker and Royal Mail's offsets give the same scans these digits, on each place's clock.
    const times = (originCode: string, destinationCode: string, states: Record<string, unknown>[]) => parseParcelsAppResponse({
      carriers: ['Portugal Post - Portugal CTT'], originCode, destinationCode, states,
    }, number, identity()).events?.map((scan) => scan.time);
    expect(times('GB', 'PT', [
      { date: '2026-09-14T10:21:17Z', status: 'In transit. Arrived at the destination country.', carrier: 0, location: 'PTLISE - (CTC) LISBON CUSTOMS' },
      { date: '2026-09-14T08:48:52Z', status: 'In transit. Arrived at the destination country.', carrier: 0, location: 'PTLISB - (OUTRO) LISBON PROV' },
      { date: '2026-09-09T05:05:00Z', status: 'In transit. Forwarded to the destination country.', carrier: 0, location: 'GBLALA - (OUTRO) EXAMPLE HWDC' },
      { date: '2026-09-08T19:26:00Z', status: 'Accepted. The shipment has been accepted.', carrier: 0, location: 'EXAMPLE MC' },
    ])).toEqual(['2026-09-14T09:21:17.000Z', '2026-09-14T07:48:52.000Z', '2026-09-09T04:05:00.000Z', '2026-09-08T18:26:00.000Z']);
    // Bound abroad, a scan after the last at a Portuguese office is the destination post's.
    expect(times('PT', 'FR', [
      { date: '2026-09-16T11:40:00Z', status: 'Delivered.', carrier: 0, location: 'EXAMPLE TOWN' },
      { date: '2026-09-14T08:48:52Z', status: 'In transit. Left the origin country.', carrier: 0, location: 'PTLISB - (OUTRO) LISBON PROV' },
      { date: '2026-09-13T12:30:00Z', status: 'Accepted.', carrier: 0, location: 'EXAMPLE PLACE' },
    ])).toEqual(['2026-09-16T09:40:00.000Z', '2026-09-14T07:48:52.000Z', '2026-09-13T11:30:00.000Z']);
    // From Spain, a CTT Express agency's scan is on Madrid's clock and a CTT sorting centre's on Lisbon's.
    expect(times('ES', 'PT', [
      { date: '2026-10-28T03:17:09Z', status: 'Chegou ao centro operacional', carrier: 0, location: '9999999 - (CO) C.O. EXAMPLE' },
      { date: '2026-10-27T11:00:05Z', status: 'Chegou ao centro operacional', carrier: 0, location: '009999 - (PL) CENTRO DE TRATAMIENTO ADUANERO' },
    ])).toEqual(['2026-10-28T03:17:09.000Z', '2026-10-27T10:00:05.000Z']);
  });

  it('reads Royal Mail\'s relays of its partners\' scans abroad on Central European time', () => {
    // La Poste's own scans have the digits of Royal Mail's in France, and CTT's are an hour less in Portugal.
    const times = (destinationCode: string, states: Record<string, unknown>[]) => parseParcelsAppResponse({
      carriers: ['Royal Mail'], originCode: 'GB', destinationCode, states,
    }, number, identity()).events?.map((scan) => scan.time);
    const scan = (date: string, status: string, location?: string) => ({ date, status, carrier: 0, ...(location ? { location } : {}) });
    expect(times('PT', [
      scan('2026-07-21T11:24:00Z', 'Your item is currently with Customs in the destination country.'),
      scan('2026-07-21T10:05:00Z', 'Item Received', 'Portugal'),
      scan('2026-07-17T04:12:09Z', 'Item Leaving the UK', 'EXAMPLE HWDC'),
      scan('2026-07-16T18:40:00Z', 'Item Received', 'Example MC'),
    ])).toEqual(['2026-07-21T09:24:00.000Z', '2026-07-21T08:05:00.000Z', '2026-07-17T03:12:09.000Z', '2026-07-16T17:40:00.000Z']);
    expect(times('FR', [scan('2026-07-21T19:30:00Z', 'Item has left the overseas International Processing Centre', 'EXAMPLE IPC, France')]))
      .toEqual(['2026-07-21T17:30:00.000Z']);
    expect(parseParcelsAppResponse({ carriers: ['Parcelforce'], originCode: 'GB', destinationCode: 'FR',
      states: [scan('2026-07-21T19:30:00Z', 'Item Received', 'EXAMPLE IPC, France')] }, number, identity()).events?.[0]?.time)
      .toBe('2026-07-21T17:30:00.000Z');
    // Beyond Europe the label is on London time: the South African post's own clock gives these scans the same instants.
    expect(times('US', [scan('2026-09-11T23:38:00Z', 'Item Received', 'Example City, USA')])).toEqual(['2026-09-11T22:38:00.000Z']);
    expect(times('ZA', [
      scan('2026-10-20T23:07:00Z', 'Released from Customs', 'South Africa'),
      scan('2026-10-20T22:55:00Z', 'Your item is currently with Customs in the destination country', 'EXAMPLE EMS'),
      scan('2026-10-20T22:54:00Z', 'Item Received', 'EXAMPLE EMS, South Africa'),
    ])).toEqual(['2026-10-20T22:07:00.000Z', '2026-10-20T21:55:00.000Z', '2026-10-20T21:54:00.000Z']);
    // Bound for the UK, a customs scan with no place is Royal Mail's own, at home, as are the Crown Dependencies'.
    expect(times('GB', [
      scan('2026-07-21T11:24:00Z', 'Your item is currently with Customs in the destination country.'),
      scan('2026-07-20T09:02:00Z', 'Item Received', 'Jersey'),
    ])).toEqual(['2026-07-21T10:24:00.000Z', '2026-07-20T08:02:00.000Z']);
  });

  it("reads Interpost's import declaration and clearance on a Pitney Bowes parcel on the clock of the country they name", () => {
    // Pitney Bowes's own adapter reads them there; TrackYourParcel's copies name no country and take Pitney Bowes's.
    const scan = (date: string, status: string, carrier: number, location?: string) => ({ date, status, carrier, ...(location ? { location } : {}) });
    const states = [
      scan('2026-10-22T12:42:00Z', 'B2C ClearanceStatus4', 0, 'NL'),
      scan('2026-10-22T12:42:00Z', 'B2C Clearance 4. Customs Import cleared', 1),
      scan('2026-10-21T09:55:00Z', 'Customs Clearance', 0, 'IT'),
      scan('2026-10-21T09:55:00Z', 'Customs Clearance. Customs Import submitted', 1),
      scan('2026-10-21T08:10:00Z', 'Shipped from Global Shipping Center to Destination', 0, 'Example Town, Exampleshire, GB'),
    ];
    const times = (rows: Record<string, unknown>[]) => parseParcelsAppResponse({ carriers: ['Pitney Bowes', 'TrackYourParcel'], states: rows },
      number, identity(), 'Europe/London').events?.map((event) => [event.description, event.time]);
    expect(times(states)).toEqual([
      ['B2C ClearanceStatus4', '2026-10-22T10:42:00.000Z'],
      ['Customs Import cleared', '2026-10-22T10:42:00.000Z'],
      ['Customs Clearance', '2026-10-21T07:55:00.000Z'],
      ['Customs Clearance. Customs Import submitted', '2026-10-21T07:55:00.000Z'],
      ['Shipped from Global Shipping Center to Destination', '2026-10-21T07:10:00.000Z'],
    ]);
    // A copy with no Pitney Bowes copy at the same minute, or one naming no country alone, is read as before.
    expect(times([states[1]!, { ...states[2]!, location: 'Example Town, Exampleshire, GB' }])).toEqual([
      ['Customs Import cleared', '2026-10-22T11:42:00.000Z'],
      ['Customs Clearance', '2026-10-21T08:55:00.000Z'],
    ]);
  });

  it("reads Pitney Bowes's unplaced platform scans and postal relays as its own adapter does, and TrackYourParcel's copies with them", () => {
    const scan = (date: string, status: string, carrier: number, location?: string) => ({ date, status, carrier, ...(location ? { location } : {}) });
    const hub = 'Example Town, Exampleshire, GB';
    const read = (states: Record<string, unknown>[], destinationCode?: string) => parseParcelsAppResponse({
      carriers: ['Pitney Bowes', 'TrackYourParcel'], originCode: 'GB', ...(destinationCode ? { destinationCode } : {}), states,
    }, number, identity(), 'Europe/London').events?.map((event) => [event.description, event.time ?? event.local_time]);
    // Each platform scan is at the instant of the hub's processing; the hand-over is on a fixed UTC+2, in winter too.
    const platform = (day: string, hub1: string, hub0: string, handOver: string) => [
      scan(`${day}T${handOver}:00Z`, 'Interpost handed item over to postal company', 0),
      scan(`${day}T${handOver}:00Z`, 'Shipped. Departure to country of destination', 1),
      scan(`${day}T${hub1}:00Z`, 'Processing at Shipping Center', 0, hub),
      scan(`${day}T${hub0}:00Z`, 'Item processed at Interpost', 0),
      scan(`${day}T${hub0}:00Z`, 'Ready to Ship. FML label requested', 1),
    ];
    expect(read(platform('2026-05-11', '08:58', '07:58', '09:58'))).toEqual([
      ['Interpost handed item over to postal company', '2026-05-11T07:58:00.000Z'],
      ['Shipped. Departure to country of destination', '2026-05-11T07:58:00.000Z'],
      ['Processing at Shipping Center', '2026-05-11T07:58:00.000Z'],
      ['Item processed at Interpost', '2026-05-11T07:58:00.000Z'],
      ['Ready to Ship. FML label requested', '2026-05-11T07:58:00.000Z'],
    ]);
    expect(read(platform('2026-01-06', '13:14', '13:14', '15:14'))?.map(([, time]) => time)).toEqual(Array(5).fill('2026-01-06T13:14:00.000Z'));
    // The destination post's scans it relays are on that post's clock: Rome's for a parcel bound for Italy.
    const relays = [
      scan('2026-05-21T14:48:00Z', 'Item has been delivered', 0),
      scan('2026-05-21T13:41:00Z', 'Parcel is out for delivery', 0),
      scan('2026-05-21T13:41:00Z', 'Out for Delivery. Example caption', 1),
    ];
    expect(read(relays, 'IT')).toEqual([
      ['Delivered', '2026-05-21T12:48:00.000Z'],
      ['Parcel is out for delivery', '2026-05-21T11:41:00.000Z'],
      ['Out for Delivery. Example caption', '2026-05-21T11:41:00.000Z'],
    ]);
    // Bound for no single clock, they keep their wall clock, as Pitney Bowes's own adapter does.
    expect(read(relays)).toEqual([
      ['Delivered', '2026-05-21T14:48:00.000'],
      ['Parcel is out for delivery', '2026-05-21T13:41:00.000'],
      ['Out for Delivery. Example caption', '2026-05-21T13:41:00.000'],
    ]);
  });

  it('reads the South African post\'s and EMS\'s copies of a UK parcel\'s scans on the clock where each happened', () => {
    // Parcelforce's labels are London's; SAPO's and EMS's copies are the wall clock of the office that scanned.
    const scan = (date: string, status: string, carrier: number, location?: string) => ({ date, status, carrier, ...(location ? { location } : {}) });
    const parsed = parseParcelsAppResponse({ carriers: ['South Africa Post Office', 'Parcelforce', 'EMS'], originCode: 'GB', destinationCode: 'ZA', states: [
      scan('2026-07-22T00:00:00Z', 'Estimated delivery', 0),
      scan('2026-07-21T01:09:00+00:00', 'Departed from destination import office', 2, 'Example City'),
      scan('2026-07-21T00:07:00+00:00', 'Released from import customs', 2),
      scan('2026-07-20T23:58:00+00:00', 'Held at destination import office', 2),
      scan('2026-07-20T23:55:00+00:00', 'Presented to import customs', 2),
      scan('2026-07-20T23:55:00+00:00', 'Held for customs inspection', 2),
      scan('2026-07-20T23:54:00Z', 'Arrival at inward office of exchange', 0, 'EXAMPLE EMS, South Africa'),
      scan('2026-07-20T23:54:00+00:00', 'Arrived at destination import office', 2, 'Example City'),
      scan('2026-07-20T22:54:00Z', 'Item Received', 1, 'EXAMPLE EMS, South Africa'),
      scan('2026-07-16T01:48:06Z', 'Item Leaving the UK', 1, 'EXAMPLE HWDC'),
      scan('2026-07-16T01:48:00Z', 'Departure from outward office of exchange', 0, 'EXAMPLE HWDC, United Kingdom'),
      scan('2026-07-16T01:48:00+00:00', 'Departed from export office', 2, 'Example Town'),
    ] }, number, identity());
    expect(parsed.events?.map((event) => [event.description, event.time])).toEqual([
      ['Departed from destination import office', '2026-07-20T23:09:00.000Z'],
      ['Released from import customs', '2026-07-20T22:07:00.000Z'],
      ['Held at destination import office', '2026-07-20T21:58:00.000Z'],
      ['Presented to import customs', '2026-07-20T21:55:00.000Z'],
      ['Held for customs inspection', '2026-07-20T21:55:00.000Z'],
      ['Arrival at inward office of exchange', '2026-07-20T21:54:00.000Z'],
      ['Arrived at destination import office', '2026-07-20T21:54:00.000Z'],
      ['Item Received', '2026-07-20T21:54:00.000Z'],
      ['Item Leaving the UK', '2026-07-16T00:48:06.000Z'],
      ['Departure from outward office of exchange', '2026-07-16T00:48:00.000Z'],
      ['Departed from export office', '2026-07-16T00:48:00.000Z'],
    ]);
    // ParcelsApp's forecast is no scan: it neither dates the reply nor names its status.
    expect(parsed.last_status_text).toBe('Departed from destination import office');
  });

  it('leaves out GEODIS Poland\'s summary, which ParcelsApp dates after each of its reads', () => {
    // GEODIS Poland's own tracker gives the status with no scan; ParcelsApp's date moves with its reads.
    const summary = { date: '2026-10-28T16:55:00Z', status: 'Transferred Data', carrier: 0 };
    expect(() => parseParcelsAppResponse({ carriers: ['Pekaes'], states: [summary] }, number, identity()))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseParcelsAppHtml(rendered(carrierRow('28 Oct 2026', '16:55', 'Transferred Data', 'Pekaes')), number))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const parsed = parseParcelsAppResponse({ carriers: ['Pekaes'], states: [summary,
      { date: '2026-10-28T09:30:00Z', status: 'Shipment picked up', carrier: 0 }] }, number, identity());
    expect(parsed.events?.map((event) => [event.description, event.time])).toEqual([['Shipment picked up', '2026-10-28T08:30:00.000Z']]);
  });

  it('reads FIRST LINE\'s scans in China on Beijing\'s clock with its own map, and its partner\'s in the destination on theirs', () => {
    // 17TRACK's copies of the Chinese rows have Beijing's instants; GOFO's own scans give California's clock.
    const scan = (date: string, status: string, carrier: number, location?: string) => ({ date, status, carrier, ...(location ? { location } : {}) });
    const parsed = parseParcelsAppResponse({ carriers: ['1ST', 'GoFo Express'], originCode: 'CN', destinationCode: 'US', states: [
      scan('2026-10-21T05:22:36Z', 'In Transit to Next Facility', 1, 'Example Grove, CA'),
      scan('2026-10-21T05:22:00Z', 'Arrived at Facility', 0, 'Example Grove, CA, Example Grove CA 00000'),
      scan('2026-10-19T11:30:00Z', 'Import Scan', 0, 'Los Angeles USA US'),
      scan('2026-10-18T05:55:00Z', 'Arrived at Destination Airport', 0, 'Los Angeles USA US'),
      scan('2026-10-18T05:43:00Z', 'Departed from Origin Airport', 0, 'SHENZHEN'),
      scan('2026-10-17T16:51:00Z', 'Arrived at Origin Airport', 0, 'SZ international airport'),
      scan('2026-10-16T16:41:00Z', 'Export customs declaration completed', 0, 'SHENZHEN'),
      scan('2026-10-16T02:34:00Z', 'Packaged', 0, 'SHENZHEN'),
      scan('2026-10-15T22:30:00Z', 'Barcode scanning', 0, 'SHENZHEN'),
      scan('2026-10-14T16:08:00Z', 'Forecast has been received', 0),
    ] }, number, identity());
    expect(parsed.events?.map((event) => [event.description, event.time, event.stage, event.stage_source])).toEqual([
      ['In Transit to Next Facility', '2026-10-21T12:22:36.000Z', 'in_transit', 'wording:language'],
      ['Arrived at Facility', '2026-10-21T12:22:00.000Z', 'in_transit', 'wording:language'],
      ['Import Scan', '2026-10-19T18:30:00.000Z', 'in_transit', 'wording:language'],
      ['Arrived at Destination Airport', '2026-10-18T12:55:00.000Z', 'in_transit', 'wording:language'],
      ['Departed from Origin Airport', '2026-10-17T21:43:00.000Z', 'in_transit', 'wording:language'],
      ['Arrived at Origin Airport', '2026-10-17T08:51:00.000Z', 'in_transit', 'wording:language'],
      ['Export customs declaration completed', '2026-10-16T08:41:00.000Z', 'in_transit', 'carrier_map'],
      ['Packaged', '2026-10-15T18:34:00.000Z', 'in_transit', 'carrier_map'],
      ['Barcode scanning', '2026-10-15T14:30:00.000Z', 'accepted', 'carrier_map'],
      ['Forecast has been received', '2026-10-14T08:08:00.000Z', 'registered', 'carrier_map'],
    ]);
  });

  it('reads bpost\'s office of exchange abroad on its own clock, and bpost\'s copies of its scans on Brussels\'s', () => {
    // bpost's own feed copies an office's departure at the same instant, an hour later by the digits for an office in London.
    expect(parseParcelsAppResponse({ carriers: ['Bpost Belgium'], originCode: 'GB', destinationCode: 'DE', states: [
      { date: '2026-07-21T15:44:00Z', status: 'Item has passed a checkpoint', carrier: 0 },
      { date: '2026-07-21T14:44:00Z', status: 'Departure from office of exchange', carrier: 0, location: 'EXAMPLE OFFICE, United Kingdom' },
    ] }, number, identity()).events?.map((scan) => scan.time)).toEqual(['2026-07-21T13:44:00.000Z', '2026-07-21T13:44:00.000Z']);
  });

  it('reads the origin post\'s leg in UPU\'s and EMS\'s copies on the origin\'s clock, wherever their place is a code', () => {
    // China Post's scans in China share these digits; read as UTC, export customs would follow the release.
    const result = parseParcelsAppResponse({ carriers: ['Universal Postal Union', 'EMS'], originCode: 'CN', destinationCode: 'GB', states: [
      { date: '2026-10-12T09:00:00Z', status: 'Arrival at inward office of exchange', carrier: 0, location: 'EXAMPLE' },
      { date: '2026-10-11T02:42:00Z', status: 'Item returned from export Customs/Security', carrier: 0, location: 'GZSGJHHJ' },
      { date: '2026-10-10T21:58:00+00:00', status: 'Presented to export customs and security', carrier: 1, location: 'GZSGJHHJ' },
      { date: '2026-10-10T15:55:00Z', status: 'Posting/Collection', carrier: 0, location: '510000' },
    ] }, number, identity());
    expect(result.events?.map((scan) => scan.time)).toEqual([
      '2026-10-12T09:00:00.000Z', // past the origin's leg
      '2026-10-10T18:42:00.000Z', '2026-10-10T13:58:00.000Z', '2026-10-10T07:55:00.000Z',
    ]);
  });

  it('reads the Australian scans of the postal feeds on the clock of the state or state capital they name', () => {
    // Australia Post dates the same scans in Sydney at +11:00 in October; Brisbane keeps +10:00.
    const result = parseParcelsAppResponse({ carriers: ['Universal Postal Union', 'EMS'], originCode: 'AU', destinationCode: 'SA', states: [
      { date: '2026-10-08T05:46:00Z', status: 'Departed country of origin', carrier: 0, location: 'SYDNEY EMS, Australia' },
      { date: '2026-10-07T23:47:00+00:00', status: 'Arrived at export office', carrier: 1, location: 'Sydney' },
      { date: '2026-10-07T20:15:00+00:00', status: 'Item presented to export customs/security', carrier: 1, location: 'EXAMPLE TOWN WA 6000' },
    ] }, number, identity());
    expect(result.events?.map((scan) => scan.time)).toEqual([
      '2026-10-07T18:46:00.000Z', '2026-10-07T12:47:00.000Z', '2026-10-07T12:15:00.000Z',
    ]);
    // A state's abbreviation places no scan outside Australia: "SA" is not South Australia here.
    expect(parseParcelsAppResponse({ carriers: ['Universal Postal Union'], originCode: 'CN', destinationCode: 'GB', states: [
      { date: '2026-10-06T16:28:00Z', status: 'Arrival at inward office of exchange', carrier: 0, location: 'EXAMPLE SA' },
    ] }, number, identity()).events?.[0]?.time).toBe('2026-10-06T16:28:00.000Z');
  });

  it("reads the postal feeds' scans in a country of several clocks that their place names alone on its main clock", () => {
    // Correos Chile's own posting and Correios Brazil's arrival have these digits at -03:00.
    const times = (states: Record<string, unknown>[], carriers = ['Universal Postal Union', 'EMS']) => parseParcelsAppResponse(
      { carriers, originCode: 'CL', destinationCode: 'BR', states }, number, identity()).events?.map(({ time }) => time);
    expect(times([
      { date: '2026-09-29T08:06:00Z', status: 'Item presented to import Customs', carrier: 0, location: 'EXAMPLE CITY, Brazil' },
      { date: '2026-09-29T08:05:00+00:00', status: 'Arrived at inward office of exchange', carrier: 1, location: 'EXAMPLE CITY, Brazil' },
      { date: '2026-09-14T17:28:00Z', status: 'Departed country of origin', carrier: 0, location: 'SANTIAGO EXAMPLE, Chile' },
      { date: '2026-09-14T08:18:00Z', status: 'Arrived at international sorting center in country of origin', carrier: 0, location: 'SANTIAGO EXAMPLE, Chile' },
      { date: '2026-09-11T10:43:00Z', status: 'Posting/Collection', carrier: 0, location: 'SANTIAGO EXAMPLE, Chile' },
    ])).toEqual([
      '2026-09-29T11:06:00.000Z', '2026-09-29T11:05:00.000Z', '2026-09-14T20:28:00.000Z', '2026-09-14T11:18:00.000Z', '2026-09-11T13:43:00.000Z',
    ]);
    // A state's code is no country: "MN" is not Mongolia here.
    expect(times([{ date: '2026-09-29T08:06:00Z', status: 'Arrival at inward office of exchange', carrier: 0, location: 'EXAMPLE CITY, MN' }]))
      .toEqual(['2026-09-29T08:06:00.000Z']);
  });

  it('reads an Australian posting its office\'s capital names on its feed\'s clock first', () => {
    // Live shape: UPU names the office "BRISBANE" and EMS gives its code for the posting
    // Australia Post received in New South Wales at +11:00, Sydney's summer clock.
    const posting = (states: Record<string, unknown>[], carriers = ['Universal Postal Union', 'EMS']) =>
      parseParcelsAppResponse({ carriers, originCode: 'AU', destinationCode: 'SA', states }, number, identity()).events
        ?.map(({ time, description }) => [time, description]);
    const exported = [
      { date: '2026-10-08T05:46:00Z', status: 'Departed country of origin', carrier: 0, location: 'SYDNEY EMS, Australia' },
      { date: '2026-10-07T23:47:00+00:00', status: 'Arrived at export office', carrier: 1, location: 'Sydney' },
    ];
    expect(posting([...exported,
      { date: '2026-10-06T16:28:00Z', status: 'Posting/Collection', carrier: 0, location: 'BRISBANE, Australia' },
      { date: '2026-10-06T16:28:00+00:00', status: 'Posted', carrier: 1, location: 'EXAMPLE1' },
    ])?.slice(2)).toEqual([['2026-10-06T05:28:00.000Z', 'Posting/Collection'], ['2026-10-06T05:28:00.000Z', 'Posted']]);
    // With no placed scan of its feed to borrow from, the capital's clock dates it.
    expect(posting([{ date: '2026-10-06T16:28:00Z', status: 'Posting/Collection', carrier: 0, location: 'BRISBANE, Australia' }]))
      .toEqual([['2026-10-06T06:28:00.000Z', 'Posting/Collection']]);
    // A posting whose place names its state is read there; other scans keep their capital's clock.
    expect(posting([...exported,
      { date: '2026-10-07T10:00:00Z', status: 'Item presented to export customs/security', carrier: 0, location: 'BRISBANE, Australia' },
      { date: '2026-10-06T16:28:00Z', status: 'Posting/Collection', carrier: 0, location: 'EXAMPLE TOWN QLD 4000, Australia' },
    ])?.slice(2)).toEqual([
      ['2026-10-07T00:00:00.000Z', 'Item presented to export customs/security'], ['2026-10-06T06:28:00.000Z', 'Posting/Collection'],
    ]);
  });

  it('reads Saudi Post\'s scans abroad at their place or their copy\'s, and at home on Riyadh\'s clock', () => {
    // Live shape: SPL's copy of the departure from Sydney, in its own words at its
    // office, has the digits of EMS's and UPU's there; SPL's tracker gives them too.
    const times = (states: Record<string, unknown>[], timezone: string | null = null) => parseParcelsAppResponse({
      carriers: ['Universal Postal Union', 'SPL', 'EMS'], originCode: 'AU', destinationCode: 'SA', states,
    }, number, identity(), timezone).events?.map(({ time, description }) => [time, description]);
    const spl = (location: string) => ({ date: '2026-07-08T05:12:00Z', status: 'Your Shipment Is On Its Way To Destination', carrier: 1, location });
    const departed = [
      { date: '2026-07-08T05:12:00Z', status: 'Departed country of origin', carrier: 0, location: 'SYDNEY EMS, Australia' },
      { date: '2026-07-08T05:12:00+00:00', status: 'Departed from export office', carrier: 2, location: 'Sydney' },
    ];
    // Sydney keeps +10:00 in July, Riyadh +03:00.
    for (const timezone of [null, 'Asia/Riyadh']) {
      expect(times([spl('SYDNEY'), ...departed], timezone)?.map(([time]) => time)).toEqual(Array(3).fill('2026-07-07T19:12:00.000Z'));
    }
    // With no copy at its place, its home clock stays the guess; a location abroad rules it out.
    expect(times([spl('SYDNEY')])).toEqual([['2026-07-08T02:12:00.000Z', 'Your Shipment Is On Its Way To Destination']]);
    expect(times([spl('MELBOURNE'), ...departed])?.[0]).toEqual(['2026-07-08T02:12:00.000Z', 'Your Shipment Is On Its Way To Destination']);
    expect(times([spl('Example Town, Japan')])?.[0]?.[0]).toBe('2026-07-07T20:12:00.000Z');
    expect(times([{ ...spl('RIYADH'), date: '2026-07-14T09:10:00Z', status: 'Delivered' }])?.[0]?.[0]).toBe('2026-07-14T06:10:00.000Z');
    // Copies at its place on different clocks give none.
    expect(parseParcelsAppResponse({ carriers: ['SPL', 'Example Post', 'Other Post'], states: [
      { date: '2026-07-08T05:12:00Z', status: 'In transit', carrier: 0, location: 'Example Hub' },
      { date: '2026-07-08T05:12:00Z', status: 'Dispatched', carrier: 1, location: 'Example Hub, Switzerland' },
      { date: '2026-07-08T05:12:00Z', status: 'Dispatched', carrier: 2, location: 'Example Hub, United Kingdom' },
    ] }, number, identity()).events?.map(({ time }) => time)).toEqual([
      '2026-07-08T04:12:00.000Z', '2026-07-08T03:12:00.000Z', '2026-07-08T02:12:00.000Z',
    ]);
  });

  it('reads BRT\'s scans on Rome\'s clock and keeps the day of its untimed delivery round', () => {
    // Live shape: ParcelsApp writes the wall clocks of BRT's own page under a UTC label,
    // and its "FOR DELIVERY", which BRT dates without a time, at 00:00.
    const read = (states: Record<string, unknown>[], carriers = ['BRT Bartolini (Parcel ID)'], timezone: string | null = null) =>
      parseParcelsAppResponse({ carriers, states }, number, identity(), timezone).events
        ?.map(({ time, local_time, stage }) => ({ time, local_time, stage }));
    const scan = (date: string, status: string, location = 'EXAMPLE DEPOT (990)') => ({ date, status, carrier: 0, location });
    expect(read([
      scan('2026-10-16T15:19:00Z', 'Delivered'),
      scan('2026-10-16T07:17:00Z', 'ARRIVED AT DEPOT'),
      scan('2026-10-16T00:00:00Z', 'FOR DELIVERY'),
      scan('2026-10-15T21:00:00Z', 'DEPARTED', 'EXAMPLE ORIGIN (991)'),
    ])).toEqual([
      // The round has no time, but it follows the morning's arrival at the depot.
      { time: '2026-10-16T13:19:00.000Z', local_time: undefined, stage: 'delivered' },
      { time: undefined, local_time: '2026-10-16', stage: 'out_for_delivery' },
      { time: '2026-10-16T05:17:00.000Z', local_time: undefined, stage: 'in_transit' },
      { time: '2026-10-15T19:00:00.000Z', local_time: undefined, stage: 'in_transit' },
    ]);
    // Whatever zone routing passes, and in winter on +01:00.
    expect(read([scan('2026-10-15T21:00:00Z', 'DEPARTED')], ['BRT Bartolini'], 'UTC')?.[0]?.time).toBe('2026-10-15T19:00:00.000Z');
    expect(read([scan('2026-01-13T21:00:00Z', 'DEPARTED')], ['BRT Bartolini (DPD)'])?.[0]?.time).toBe('2026-01-13T20:00:00.000Z');
    // A location in another country takes that country's clock, and another step at 00:00 keeps its instant.
    expect(read([scan('2026-10-15T21:00:00Z', 'DEPARTED', 'Example Town, United Kingdom')])?.[0]?.time).toBe('2026-10-15T20:00:00.000Z');
    expect(read([scan('2026-10-16T00:00:00Z', 'DEPARTED')])?.[0]).toMatchObject({ time: '2026-10-15T22:00:00.000Z', local_time: undefined });
    // The rendered page gives the same day.
    const page = parseParcelsAppHtml(rendered(carrierRow('16 Oct 2026', '00:00', 'FOR DELIVERY', 'BRT Bartolini (Parcel ID)')), number);
    expect(page.events?.[0]).toMatchObject({ local_time: '2026-10-16' });
    expect(page.events?.[0]?.time).toBeUndefined();
  });

  it('leaves out an untimed step a timed scan shows at the same stage that day', () => {
    // Live shape: BRT hands a parcel to DPD Germany, whose round ParcelsApp has at its minute.
    const states = [
      { date: '2026-10-21T06:30:01Z', status: 'Parcel out for delivery', carrier: 1 },
      { date: '2026-10-21T00:00:00Z', status: 'FOR DELIVERY', carrier: 0, location: 'EXAMPLE DEPOT (990)' },
      { date: '2026-10-20T13:20:56Z', status: 'In transit', carrier: 1 },
    ];
    const read = (list: Record<string, unknown>[]) => parseParcelsAppResponse({ carriers: ['BRT Bartolini', 'DPD Germany'], states: list }, number, identity())
      .events?.map(({ description }) => description);
    expect(read(states)).toEqual(['Parcel out for delivery', 'In transit']);
    // Without that scan, or with one on another day, the step keeps its day.
    expect(read(states.slice(1))).toEqual(['FOR DELIVERY', 'In transit']);
    expect(read([{ ...states[0]!, date: '2026-10-22T06:30:01Z' }, ...states.slice(1)])).toEqual(['Parcel out for delivery', 'FOR DELIVERY', 'In transit']);
  });

  it('leaves out a bare delivery a later scan moves the parcel past', () => {
    // Live shapes: a first carrier's "Delivered" on its hand-over to the next, and an
    // airline's delivery to the line carrier, days before the destination's scans.
    const read = (states: Record<string, unknown>[]) => parseParcelsAppResponse({ carriers: ['Example Line', 'Example Post'], states }, number, identity());
    const handOver = read([
      { date: '2026-10-13T23:00:03Z', status: 'Out for delivery', carrier: 1 },
      { date: '2026-10-08T23:00:01Z', status: 'Delivered', carrier: 0 },
      { date: '2026-10-07T10:00:00Z', status: 'In transit', carrier: 0 },
    ]);
    expect(handOver.events?.map(({ description }) => description)).toEqual(['Out for delivery', 'In transit']);
    expect(read([
      { date: '2026-10-12T01:54:00Z', status: 'Destination customs. Received at Destination Customs', carrier: 1 },
      { date: '2026-10-10T04:45:00Z', status: 'Delivered', carrier: 0 },
    ]).events?.map(({ description }) => description)).toEqual(['Destination customs. Received at Destination Customs']);
    // A delivery stays when nothing moves the parcel later, or only within the day its clocks can differ by.
    for (const later of [[], [{ date: '2026-10-09T10:00:00Z', status: 'Out for delivery', carrier: 1 }],
      [{ date: '2026-10-12T10:00:00Z', status: 'Return to sender', carrier: 1 }]]) {
      expect(read([...later, { date: '2026-10-08T23:00:01Z', status: 'Delivered', carrier: 0 }]).events?.some(({ stage }) => stage === 'delivered')).toBe(true);
    }
  });

  it('reads a DPD Group scan on the clock its labelling network shares with the destination', () => {
    // Live shape: a line carrier's parcel from China that DPD Switzerland delivers. ParcelsApp
    // names DPD's number next, and DPD Switzerland's own tracker dates the scan "+02:00".
    const swiss = '06080000000002';
    const scan = (reply: Record<string, unknown>, trackingNumber = number, timezone: string | null = null) => parseParcelsAppResponse({
      carriers: ['Example Line', 'DPD Group'], originCode: 'CN', destinationCode: 'CH', next_tracking_ids: [swiss],
      states: [{ date: '2026-07-02T10:37:00+00:00', status: 'Parcel handed', carrier: 1 }], ...reply,
    }, trackingNumber, identity(trackingNumber), timezone).events?.[0];
    const time = (...args: Parameters<typeof scan>) => scan(...args)?.time;
    const wall = (...args: Parameters<typeof scan>) => [scan(...args)?.time, scan(...args)?.local_time];
    expect(time({})).toBe('2026-07-02T08:37:00.000Z');
    expect(time({}, number, 'Europe/London')).toBe('2026-07-02T08:37:00.000Z');
    // The number asked can be DPD's own.
    expect(time({ next_tracking_ids: undefined }, swiss)).toBe('2026-07-02T08:37:00.000Z');
    // Without a network's number, the zone is not known: routing's zone, or the wall clock, stays.
    expect(wall({ next_tracking_ids: undefined })).toEqual([undefined, '2026-07-02T10:37:00.000']);
    expect(wall({ next_tracking_ids: ['06460000000002'] })).toEqual([undefined, '2026-07-02T10:37:00.000']);
    expect(time({ next_tracking_ids: undefined }, number, 'Europe/Zurich')).toBe('2026-07-02T08:37:00.000Z');
    // Nor is it when the destination, or an origin with a DPD network, keeps another clock, or none is named.
    for (const reply of [{ destinationCode: 'GB' }, { originCode: 'GB' }, { destinationCode: 'US' }, { destinationCode: undefined }]) {
      expect(wall(reply)).toEqual([undefined, '2026-07-02T10:37:00.000']);
    }
    // An origin without a DPD network, or one on the same clock, leaves it.
    expect(time({ originCode: 'DE' })).toBe('2026-07-02T08:37:00.000Z');
    // A scan with a location is read there.
    expect(time({ states: [{ date: '2026-07-02T10:37:00+00:00', status: 'Parcel handed', carrier: 1, location: 'Example Hub, United Kingdom' }] }))
      .toBe('2026-07-02T09:37:00.000Z');
  });

  it('names the carrier of the newest scan as the partner when its own rule claims a number ParcelsApp names next', () => {
    // Live shape: a forwarder's sea freight that DPD Poland carries on abroad, with DPD Poland's waybill next.
    const waybill = '1000000000017U';
    const read = (reply: Record<string, unknown>) => parseParcelsAppResponse({
      carriers: ['Example Line', 'DPD Poland', 'DPD Group'], originCode: 'CN', destinationCode: 'ES', next_tracking_ids: [waybill],
      states: [
        { date: '2030-01-12T06:34:09Z', status: 'Parcel out for delivery', carrier: 2 },
        { date: '2030-01-12T06:34:09Z', status: 'Release for delivery abroad', carrier: 1 },
        { date: '2030-01-08T09:06:29Z', status: 'Receipt of the package at the DPD branch', carrier: 1 },
        { date: '2030-01-02T02:15:35Z', status: 'Goods received', carrier: 0 },
      ], ...reply,
    }, number, identity());
    const partner = (reply: Record<string, unknown>) => {
      const { delivery_carrier, delivery_tracking_number } = read(reply);
      return [delivery_carrier, delivery_tracking_number];
    };
    expect(partner({})).toEqual(['dpd-pl', waybill]);
    // The number asked, a number no rule of the newest scan's carrier claims, or none, names no partner.
    for (const next of [[number], ['1Z0000000000000000'], ['ZZ1'], undefined]) expect(partner({ next_tracking_ids: next })).toEqual([undefined, undefined]);
    // Nor does a partner with no scan yet, or one whose scans another carrier's follow.
    expect(partner({ states: [{ date: '2030-01-02T02:15:35Z', status: 'Goods received', carrier: 0 }] })).toEqual([undefined, undefined]);
    expect(partner({ states: [{ date: '2030-01-13T08:00:00Z', status: 'Goods received', carrier: 0 },
      { date: '2030-01-12T06:34:09Z', status: 'Release for delivery abroad', carrier: 1 }] })).toEqual([undefined, undefined]);
    // Two numbers its rules claim leave the partner unnamed.
    expect(partner({ next_tracking_ids: [waybill, '1000000000025U'] })).toEqual([undefined, undefined]);
  });

  it('reads a scan on its known clock before the zone routing passes for the parcel', () => {
    // Filed under Speedaf, the parcel gets Lagos from routing; Cainiao's own feed dates
    // these scans on China time and on the destination's.
    const result = parseParcelsAppResponse({ carriers: ['Cainiao'], destinationCode: 'RE', states: [
      { date: '2026-10-14T12:19:55Z', status: 'Leaving customs', carrier: 0 },
      { date: '2026-10-08T17:45:58Z', status: 'Order received successfully', carrier: 0 },
    ] }, number, identity(), 'Africa/Lagos');
    expect(result.events?.map((scan) => scan.time)).toEqual(['2026-10-14T08:19:55.000Z', '2026-10-08T09:45:58.000Z']);
  });

  it('holds back a scan with no place that only a guess dates, until a read catches up with it', () => {
    // On EcoScooting's catalog clock, UTC, a step on China's wall clock comes out hours after the read.
    const payload = { carriers: ['Example Forwarder', 'DPD'], states: [
      { date: '2030-01-02T13:24:16Z', status: 'Order closed' },
      { date: '2030-01-02T13:10:00Z', status: 'Order closed', carrier: 0 },
      { date: '2030-01-02T09:00:00Z', status: 'Delivered', carrier: 1, location: 'Example City, Germany' },
      { date: '2030-01-02T06:30:00Z', status: 'Order registered' },
      { date: '2030-01-02T03:39:08Z', status: 'Order received' },
    ] };
    const read = (at: string) => parseParcelsAppResponse(payload, number, identity(), 'UTC', Date.parse(at)).events?.map((scan) => [scan.description, scan.time]);
    // Its carrier's clock or its place dates the German scan, which keeps its time; under an hour ahead is kept too.
    expect(read('2030-01-02T05:47:58Z')).toEqual([
      ['Delivered', '2030-01-02T08:00:00.000Z'],
      ['Order registered', '2030-01-02T06:30:00.000Z'],
      ['Order received', '2030-01-02T03:39:08.000Z'],
    ]);
    expect(read('2030-01-02T12:30:00Z')?.slice(0, 2)).toEqual([
      ['Order closed', '2030-01-02T13:24:16.000Z'],
      ['Order closed', '2030-01-02T13:10:00.000Z'],
    ]);
    // The rendered page holds it back too.
    const html = rendered(row('02 Jan 2030', '13:24', 'Order closed') + row('02 Jan 2030', '03:39', 'Order received'));
    expect(parseParcelsAppHtml(html, number, 'UTC', Date.parse('2030-01-02T05:47:58Z')).events?.map((scan) => scan.description)).toEqual(['Order received']);
    expect(parseParcelsAppHtml(html, number, 'UTC', Date.parse('2030-01-02T12:30:00Z')).events).toHaveLength(2);
  });

  it('reads Cainiao\'s cancellation of the order on China time, as its order', () => {
    // Filed under EcoScooting, whose catalog clock is UTC: read as labeled, the cancellation
    // came hours after the check that first returned it.
    const result = parseParcelsAppResponse({ carriers: ['Cainiao', 'CACESA Logistics'], destinationCode: 'PT', states: [
      { date: '2030-01-02T13:24:16Z', status: 'Order has been cancelled', carrier: 0 },
      { date: '2030-01-02T11:39:08Z', status: 'Order received successfully', carrier: 0 },
    ] }, number, identity(), 'UTC');
    expect(result.events?.map((scan) => [scan.description, scan.time])).toEqual([
      ['Order has been cancelled', '2030-01-02T05:24:16.000Z'],
      ['Order received successfully', '2030-01-02T03:39:08.000Z'],
    ]);
  });

  it('keeps the UTC instants ParcelsApp gives Asendia USA scans wherever they happened', () => {
    // Live shape (2026-09-30): an Asendia USA return through Switzerland, filed
    // under Swiss Post. Asendia's A1 feed has the same instants, and Swiss
    // Post's own scan (its local clock shifted into "+02:00") agrees.
    const result = parseParcelsAppResponse({
      carriers: ['Swiss Post', 'Asendia United States', 'Asendia USA'],
      states: [
        { date: '2026-05-06T19:40:30+02:00', status: 'Arrival in destination country', carrier: 0, location: 'Example Centre, Switzerland, 100000' },
        { date: '2026-05-06T15:40:00Z', status: 'Arrived at destination', carrier: 1, location: 'EXAMPLE CITY, Switzerland' },
        { date: '2026-04-21T06:10:00Z', status: 'Out for delivery', carrier: 1, location: 'Germany' },
        { date: '2026-04-20T09:30:00Z', status: 'Arrived at destination', carrier: 2, location: 'EXAMPLE CITY, Germany' },
        { date: '2026-04-10T14:05:12Z', status: 'Shipment Information Received', carrier: 1 },
      ],
    }, number, identity(), 'Europe/Zurich');
    expect(result.events?.map((scan) => scan.time)).toEqual([
      '2026-05-06T15:40:30.000Z', // Swiss Post: 17:40:30 in Zurich
      '2026-05-06T15:40:00.000Z',
      '2026-04-21T06:10:00.000Z',
      '2026-04-20T09:30:00.000Z',
      '2026-04-10T14:05:12.000Z',
    ]);
  });

  it('keeps the instants of scans whose carrier resolved before brand and country names did', () => {
    // A Chronopost + DHL Parcel Netherlands handoff: the DHL scans carry no
    // location and were read in the parcel carrier's zone (Berlin). Their name
    // now reads them in Amsterdam, which keeps the same clock, so stored rows
    // keep their identity.
    const result = parseParcelsAppResponse({
      carriers: ['Chronopost France', 'DHL Parcel Netherlands'],
      states: [
        { date: '2026-07-03T11:42:00+00:00', status: 'Delivered', carrier: 0, location: 'EXAMPLE-VILLE' },
        { date: '2026-07-02T19:05:00+00:00', status: 'Handed over to the delivery partner', carrier: 1 },
        { date: '2026-03-29T01:30:00+00:00', status: 'Sorted at the parcel centre', carrier: 1 },
        { date: '2026-01-14T07:20:00+00:00', status: 'Received by the carrier', carrier: 1 },
      ],
    }, number, identity(), 'Europe/Berlin');
    expect(result.events?.map((scan) => scan.time)).toEqual([
      '2026-07-03T09:42:00.000Z',
      '2026-07-02T17:05:00.000Z',
      '2026-03-29T00:30:00.000Z',
      '2026-01-14T06:20:00.000Z',
    ]);
  });

  it('preserves the same unresolved brand clocks in rendered and JSON scans', () => {
    const swiss = '06080000000002';
    const page = identity(swiss).replace('</table>', `</table><ul class="events">${
      carrierRow('02 Jul 2026', '10:37', 'Delivered', 'DPD Group')}${carrierRow('14 Jan 2026', '09:15', 'Parcel handed', 'DPD Group')}</ul>`);
    const rendered = parseParcelsAppHtml(page, swiss);
    const json = parseParcelsAppResponse({ carriers: ['DPD Group'], states: [
      { date: '2026-07-02T10:37:00+00:00', status: 'Delivered', carrier: 0 },
      { date: '2026-01-14T09:15:00+00:00', status: 'Parcel handed', carrier: 0 },
    ] }, swiss, identity(swiss));
    expect(rendered.events?.map((scan) => scan.time ?? scan.local_time)).toEqual(['2026-07-02T10:37:00.000', '2026-01-14T09:15:00.000']);
    expect(rendered.events?.map((scan) => [scan.time, scan.local_time])).toEqual(json.events?.map((scan) => [scan.time, scan.local_time]));
    expect(rendered).toMatchObject({ reported_carriers: ['DPD Group'], discovered_carrier: 'dpd' });
  });

  it('parses rendered history without parsing the surrounding marketing copy', () => {
    const html = rendered(row('18 Aug 2026', '03:04', 'Electronic information submitted by shipper'));
    expect(parseParcelsAppHtml(html + '<p>Delivered 2026-09-01</p>', number, 'Europe/Zurich'))
      .toMatchObject({ current_stage: 'registered', last_update: '2026-08-18T01:04:00.000Z' });
  });

  it('skips notice rows that render a date without a time', () => {
    // Observed live on 2026-09-11 for a not-yet-scanned Colissimo label.
    const notice = row('11 Sep 2026', '', "No information about your package. We've checked all relevant couriers for «Suisse». If the country is not correct, please select the destination country below.");
    const scan = row('10 Sep 2026', '08:30', 'Electronic information submitted by shipper');
    expect(parseParcelsAppHtml(rendered(notice + scan), number, 'Europe/Zurich'))
      .toMatchObject({ current_stage: 'registered', last_update: '2026-09-10T06:30:00.000Z' });
    expect(() => parseParcelsAppHtml(rendered(notice), number)).toThrow('No usable tracking events');
    expect(() => parseParcelsAppHtml(rendered(row('today', '08:30', 'Electronic information submitted by shipper')), number)).toThrow('invalid event date');
  });
});

describe('ParcelsApp browser capture', () => {
  it('asks the browser service for the page and reads its captured API response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(announced));
    await expect(tracker(fetcher, 'http://browser.test/v1').fetch(number)).resolves.toMatchObject({ tracking_provider: 'ParcelsApp', current_stage: 'registered' });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://browser.test/scrape');
    expect(JSON.parse(String(options!.body))).toMatchObject({
      url: `https://parcelsapp.com/en/tracking/${number}`, skipHttp: true, maxTier: 3,
      captureResponses: [API], settleTimeout: 15_000,
    });
  });

  it('falls back to the rendered history when no API body was captured', async () => {
    const html = rendered(row('18 Aug 2026', '03:04', 'Electronic information submitted by shipper'));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(null, { html, capturedResponses: [] }));
    await expect(tracker(fetcher).fetch(number, undefined, null, 'Europe/Zurich'))
      .resolves.toMatchObject({ current_stage: 'registered', last_update: '2026-08-18T01:04:00.000Z' });
  });

  it("reads ParcelsApp's empty view, which leaves out the number, as no history", async () => {
    const empty = '<div class="tracking-info empty"><div class="parcel"></div></div>';
    for (const error of ['NO_DATA', 'NO_TRACKER']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured({ error, carriers: [] }, { html: empty }));
      await expect(tracker(fetcher).fetch(number)).rejects.toBeInstanceOf(NoHistoryError);
    }
    // Without the page's own answer the empty view is inconclusive, not drift.
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(null, { html: empty, capturedResponses: [] }));
    await expect(tracker(fetcher).fetch(number)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_missing' });
    // A page that is neither the empty view nor the shipment's stays a schema failure.
    fetcher.mockResolvedValue(captured({ error: 'NO_DATA' }, { html: '<div class="tracking-info"></div>' }));
    await expect(tracker(fetcher).fetch(number)).rejects.toThrow('identity missing');
  });

  it('rejects a page rendered for another shipment instead of reporting its history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(announced, { html: identity('OTHER123') }));
    await expect(tracker(fetcher).fetch(number)).rejects.toThrow('identity missing');
  });

  it('needs the browser service and never requests an arbitrary user URL', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ParcelsAppTracker({ httpClient: null }).fetch(number)).rejects.toThrow('tracking browser service');
    await expect(tracker(fetcher).fetch('http://localhost')).rejects.toThrow('Invalid tracking number');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('ParcelsApp direct lookup', () => {
  const reply = (data: unknown) => new Response(JSON.stringify(data));
  const prompt = { states: [{ date: '2026-01-01T00:00:00', status: 'Enter recipient details',
    require_fields: [{ name: 'zipcode', type: 'text' }] }] };

  it('retrieves history without a browser and sends the stored postcode only in the form body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(announced));
    const result = await new ParcelsAppTracker({ fetcher }).fetch(number, 10_000, ' 01234 ');
    expect(result).toMatchObject({ current_stage: 'registered', tracking_source: 'structured-web-response' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(API);
    expect(new URLSearchParams(String(init!.body)).get('extra[zipcode]')).toBe('01234');
    expect(JSON.stringify(result)).not.toContain('01234');
  });

  it('keeps interleaved numberless responses bound to their own requests', async () => {
    let finishFirst!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(reply({ states: [{ date: '2026-01-02T12:00:00Z', status: 'Delivered' }] }));
    const tracker = new ParcelsAppTracker({ fetcher });
    const first = tracker.fetch(number);
    const second = await tracker.fetch('ZZ98765432100');
    finishFirst(reply(announced));
    expect(second.current_stage).toBe('delivered');
    expect((await first).current_stage).toBe('registered');
    expect(String(fetcher.mock.calls[0]![1]!.body)).not.toBe(String(fetcher.mock.calls[1]![1]!.body));
  });

  it('reports a postcode gate without treating it as a scan or retrying in a browser', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(prompt));
    const tracker = new ParcelsAppTracker({ fetcher, trawl: new TrawlClient('http://browser.test', fetcher) });
    for (const postcode of [undefined, '99999']) {
      const error = await tracker.fetch(number, 10_000, postcode).catch((error: unknown) => error);
      expect(error).toMatchObject({ kind: 'input_required', field: 'postcode' });
      // The gate names no carrier.
      expect((error as InputRequiredError).carrier).toBeUndefined();
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('names the carrier a postcode gate is for, when every gate names one that maps', async () => {
    const gate = (carrier?: number) => ({ ...prompt.states[0], ...(carrier === undefined ? {} : { carrier }) });
    const gated = async (data: unknown) => new ParcelsAppTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(reply(data)) })
      .fetch(number).catch((error: unknown) => error);
    expect(await gated({ carriers: ['SEUR'], states: [gate(0)] }))
      .toMatchObject({ name: 'InputRequiredError', kind: 'input_required', field: 'postcode', carrier: 'seur' });
    expect(await gated({ carriers: ['bpost', 'bpost'], states: [gate(0), gate(1)] })).toMatchObject({ field: 'postcode', carrier: 'bpost' });
    for (const data of [
      { carriers: ['Example Courier'], states: [gate(0)] },
      { carriers: ['SEUR', 'bpost'], states: [gate(0), gate(1)] },
      { carriers: ['SEUR'], states: [gate(0), gate()] },
      { carriers: ['SEUR'], states: [gate(3)] },
    ]) {
      const error = await gated(data);
      expect(error).toMatchObject({ kind: 'input_required', field: 'postcode' });
      expect((error as InputRequiredError).carrier).toBeUndefined();
    }
  });

  it('returns the dated history of a reply with an undated state, without a browser retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(undatedLeg));
    await expect(new ParcelsAppTracker({ fetcher, trawl: new TrawlClient('http://browser.test', fetcher) }).fetch(number))
      .resolves.toMatchObject({ tracking_source: 'structured-web-response', undated_event_count: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('retains actual scans alongside a postcode gate', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ states: [...prompt.states, ...announced.states] }));
    const result = await new ParcelsAppTracker({ fetcher }).fetch(number);
    expect(result.events).toHaveLength(1);
    expect(result.current_stage).toBe('registered');
  });

  it('records challenge recovery and retains the browser identity check', async () => {
    const steps: StepRecord[] = [];
    const lookups: LookupRecord[] = [];
    const recorder: StepRecorder = { step: (record) => { steps.push(record); }, lookup: (record) => { lookups.push(record); } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply({ error: 'RELOAD' })).mockResolvedValueOnce(captured(announced));
    const result = await new ParcelsAppTracker({ fetcher, recorder, trawl: new TrawlClient('http://browser.test', fetcher) }).fetch(number);
    expect(result.current_stage).toBe('registered');
    expect(steps).toMatchObject([{ step: 'direct', outcome: 'challenge' }, { step: 'trawl', outcome: 'ok', fallbackFrom: 'direct' }]);
    expect(lookups).toMatchObject([{ finalStep: 'trawl', attempts: 2, outcome: 'ok' }]);

    fetcher.mockResolvedValueOnce(reply({ error: 'RELOAD' })).mockResolvedValueOnce(captured(announced, { html: identity('OTHER123') }));
    await expect(new ParcelsAppTracker({ fetcher, trawl: new TrawlClient('http://browser.test', fetcher) }).fetch(number)).rejects.toThrow('identity missing');
  });

  it('reads a direct reply past the size cap through the browser, which accepts a larger one', async () => {
    const steps: StepRecord[] = [];
    const recorder: StepRecorder = { step: (record) => { steps.push(record); }, lookup: () => {} };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('x', { headers: { 'content-length': '3000000' } }))
      .mockResolvedValueOnce(captured(announced));
    const result = await new ParcelsAppTracker({ fetcher, recorder, trawl: new TrawlClient('http://browser.test', fetcher) }).fetch(number);
    expect(result.current_stage).toBe('registered');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(steps).toMatchObject([
      { step: 'direct', outcome: 'indeterminate' },
      { step: 'trawl', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'indeterminate' },
    ]);
  });

  it('names an error code it does not know in the schema failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ error: 'SOMETHING_NEW' }));
    await expect(new ParcelsAppTracker({ fetcher }).fetch(number)).rejects.toThrow('ParcelsApp lookup unavailable: SOMETHING_NEW');
    fetcher.mockResolvedValue(reply({ error: '<b>no</b>' }));
    await expect(new ParcelsAppTracker({ fetcher }).fetch(number)).rejects.toThrow(/^ParcelsApp lookup unavailable$/);
  });

  it('starts no browser lookup for a reply within the cap that carries no usable scan', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ states: [{ date: '2026-01-01T00:00:00Z', status: 'Tracking number not found' }] }));
    await expect(new ParcelsAppTracker({ fetcher, trawl: new TrawlClient('http://browser.test', fetcher) }).fetch(number))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'No usable tracking events' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([429, 500, 503])('does not amplify HTTP %i with a browser retry', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status, headers: { 'Retry-After': '120' } }));
    await expect(new ParcelsAppTracker({ fetcher, trawl: new TrawlClient('http://browser.test', fetcher) }).fetch(number))
      .rejects.toMatchObject({ status, retryAfterMs: 120_000 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['DOWN', 'BUSY', 'PARSER', 'CAPTCHA', 'MAINTENANCE'])('leaves a failed carrier lookup (%s) inconclusive without a browser retry', async (code) => {
    const steps: StepRecord[] = [];
    const recorder: StepRecorder = { step: (record) => { steps.push(record); }, lookup: () => {} };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({
      error: code, carriers: ['Example Courier'], services: [{ name: 'Example Courier', slug: 'example-courier' }],
    }));
    const error = await new ParcelsAppTracker({ fetcher, recorder, trawl: new TrawlClient('http://browser.test', fetcher) })
      .fetch(number).catch((error: unknown) => error);
    expect(error).toMatchObject({ kind: 'indeterminate', reason: 'carrier_unavailable', message: `ParcelsApp's carrier lookup failed: ${code}` });
    expect(error).not.toBeInstanceOf(NoHistoryError);
    expect(steps).toMatchObject([{ step: 'direct', outcome: 'indeterminate' }]);
    expect(steps).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([{ error: 'NO_DATA' }, { error: 'NO_TRACKER' }, { states: [] }])('leaves no-history replies inconclusive without browser retries: %j', async (payload) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(payload));
    const error = await new ParcelsAppTracker({ fetcher, trawl: new TrawlClient('http://browser.test', fetcher) }).fetch(number).catch((error: unknown) => error);
    expect(carrierErrorKind(error)).toBe('indeterminate');
    expect(error).toBeInstanceOf(NoHistoryError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([{ correctId: 'OTHER123', ...announced }, { states: [{}] }, { states: [null] }, { states: Array(1001).fill({}) }, { uuid: 'unfinished' }])('rejects aliases, malformed and intermediate replies', async (payload) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(payload));
    await expect(new ParcelsAppTracker({ fetcher }).fetch(number)).rejects.toThrow();
  });

  it('starts no retry and no browser lookup once the caller cancels', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection reset'));
    const controller = new AbortController();
    const lookup = new ParcelsAppTracker({ fetcher, trawl: new TrawlClient('http://browser.test', fetcher) })
      .fetch(number, undefined, null, null, controller.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));
    // The interrupted request is the failure; the chain and the facade answer with the caller's reason.
    await expect(lookup).rejects.toMatchObject({ name: 'UpstreamNetworkError' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('ParcelsApp slow lookup recovery', () => {
  beforeEach(() => {
    fakeBudgetClock();
    // The ESM promise timer retains Node's clock in this Vitest environment.
    vi.spyOn(timers, 'setTimeout').mockImplementation(<T>(ms = 1, value?: T) =>
      new Promise<T>((resolve) => { setTimeout(() => resolve(value as T), ms); }));
  });
  afterEach(() => vi.restoreAllMocks());

  function timedFetch(replies: { afterMs: number; payload?: unknown; failure?: Error }[]) {
    let attempt = 0;
    return vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((resolve, reject) => {
      const reply = replies[attempt++]!;
      const signal = init!.signal!;
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        if (reply.failure) reject(reply.failure);
        else resolve(Response.json(reply.payload));
      }, reply.afterMs);
      signal.addEventListener('abort', abort, { once: true });
    }));
  }

  it('lets a cold lookup finish after the old ten-second cutoff without another request', async () => {
    const fetcher = timedFetch([{ afterMs: 12_000, payload: announced }]);
    const lookup = new ParcelsAppTracker({ fetcher }).fetch(number);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(lookup).resolves.toMatchObject({ current_stage: 'registered' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('retries a POST that failed on the network once after two seconds, preserving input and both attempt records', async () => {
    const steps: StepRecord[] = [], lookups: LookupRecord[] = [];
    const recorder: StepRecorder = { step: (r) => { steps.push(r); }, lookup: (r) => { lookups.push(r); } };
    const fetcher = timedFetch([{ afterMs: 100, failure: new TypeError('connection reset') }, { afterMs: 100, payload: announced }]);
    const tracker = new ParcelsAppTracker({ fetcher, recorder, trawl: new TrawlClient('http://browser.test', fetcher) });
    const lookup = tracker.fetch(number, undefined, ' 01234 ');
    await vi.advanceTimersByTimeAsync(2_099);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(101);
    await expect(lookup).resolves.toMatchObject({ tracking_source: 'structured-web-response', current_stage: 'registered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([API, API]);
    expect(String(fetcher.mock.calls[1]![1]!.body)).toBe(String(fetcher.mock.calls[0]![1]!.body));
    expect(new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body)).get('extra[zipcode]')).toBe('01234');
    expect(steps).toMatchObject([
      { step: 'direct', outcome: 'transport' }, { step: 'retry', outcome: 'ok', fallbackFrom: 'direct' },
    ]);
    expect(lookups).toMatchObject([{ finalStep: 'retry', attempts: 2, outcome: 'ok', durationMs: 2_200 }]);
  });

  it('fails a POST ParcelsApp holds to the cap without a retry or a browser lookup', async () => {
    const fetcher = timedFetch([{ afterMs: 40_000, payload: announced }, { afterMs: 100, payload: announced }]);
    const failure = expect(new ParcelsAppTracker({ fetcher, trawl: new TrawlClient('http://browser.test', fetcher) }).fetch(number))
      .rejects.toMatchObject({ kind: 'transport' });
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('stops after two network failures without starting the same lookup again in a browser', async () => {
    const fetcher = timedFetch([
      { afterMs: 10, failure: new TypeError('connection reset') },
      { afterMs: 10, failure: new TypeError('connection reset again') },
    ]);
    const failure = expect(new ParcelsAppTracker({ fetcher, trawl: new TrawlClient('http://browser.test', fetcher) }).fetch(number))
      .rejects.toMatchObject({ kind: 'transport' });
    await vi.advanceTimersByTimeAsync(2_020);
    await failure;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects an unverified alias returned by the retry', async () => {
    const fetcher = timedFetch([
      { afterMs: 10, failure: new TypeError('connection reset') },
      { afterMs: 10, payload: { ...announced, correctId: 'OTHER123' } },
    ]);
    const failure = expect(new ParcelsAppTracker({ fetcher }).fetch(number)).rejects.toThrow('unverified tracking alias');
    await vi.advanceTimersByTimeAsync(2_020);
    await failure;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry when a shorter caller deadline cannot accommodate the backoff', async () => {
    const fetcher = timedFetch([{ afterMs: 40_000, payload: announced }]);
    const failure = expect(new ParcelsAppTracker({ fetcher }).fetch(number, 31_000)).rejects.toMatchObject({ kind: 'transport' });
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('aborts the second request at the original deadline, including its backoff time', async () => {
    const fetcher = timedFetch([{ afterMs: 15_000, failure: new TypeError('connection reset') }, { afterMs: 40_000, payload: announced }]);
    const failure = expect(new ParcelsAppTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'transport' });
    await vi.advanceTimersByTimeAsync(45_000);
    await failure;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init!.signal!.aborted)).toBe(true);
  });
});
