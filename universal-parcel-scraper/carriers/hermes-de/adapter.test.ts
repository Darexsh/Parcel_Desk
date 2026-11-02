import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HermesGermanyTracker, parseHermesGermanyResponse } from './adapter.js';
import { sameInstantIdentityPolicy } from '../../app.js';
import { STATUSES } from './status.js';

const NUMBER = 'H1234567890123456789';

const fixture = (name: string): Array<Record<string, unknown>> => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
) as Array<Record<string, unknown>>;
const delivered = () => fixture('delivered-neighbour');
const outForDelivery = () => fixture('out-for-delivery');
const atShop = (code: string): Array<Record<string, unknown>> => [{
  barcode: NUMBER,
  address: { addressType: 'PARCELSHOP', lastName: 'Example Kiosk', street: 'Beispielweg 1', zipCode: '10115', city: 'Beispielstadt', parcelShopId: '1' },
  parcelProgress: [
    { parcelStatus: 'SORTED', timestamp: '2026-09-02T09:00:00Z' },
    { parcelStatus: code, timestamp: '2026-09-03T09:00:00Z', historyText: 'Synthetic wording' },
  ],
}];
// A parcel handed to a partner abroad, with the link the page shows for that partner.
const abroad = (link: unknown, newest = 'INTERNATIONAL_ARRIVED_IN_COUNTRY'): Array<Record<string, unknown>> => [{
  barcode: NUMBER,
  parcelAttributes: { national: false },
  viewParameters: { internationalTrackingLink: link },
  parcelProgress: [
    { parcelStatus: 'SORTED', timestamp: '2026-09-02T09:00:00Z' },
    { parcelStatus: newest, timestamp: '2026-09-04T09:00:00Z' },
  ],
}];
const capabilities = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

afterEach(() => vi.restoreAllMocks());

describe('Hermes Germany', () => {
  it('orders and deduplicates real milestones, keeping display text but dropping address PII', () => {
    const result = parseHermesGermanyResponse(delivered(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'registered']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE STREET');
    expect(JSON.stringify(result)).not.toContain('PRIVATE RECIPIENT');
    expect(result.events?.[0]?.description).toContain('Nachbarn');
    expect(result.last_update).toBe('2026-09-03T09:00:00.000Z');
  });

  it('covers every capability declared in carrier.json', () => {
    expect(capabilities).toEqual(['history', 'location', 'eta', 'sender_name', 'delivered_at', 'pickup_point', 'provider_code',
      'delivery_partner', 'delivery_tracking_number']);
    const result = parseHermesGermanyResponse(delivered(), NUMBER);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.provider_code)).toBe(true);
    expect(result.sender_name).toBe('Example Webshop GmbH');
    expect(result.delivered_at).toBe('2026-09-03T09:00:00.000Z');
    const active = parseHermesGermanyResponse(outForDelivery(), NUMBER);
    expect(active).toMatchObject({ status: 'out_for_delivery', expected_delivery: '2026-09-03' });
    expect(parseHermesGermanyResponse(atShop('PARCELSHOP_READY_FOR_COLLECTION'), NUMBER).pickup_point).toBeTruthy();
    expect(parseHermesGermanyResponse(abroad('https://tracking.postnord.com/en/?id=00370000000000000017'), NUMBER))
      .toMatchObject({ delivery_carrier: 'postnord', delivery_tracking_number: '00370000000000000017' });
  });

  it('places a row where its wording names the depot, the destination or the ParcelShop', () => {
    const at = (hour: number) => `2026-09-0${hour}T09:00:00Z`;
    const result = parseHermesGermanyResponse([{
      barcode: NUMBER,
      parcelProgress: [
        { parcelStatus: 'PARCELSHOP_DROP_OFF', timestamp: at(1),
          historyText: 'The Shipment was dropped off by the sender in the ParcelShop. Example Kiosk, Beispielweg 1, 12345 Musterhausen.' },
        { parcelStatus: 'TAKEN_OVER_BY_HERMES', timestamp: at(2),
          historyText: 'The shipment was taken over by Hermes in Beispieldorf (Musterstadt) and is prepared for further shipping.' },
        { parcelStatus: 'SORTED', timestamp: at(3), historyText: 'The shipment was prepared in Neu-Beispielburg for further shipping.' },
        { parcelStatus: 'ARRIVED_IN_DESTINATION_REGION', timestamp: at(4), historyText: 'The shipment has arrived in the destination region Musterstadt.' },
        { parcelStatus: 'INTERNATIONAL_ARRIVED_IN_COUNTRY', timestamp: at(5),
          historyText: 'The shipment has arrived in the destination country Spain and is prepared for the further shipping.' },
        { parcelStatus: 'INTERNATIONAL_SORTED', timestamp: at(6), historyText: 'The shipment was prepared for further shipping (Spain).' },
        { parcelStatus: 'PARCELSHOP_READY_FOR_COLLECTION', timestamp: at(7),
          historyText: 'The shipment is ready for pick up in the Hermes parcel shop Example Kiosk, Beispielweg 2, 54321 Bad Beispiel-Ost max. 7 working days.' },
        { parcelStatus: 'DELIVERY_TOUR_STARTED', timestamp: at(8), historyText: 'The shipment was loaded into the delivery vehicle and is expected to be delivered today.' },
        // A partner's depot is in the country it names.
        { parcelStatus: 'INTERNATIONAL_SORTED', timestamp: at(9), historyText: 'The shipment was prepared in EXEMPLEVILLE for further shipping (France).' },
      ],
    }], NUMBER);
    expect(result.events?.map((event) => event.location ?? null).reverse()).toEqual([
      'Musterhausen, Germany', 'Beispieldorf (Musterstadt), Germany', 'Neu-Beispielburg, Germany', 'Musterstadt, Germany',
      'Spain', 'Spain', 'Bad Beispiel-Ost, Germany', null, 'EXEMPLEVILLE, France',
    ]);
    const german = parseHermesGermanyResponse([{
      barcode: NUMBER,
      parcelProgress: [
        { parcelStatus: 'SORTED', timestamp: at(1), historyText: 'Die Sendung wurde in Beispielburg für den Weiterversand vorbereitet.' },
        { parcelStatus: 'PARCELSHOP_DROP_OFF', timestamp: at(2),
          historyText: 'Die Sendung wurde vom Absender im PaketShop Example Kiosk, Beispielweg 1, 12345 Musterhausen abgegeben.' },
        // Only a ParcelShop row's address is read.
        { parcelStatus: 'DELIVERED_NEIGHBOUR', timestamp: at(3), historyText: 'Zugestellt an Beispielweg 3, 12345 Musterhausen.' },
        { parcelStatus: 'TAKEN_OVER_BY_HERMES', timestamp: at(4),
          historyText: 'Die Sendung wurde von Hermes in Neu-Beispielburg übernommen und wird für den weiteren Versand vorbereitet.' },
        { parcelStatus: 'ARRIVED_IN_DESTINATION_REGION', timestamp: at(5), historyText: 'Die Sendung ist in der Zielregion Musterstadt angekommen.' },
        { parcelStatus: 'PARCELSHOP_COLLECTED_BY_CUSTOMER', timestamp: at(6),
          historyText: 'Die Sendung wurde im Hermes PaketShop Example Kiosk, Beispielweg 1, 12345 Bad Beispiel am See erfolgreich abgeholt.' },
        { parcelStatus: 'INTERNATIONAL_ARRIVED_IN_COUNTRY', timestamp: at(7),
          historyText: 'Die Sendung ist im Zielland Spanien angekommen und wird für den weiteren Versand vorbereitet.' },
        { parcelStatus: 'INTERNATIONAL_SORTED', timestamp: at(8), historyText: 'Die Sendung wurde in EXEMPLEVILLE für den Weiterversand vorbereitet (Frankreich).' },
      ],
    }], NUMBER);
    expect(german.events?.map((event) => event.location ?? null).reverse()).toEqual([
      'Beispielburg, Germany', 'Musterhausen, Germany', null, 'Neu-Beispielburg, Germany', 'Musterstadt, Germany',
      'Bad Beispiel am See, Germany', 'Spanien', 'EXEMPLEVILLE, Frankreich',
    ]);
  });

  it('ignores the pre-announcement preference booking', () => {
    const result = parseHermesGermanyResponse(outForDelivery(), NUMBER);
    expect(result.events?.map((event) => event.provider_code))
      .toEqual(['DELIVERY_TOUR_STARTED', 'HANDED_OVER', 'ANNOUNCED']);
  });

  it('keeps scans of one instant in the carrier\'s order', () => {
    const payload = [{ barcode: NUMBER, parcelProgress: [{ parcelStatus: 'SORTED', timestamp: '2026-09-02T09:00:00Z' },
      { parcelStatus: 'HANDED_OVER', timestamp: '2026-09-03T07:00:00Z' }, { parcelStatus: 'DELIVERY_TOUR_STARTED', timestamp: '2026-09-03T07:00:00Z' }] }];
    expect(parseHermesGermanyResponse(payload, NUMBER).events?.map((event) => event.provider_code))
      .toEqual(['DELIVERY_TOUR_STARTED', 'HANDED_OVER', 'SORTED']);
  });

  it.each([
    ['ATG_OUT_OF_WAREHOUSE', 'registered'],
    ['PARCELSHOP_DROP_OFF', 'accepted'],
    ['RETURN_TO_SENDER', 'returned'],
    ['RETURN_DELIVERED_TO_SENDER', 'returned'],
    ['RETOURE_DELIVERED', 'returned'],
    ['DELIVERY_FAILED', 'failed_attempt'],
    ['READY_FOR_PICKUP', 'ready_for_pickup'],
  ])('does not confuse %s with delivery', (code, stage) => {
    expect(STATUSES[code]?.stage).toBe(stage);
    const payload = [{ barcode: NUMBER, parcelProgress: [{ parcelStatus: code, timestamp: '2026-09-03T09:00:00Z' }] }];
    expect(parseHermesGermanyResponse(payload, NUMBER).current_stage).toBe(stage);
  });

  it('rejects missing, ambiguous, mismatched and malformed histories', () => {
    expect(() => parseHermesGermanyResponse({}, NUMBER)).toThrow('invalid tracking response');
    expect(() => parseHermesGermanyResponse([], NUMBER)).toThrow('could not locate');
    expect(() => parseHermesGermanyResponse(delivered(), 'H9999999999999999999')).toThrow('different');
    expect(() => parseHermesGermanyResponse([...delivered(), ...delivered()], NUMBER)).toThrow('ambiguous');
    for (const parcelProgress of [[], [null], [{ parcelStatus: 'ANNOUNCED', timestamp: 'nonsense' }]]) {
      expect(() => parseHermesGermanyResponse([{ barcode: NUMBER, parcelProgress }], NUMBER)).toThrow();
    }
    expect(parseHermesGermanyResponse([{ barcode: NUMBER, parcelProgress: [
      { parcelStatus: 'FUTURE_STATUS', timestamp: '2026-09-03T09:00:00Z' },
    ] }], NUMBER)).toMatchObject({ status: 'unknown' });
  });

  it('answers a reference with the one parcel the search resolves it to, under that parcel\'s barcode', () => {
    // A synthetic reference failing the barcode check digit, and a synthetic barcode passing it.
    const reference = '60000000000001';
    const barcode = '01234567890128';
    const payload = () => [{ barcode, parcelProgress: [
      { parcelStatus: 'PARCELSHOP_DROP_OFF', timestamp: '2026-09-02T09:00:00Z' },
      { parcelStatus: 'PARCELSHOP_COLLECTED_BY_DRIVER', timestamp: '2026-09-02T15:00:00Z' },
    ] }];
    expect(parseHermesGermanyResponse(payload(), reference, { references: true })).toMatchObject({
      current_stage: 'accepted', canonical_tracking_number: barcode,
    });
    // Recognition asks for the barcode itself, a barcode asked must be the one answering, and two parcels are ambiguous.
    expect(() => parseHermesGermanyResponse(payload(), reference)).toThrow('different');
    expect(() => parseHermesGermanyResponse(payload(), '01234567890135', { references: true })).toThrow('different');
    expect(() => parseHermesGermanyResponse([...payload(), ...payload()], reference, { references: true })).toThrow('ambiguous');
    expect(parseHermesGermanyResponse(payload(), barcode).canonical_tracking_number).toBeUndefined();
  });

  it('answers a barcode asked with a leading zero too many under the barcode itself', () => {
    const barcode = '01234567890128';
    const payload = () => [{ barcode, parcelProgress: [{ parcelStatus: 'PARCELSHOP_DROP_OFF', timestamp: '2026-09-02T09:00:00Z' }] }];
    expect(parseHermesGermanyResponse(payload(), `0${barcode}`, { references: true })).toMatchObject({
      current_stage: 'accepted', canonical_tracking_number: barcode,
    });
    // Recognition takes it too, as the parcel's own number; another first digit, or a barcode failing its check, is another number.
    expect(parseHermesGermanyResponse(payload(), `0${barcode}`)).toMatchObject({ canonical_tracking_number: barcode });
    expect(() => parseHermesGermanyResponse(payload(), `1${barcode}`, { references: true })).toThrow('different');
    const unchecked = '01234567890129';
    expect(() => parseHermesGermanyResponse([{ ...payload()[0]!, barcode: unchecked }], `0${unchecked}`, { references: true }))
      .toThrow('different');
  });

  it('exposes sender and keeps unknown latest as unknown, not an error', () => {
    const result = parseHermesGermanyResponse(delivered(), NUMBER);
    expect(result).toMatchObject({ sender_name: 'Example Webshop GmbH', delivered_at: '2026-09-03T09:00:00.000Z' });
    const unknown = parseHermesGermanyResponse([{ barcode: NUMBER, parcelProgress: [
      { parcelStatus: 'FUTURE_STATUS', timestamp: '2026-09-03T09:00:00Z' },
    ] }], NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown' });
  });

  it('only requests the public history and never the address endpoint', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(delivered())));
    await expect(new HermesGermanyTracker().fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(`https://api.my-deliveries.de/tnt/v2/shipments/search/${NUMBER}`,
      expect.objectContaining({ cache: 'no-store', redirect: 'error', headers: expect.objectContaining({ 'X-Language': 'en' }) }));
  });

  it('asks for German for a German reader and English for anyone else', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(delivered())));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    for (const [language, asked] of [['de', 'de'], ['de-AT', 'de'], ['fr', 'en'], [null, 'en']] as const) {
      await instance.track({ number: NUMBER, language });
      const headers = fetcher.mock.calls.at(-1)?.[1]?.headers as Record<string, string>;
      expect(headers['X-Language']).toBe(asked);
    }
  });

  it('reads a delivery at the address as a delivery', () => {
    const payload = delivered();
    payload[0]!.parcelProgress = (payload[0]!.parcelProgress as Array<Record<string, unknown>>).map((entry) => entry.parcelStatus === 'DELIVERED_NEIGHBOUR'
      ? { ...entry, parcelStatus: 'DELIVERED_INHOUSE', historyText: 'Die Sendung wurde an der Empfangsadresse zugestellt.' } : entry);
    payload[0]!.parcelAttributes = { ...(payload[0]!.parcelAttributes as object), delivered: false };
    const result = parseHermesGermanyResponse(payload, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', provider_code: 'DELIVERED_INHOUSE' });
  });

  it('reads a parcel abroad its recipient did not collect as going back, whatever the delivered flag says', () => {
    const rows = [
      { parcelStatus: 'INTERNATIONAL_SORTED', timestamp: '2026-09-02T09:00:00Z' },
      { parcelStatus: 'INTERNATIONAL_PUDO_READY_FOR_COLLECTION', timestamp: '2026-09-02T13:00:00Z' },
      { parcelStatus: 'INTERNATIONAL_PUDO_NOT_COLLECTED', timestamp: '2026-09-10T15:00:00Z' },
      { parcelStatus: 'INTERNATIONAL_UNDELIVERABLE', timestamp: '2026-09-10T15:00:01Z' },
      { parcelStatus: 'INTERNATIONAL_SORTED', timestamp: '2026-09-12T21:00:00Z' },
      { parcelStatus: 'INTERNATIONAL_DELIVERED', timestamp: '2026-09-13T22:00:00Z', historyText: 'The shipment was successfully delivered.' },
    ];
    const reply = (progress: Array<Record<string, unknown>>) =>
      [{ barcode: NUMBER, parcelAttributes: { delivered: true }, parcelProgress: progress }];
    const handedBack = parseHermesGermanyResponse(reply(rows), NUMBER);
    expect(handedBack).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(handedBack).not.toHaveProperty('delivered_at');
    expect(handedBack.events?.[0]).toMatchObject({ stage: 'returned', provider_code: 'INTERNATIONAL_DELIVERED' });
    const home = parseHermesGermanyResponse(reply([
      ...rows,
      { parcelStatus: 'SORTED', timestamp: '2026-09-15T08:00:00Z' },
      { parcelStatus: 'RETURN_DELIVERED_TO_SENDER', timestamp: '2026-09-18T09:00:00Z' },
    ]), NUMBER);
    expect(home).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(home).not.toHaveProperty('delivered_at');
    // A delivery abroad before any parcel-shop miss stays a delivery.
    const delivered = parseHermesGermanyResponse(reply([rows[0]!, rows[1]!, rows[5]!]), NUMBER);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('names the partner abroad and its number from the link the page gives for that partner', () => {
    for (const [link, carrier, number] of [
      ['https://www.postnord.dk/en/track-and-trace?shipmentId=00370000000000000017', 'postnord', '00370000000000000017'],
      ['https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=PQ0ZZZ0000000000000000X', 'correos-spain', 'PQ0ZZZ0000000000000000X'],
      ['https://inpost.pl/sledzenie-przesylek?number=600000000000000000000000', 'inpost', '600000000000000000000000'],
      ['https://www.hrparcel.com/traccia-spedizioni/?barcode=' + NUMBER, 'hr-parcel', NUMBER],
      ['https://www.postaonline.cz/trackandtrace/-/zasilka/DR0000000000CZ', 'ceska-posta', 'DR0000000000CZ'],
      ['https://tracking.dpd.de/status/en_US/parcel/01234567890123', 'dpd-de', '01234567890123'],
    ]) {
      expect(parseHermesGermanyResponse(abroad(link), NUMBER), link)
        .toMatchObject({ status: 'in_transit', delivery_carrier: carrier, delivery_tracking_number: number });
    }
    // An unmapped newest row keeps the partner too.
    expect(parseHermesGermanyResponse(abroad('https://inpost.pl/sledzenie-przesylek?number=600000000000000000000000', 'NEW_CODE'), NUMBER))
      .toMatchObject({ status: 'unknown', delivery_carrier: 'inpost' });
    // A home page, a host no catalog link belongs to (whatever shape its number has), Hermes's own
    // page and a link that is no URL name no partner.
    for (const link of ['https://www.post.at/', 'https://partner.example/track?id=EE123456785CN',
      `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#${NUMBER}`, 'Sendungsdetails', 42, null]) {
      const result = parseHermesGermanyResponse(abroad(link), NUMBER);
      expect(result, String(link)).not.toHaveProperty('delivery_carrier');
      expect(result, String(link)).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('does not give an unknown historical update the delivered shipment stage', () => {
    const payload = delivered();
    (payload[0]!.parcelProgress as unknown[]).push({ parcelStatus: 'FUTURE_STATUS', timestamp: '2026-09-02T09:00:00Z' });
    const result = parseHermesGermanyResponse(payload, NUMBER);
    expect(result.current_stage).toBe('delivered');
    expect(result.events?.find((event) => event.provider_code === 'FUTURE_STATUS')).not.toHaveProperty('stage');
  });

  it.each([
    ['PARCELSHOP_READY_FOR_COLLECTION', 'ready_for_pickup', 'out_for_delivery'],
    ['PARCELSHOP_COLLECTED_BY_CUSTOMER', 'delivered', 'delivered'],
    ['INTERNATIONAL_DELIVERED', 'delivered', 'delivered'],
    ['INTERNATIONAL_ARRIVED_IN_COUNTRY', 'in_transit', 'in_transit'],
    ['INTERNATIONAL_SORTED', 'in_transit', 'in_transit'],
    ['INTERNATIONAL_DELIVERY_TOUR_STARTED', 'out_for_delivery', 'out_for_delivery'],
    ['INTERNATIONAL_DELIVERY_FAILED', 'failed_attempt', 'exception'],
    ['INTERNATIONAL_DELIVERY_FAILED_ADDRESS', 'failed_attempt', 'exception'],
    ['INTERNATIONAL_PUDO_READY_FOR_COLLECTION', 'ready_for_pickup', 'out_for_delivery'],
    ['INTERNATIONAL_PUDO_NOT_COLLECTED', 'exception', 'exception'],
    ['INTERNATIONAL_UNDELIVERABLE', 'exception', 'exception'],
    ['DELIVERY_FAILED_ADDRESS_PROBLEM', 'failed_attempt', 'exception'],
    ['DELIVERY_FAILED_NOT_MET_1X', 'failed_attempt', 'exception'],
  ])('reads %s as %s', (code, stage, status) => {
    const payload = [{ barcode: NUMBER, parcelProgress: [
      { parcelStatus: 'SORTED', timestamp: '2026-09-02T09:00:00Z' },
      { parcelStatus: code, timestamp: '2026-09-03T09:00:00Z', historyText: 'Synthetic wording' },
    ] }];
    const result = parseHermesGermanyResponse(payload, NUMBER);
    expect(result).toMatchObject({ status, current_stage: stage });
    expect(result.events?.[0]).toMatchObject({ stage, provider_code: code });
  });

  it('takes a code with digits, and leaves an unknown one to the wording rules', () => {
    const payload = [{ barcode: NUMBER, parcelProgress: [
      { parcelStatus: 'SORTED', timestamp: '2026-09-02T09:00:00Z' },
      { parcelStatus: 'FUTURE_STATUS_2X', timestamp: '2026-09-03T09:00:00Z', historyText: 'Synthetic wording' },
    ] }];
    const result = parseHermesGermanyResponse(payload, NUMBER);
    expect(result.events?.[0]).toMatchObject({ provider_code: 'FUTURE_STATUS_2X' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
  });

  it('drops a booked ParcelShop like a booked safe place', () => {
    const payload = [{ barcode: NUMBER, parcelProgress: [
      { parcelStatus: 'SORTED', timestamp: '2026-09-02T09:00:00Z' },
      { parcelStatus: 'EDL_BOOKED_PARCELSHOP', timestamp: '2026-09-03T09:00:00Z', historyText: 'Für die Sendung wurde ein WunschPaketShop gebucht.' },
    ] }];
    const result = parseHermesGermanyResponse(payload, NUMBER);
    expect(result.events?.map((event) => event.provider_code)).toEqual(['SORTED']);
    expect(result.current_stage).toBe('in_transit');
  });

  it('keeps a parcel in a Hermes Box ready for pickup until the recipient takes it out', () => {
    const inBox = (code: string, view?: Record<string, unknown>, extra: Array<Record<string, unknown>> = []) => [{
      barcode: NUMBER,
      parcelAttributes: { delivered: true },
      ...(view ? { viewParameters: view } : {}),
      parcelProgress: [
        { parcelStatus: 'DELIVERY_TOUR_STARTED', timestamp: '2026-09-03T07:00:00Z' },
        { parcelStatus: code, timestamp: '2026-09-03T09:00:00Z' },
        ...extra,
      ],
    }];
    const waiting = { status: 'out_for_delivery', current_stage: 'ready_for_pickup' };
    expect(parseHermesGermanyResponse(inBox('DELIVERED_PARCELBOX'), NUMBER)).toMatchObject(waiting);
    expect(parseHermesGermanyResponse(inBox('DELIVERED_PARCELBOX', { readyForParcelBoxCollection: true }), NUMBER)).toMatchObject(waiting);
    const unflagged = parseHermesGermanyResponse(inBox('DELIVERED', { readyForParcelBoxCollection: true }), NUMBER);
    expect(unflagged).toMatchObject(waiting);
    expect(unflagged.events?.[0]?.stage).toBe('ready_for_pickup');
    expect(unflagged).not.toHaveProperty('delivered_at');
    // Taken out: the page no longer offers the pickup code, or a collection row follows.
    expect(parseHermesGermanyResponse(inBox('DELIVERED_PARCELBOX', { readyForParcelBoxCollection: false }), NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-09-03T09:00:00.000Z' });
    expect(parseHermesGermanyResponse(inBox('DELIVERED_PARCELBOX', undefined,
      [{ parcelStatus: 'PICKED_UP_BY_RECIPIENT', timestamp: '2026-09-04T09:00:00Z' }]), NUMBER))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    // A doorstep or neighbour delivery stays delivered, and the flag never hides a return.
    expect(parseHermesGermanyResponse(inBox('DELIVERED_NEIGHBOUR'), NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(parseHermesGermanyResponse(inBox('RETURN_TO_SENDER', { readyForParcelBoxCollection: true }), NUMBER).current_stage).toBe('returned');
  });

  it('names the ParcelShop that holds the parcel or handed it over, and no other address', () => {
    expect(parseHermesGermanyResponse(atShop('PARCELSHOP_READY_FOR_COLLECTION'), NUMBER).pickup_point)
      .toBe('Example Kiosk\nBeispielweg 1\n10115 Beispielstadt');
    expect(parseHermesGermanyResponse(atShop('PARCELSHOP_COLLECTED_BY_CUSTOMER'), NUMBER))
      .toMatchObject({ current_stage: 'delivered', pickup_point: 'Example Kiosk\nBeispielweg 1\n10115 Beispielstadt' });
    // A booked shop the parcel never reached, and addresses that are not a shop.
    expect(parseHermesGermanyResponse(atShop('DELIVERED_NEIGHBOUR'), NUMBER).pickup_point).toBeUndefined();
    expect(parseHermesGermanyResponse(atShop('SORTED'), NUMBER).pickup_point).toBeUndefined();
    for (const addressType of ['HOMEDELIVERY', 'NEIGHBOUR', 'DROPOFF']) {
      const payload = atShop('PARCELSHOP_READY_FOR_COLLECTION');
      payload[0]!.address = { ...(payload[0]!.address as object), addressType };
      const result = parseHermesGermanyResponse(payload, NUMBER);
      expect(result.pickup_point).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('Beispielweg');
    }
  });

  it('keeps a stored Hermes scan by its instant and status code when its stage changes', () => {
    expect(sameInstantIdentityPolicy('hermes-de')).toEqual({
      sourceCarrierId: 'hermes-de', storedSources: ['hermes-de'], requireProviderCode: true,
    });
  });

  it.each([403, 404, 429, 503])('classifies HTTP %i without hiding outages', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));
    await expect(new HermesGermanyTracker().fetch(NUMBER)).rejects.toMatchObject({
      status, name: status === 404 ? 'HermesGermanyTrackingError' : 'UpstreamHttpError',
    });
  });

  it('takes a reference\'s parcel when tracking, not when recognizing', async () => {
    const reply = () => new Response(JSON.stringify([{ barcode: '01234567890128', parcelProgress: [
      { parcelStatus: 'PARCELSHOP_DROP_OFF', timestamp: '2026-09-02T09:00:00Z' },
    ] }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    const hermes = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(hermes.track({ number: '60000000000001' }, {})).resolves.toMatchObject({ canonical_tracking_number: '01234567890128' });
    await expect(hermes.recognize!('60000000000001')).rejects.toMatchObject({ kind: 'schema' });
    await expect(hermes.recognize!('001234567890128')).resolves.toMatchObject({ known: true });
  });

  it('answers a number Hermes does not issue without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HermesGermanyTracker({ fetcher }).fetch('1234')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER }).recognize!('1234'))
      .resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
