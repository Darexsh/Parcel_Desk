import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepRecord, StepRecorder } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { DPD_DE_APP_API } from '../dpd-de/service.js';
import {
  DPDChallengeError,
  DPDTracker,
  DPDTrackingError,
  adapter,
  parseDPDTrackingApi,
  parseDPDTrackingHtml,
} from './adapter.js';
import { apiStage, apiStatus, scanStage, wordingStatus } from './status.js';

// Every identifier below is synthetic: a 14-digit number that matches DPD's
// shape but was never issued, and made-up names for the private fields the
// projection has to drop.
const TRACKING_NUMBER = '06080000000001';
const fixture = (name: string) => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
) as Record<string, unknown>;
const READY_FOR_COLLECTION = fixture('ready-for-collection.json');
const DELIVERED_VERIFIED = fixture('delivered-verified.json');
const DELIVERED_UNVERIFIED = fixture('delivered-unverified.json');
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function recordingRecorder(): { recorder: StepRecorder; steps: StepRecord[] } {
  const steps: StepRecord[] = [];
  return { steps, recorder: { step: (record) => { steps.push(record); }, lookup() {} } };
}

/** The four guest-API calls a cold tracker makes before it reads the parcel. */
function mockGuestApi(details: Response, fetcher = vi.spyOn(globalThis, 'fetch')) {
  return fetcher
    .mockResolvedValueOnce(Response.json({ fid: 'unit-test-fid', authToken: { token: 'installation-token', expiresIn: '604800s' } }))
    .mockResolvedValueOnce(Response.json({ entries: { basic_dpd_token: 'dW5pdDp0ZXN0' } }))
    .mockResolvedValueOnce(Response.json({ access_token: 'unit-test-access-token', expires_in: 3600 }))
    .mockResolvedValueOnce(details);
}

/** A parcel-details refusal, typed as the guest API types it. */
const refusal = (exceptionType: string) => Response.json({ error: 'ParcelException', exceptionType }, { status: 400 });

/** A request DPD never answers: it ends when its signal aborts. */
const unanswered: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
  init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error), { once: true });
});

afterEach(() => vi.restoreAllMocks());

type GuestScan = Record<string, unknown>;
// The Swiss shop scan's code is not known: an unmapped one leaves the stage to the reply's status.
const SHOP_SCAN: GuestScan = {
  date: '2026-07-16', time: '10:12:00', city: 'Zürich', country: 'CH', depotCountry: 'CH',
  pudoId: 'CH00001', pudoType: 100, eventType: 'ZZZ', translation: 'Your parcel is ready for collection at the Pickup parcelshop',
};
const OUT_SCAN: GuestScan = {
  date: '2026-07-16', time: '06:10:45', city: 'Urdorf', country: 'CH', depotCountry: 'CH',
  pudoId: null, pudoType: null, eventType: 'DLO', translation: 'Your parcel is out for delivery',
};
/** A verified reply for a parcel waiting at a Pickup shop, newest scan first. */
function awaitingShop(scans: GuestScan[] = [SHOP_SCAN, OUT_SCAN], description = 'AVAILABLE_FOR_COLLECTION'): Record<string, unknown> {
  return {
    ...DELIVERED_VERIFIED,
    status: {
      ...(DELIVERED_VERIFIED.status as Record<string, unknown>),
      description, deliveryType: 'PARCELSHOP', homeDelivery: false, eventDateAndTime: '2026-07-16T10:12:00',
    },
    parcelHistory: [],
    parcelEvents: scans,
  };
}
const SHOP = { name: 'Kiosk Example', address: 'EXAMPLE STREET 1\n0000 EXAMPLE TOWN' };

describe('DPD guest API projection', () => {
  it('returns every declared capability across the fixtures', () => {
    const collection = parseDPDTrackingApi(READY_FOR_COLLECTION, TRACKING_NUMBER, true);
    const delivered = parseDPDTrackingApi(DELIVERED_VERIFIED, TRACKING_NUMBER, true);
    const produced = new Set<string>();
    for (const result of [collection, delivered]) {
      if (result.events?.length) produced.add('history');
      if (result.events?.some((event) => event.location)) produced.add('location');
      if (result.expected_delivery) produced.add('eta');
      if (result.sender_name) produced.add('sender_name');
      if (result.pickup_point) produced.add('pickup_point');
      if (result.weight_kg) produced.add('weight');
      if (result.delivered_at) produced.add('delivered_at');
      if (result.events?.some((event) => event.provider_code)) produced.add('provider_code');
    }

    expect([...produced].sort()).toEqual([...CAPABILITIES].sort());
    expect(collection.expected_delivery).toBe('2026-07-16 09:00–12:00');
    expect(collection.sender_name).toBe('Example Webshop AG');
    expect(collection.pickup_point).toBe('Pickup parcelshop Zürich Wiedikon');
  });

  it('drops recipient identity, address, phone and signature', () => {
    const serialized = JSON.stringify(parseDPDTrackingApi(READY_FOR_COLLECTION, TRACKING_NUMBER));

    for (const privateValue of [
      'Private Recipient', 'Private Street 7', '+41000000000', 'signature image',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('never names the recipient as the pickup point', () => {
    const unnamed = { ...READY_FOR_COLLECTION, pickupPoint: undefined };
    expect(parseDPDTrackingApi(unnamed, TRACKING_NUMBER)).toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(parseDPDTrackingApi(unnamed, TRACKING_NUMBER).pickup_point).toBeUndefined();
    // The verified shape's receiver object names the recipient too.
    const verified = parseDPDTrackingApi(awaitingShop(), TRACKING_NUMBER, true);
    expect(verified.current_stage).toBe('ready_for_pickup');
    expect(verified.pickup_point).toBeUndefined();
  });

  it('maps the collection milestone and keeps the delivery window out of the stage', () => {
    const result = parseDPDTrackingApi(READY_FOR_COLLECTION, TRACKING_NUMBER, false);

    expect(result).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'ready_for_pickup',
      last_status_text: 'Ready for collection at the Pickup parcelshop',
      last_update: '2026-07-16T08:12:00+02:00',
      dpd_postcode_verified: false,
    });
    expect(result.events?.[2]).toMatchObject({
      location: 'Urdorf, CH',
      description: 'Parcel handed to DPD',
    });
  });

  it('summarizes the newest scan when the history is listed oldest first', () => {
    const history = READY_FOR_COLLECTION.parcelEvents as unknown[];
    const result = parseDPDTrackingApi({
      ...READY_FOR_COLLECTION,
      status: { description: 'RETURN_TO_SENDER' },
      parcelEvents: [...history].reverse(),
    }, TRACKING_NUMBER);

    // The first scan must not become the summary: the sync would read its
    // time as an older snapshot and keep the parcel at "handed to DPD".
    expect(result).toMatchObject({
      status: 'exception',
      current_stage: 'returned',
      last_status_text: 'Ready for collection at the Pickup parcelshop',
      last_update: '2026-07-16T08:12:00+02:00',
      // A returned parcel has no delivery to estimate.
      expected_delivery: null,
    });
    expect(result.events?.map((event) => event.description)).toEqual(
      parseDPDTrackingApi(READY_FOR_COLLECTION, TRACKING_NUMBER).events?.map((event) => event.description),
    );
  });
});

/** A one-scan history-only payload, for the time and zone rules. */
function historyAt(eventDateAndTime: string, eventDateAndTimeZoneId: unknown) {
  return parseDPDTrackingApi({
    parcelNumber: TRACKING_NUMBER,
    status: { description: 'IN_TRANSIT' },
    parcelHistory: [{ description: 'IN_TRANSIT', eventDateAndTime, eventDateAndTimeZoneId }],
  }, TRACKING_NUMBER).events?.[0]?.time;
}

/** A one-scan verified payload whose scan has a parcelHistory twin in `zone`. */
function scanWithTwinAt(date: string, time: string, zone: string | null) {
  return parseDPDTrackingApi({
    parcelNumber: TRACKING_NUMBER,
    status: { description: 'AT_DELIVERY_CENTER' },
    parcelEvents: [{
      date, time, city: 'Urdorf', country: 'CH', eventType: 'DLI',
      translation: 'Your parcel arrived at our delivery depot',
    }],
    parcelHistory: zone === null ? [] : [{
      description: 'AT_DELIVERY_CENTER', eventDateAndTime: `${date}T${time}`, eventDateAndTimeZoneId: zone,
    }],
  }, TRACKING_NUMBER).events?.[0]?.time;
}

describe('DPD verified guest payload', () => {
  it('names the webshop from the sender object, company first, and never the receiver', () => {
    const sender = DELIVERED_VERIFIED.sender as Record<string, unknown>;
    expect(parseDPDTrackingApi(DELIVERED_VERIFIED, TRACKING_NUMBER, true).sender_name)
      .toBe('Example Webshop AG');
    expect(parseDPDTrackingApi({
      ...DELIVERED_VERIFIED, sender: { ...sender, companyName: 'Example Webshop AG', name: 'Warehouse Contact' },
    }, TRACKING_NUMBER).sender_name).toBe('Example Webshop AG');
    // A sender without a name is not replaced by its address, its id or the receiver.
    const nameless = parseDPDTrackingApi({
      ...DELIVERED_VERIFIED, sender: { ...sender, name: null, companyName: 'UNDEFINED' },
    }, TRACKING_NUMBER);
    expect(nameless.sender_name).toBeUndefined();
  });

  it('keeps the delivery scan as the summary and drops the proof-of-delivery paperwork', () => {
    const result = parseDPDTrackingApi(DELIVERED_VERIFIED, TRACKING_NUMBER, true);

    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Your parcel has been delivered successfully',
      last_update: '2026-07-16T10:12:00+02:00',
      delivered_at: '2026-07-16T10:12:00+02:00',
      expected_delivery: null,
      weight_kg: 1.4,
    });
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['DEY', 'delivered'],
      ['DLO', 'out_for_delivery'],
      ['DLI', 'in_transit'],
      // Unmapped like its PARCEL_HANDED twin, so its wording decides.
      ['ORI', undefined],
      ['CCO', 'in_transit'],
    ]);
  });

  it('keeps the exact time, place and wording of every scan it stored before', () => {
    // The sync keys stored events on these three strings, so a change to any
    // of them duplicates the row. Only the proof-of-delivery row and the
    // "UNDEFINED" placeholder place changed on purpose.
    expect(parseDPDTrackingApi(DELIVERED_VERIFIED, TRACKING_NUMBER, true).events
      ?.map(({ time, location, description }) => [time, location, description])).toEqual([
      ['2026-07-16T10:12:00+02:00', 'Urdorf, CH', 'Your parcel has been delivered successfully'],
      ['2026-07-16T06:10:45+02:00', 'Urdorf, CH', 'Your parcel is out for delivery'],
      ['2026-07-16T03:48:00+02:00', 'Urdorf, CH', 'Your parcel arrived at our delivery depot'],
      ['2026-07-15T18:05:12+02:00', 'Urdorf, CH', 'Your parcel arrived at our depot'],
      ['2026-07-15T16:30:00+02:00', '', 'Your parcel cleared customs successfully'],
    ]);
    expect(parseDPDTrackingApi(READY_FOR_COLLECTION, TRACKING_NUMBER).events
      ?.map(({ time, location, description }) => [time, location, description])).toEqual([
      ['2026-07-16T08:12:00+02:00', 'Zürich, CH', 'Ready for collection at the Pickup parcelshop'],
      ['2026-07-15T19:04:00+02:00', 'Buchs, CH', 'Your parcel is on its way'],
      ['2026-07-14T17:31:00+02:00', 'Urdorf, CH', 'Parcel handed to DPD'],
    ]);
  });

  it('never turns a placeholder into a location, nor the depot country past a scan country', () => {
    const events = DELIVERED_VERIFIED.parcelEvents as Array<Record<string, unknown>>;
    const result = parseDPDTrackingApi({
      ...DELIVERED_VERIFIED,
      parcelEvents: [
        ...events,
        ...['UNKNOWN', 'NULL', 'NONE', 'N/A', '-'].map((country, index) => ({
          ...events[3], time: `03:0${index}:00`, city: index % 2 ? 'undefined' : null, country,
        })),
      ],
    }, TRACKING_NUMBER, true);

    // Every added scan has depotCountry "CH"; its own placeholder country wins.
    expect(result.events?.map((event) => event.location).filter(Boolean))
      .toEqual(['Urdorf, CH', 'Urdorf, CH', 'Urdorf, CH', 'Urdorf, CH']);
    expect(JSON.stringify(result.events)).not.toMatch(/undefined|unknown|null|none|n\/a/i);
  });

  it('keeps the strings it produced before for scans that are missing a field', () => {
    // Stored events are keyed on time, place and wording, so the fallbacks for
    // an empty translation, an absent country and an unfamiliar enumeration
    // value stay what they were.
    const verified = parseDPDTrackingApi({
      parcelNumber: TRACKING_NUMBER,
      status: { description: 'AT_DELIVERY_CENTER' },
      parcelEvents: [
        {
          date: '2026-07-16', time: '03:48:00', city: 'Urdorf', country: null, depotCountry: 'CH',
          translation: '', eventTypeText: 'Destination depot - Inbound', eventType: 'DLI',
        },
        {
          date: '2026-07-16', time: '03:00:00', city: null, country: null, depotCountry: 'CH',
          translation: null, eventTypeText: 'Destination depot - Inbound', eventType: 'DLI',
        },
      ],
    }, TRACKING_NUMBER, true);
    expect(verified.events?.map(({ location, description }) => [location, description])).toEqual([
      ['Urdorf, CH', 'Tracking update'],
      ['CH', 'Destination depot - Inbound'],
    ]);

    const unverified = parseDPDTrackingApi({
      parcelNumber: TRACKING_NUMBER,
      status: { description: 'IN_TRANSIT' },
      parcelHistory: [{ description: 'UNKNOWN', eventDateAndTime: '2026-07-16T03:48:00', countryCode: 'CH' }],
    }, TRACKING_NUMBER);
    expect(unverified.events).toEqual([
      { time: '2026-07-16T03:48:00+02:00', location: 'CH', description: 'Unknown' },
    ]);
  });

  it('still reports delivery when the proof-of-delivery scan is the only evidence', () => {
    const events = DELIVERED_VERIFIED.parcelEvents as Array<Record<string, unknown>>;
    const result = parseDPDTrackingApi({
      ...DELIVERED_VERIFIED,
      parcelHistory: [],
      parcelEvents: events.filter((event) => event.eventType !== 'DEY'),
    }, TRACKING_NUMBER, true);

    expect(result.events?.[0]).toEqual({
      time: '2026-07-16T10:41:30+02:00',
      location: '',
      description: 'We received the proof of delivery',
      stage: 'delivered',
      provider_code: 'DEYY',
    });
    expect(result).toMatchObject({
      last_status_text: 'We received the proof of delivery',
      delivered_at: '2026-07-16T10:41:30+02:00',
    });
  });

  it('drops a lone proof-of-delivery scan when the parcel is not delivered', () => {
    const events = DELIVERED_VERIFIED.parcelEvents as Array<Record<string, unknown>>;
    const pod = events.find((event) => event.eventType === 'DEYY')!;
    const result = parseDPDTrackingApi({
      ...DELIVERED_VERIFIED,
      status: { ...(DELIVERED_VERIFIED.status as Record<string, unknown>), description: 'RETURN_TO_SENDER' },
      parcelHistory: [{
        description: 'RETURN_TO_SENDER', eventDateAndTime: '2026-07-16T10:12:00', eventDateAndTimeZoneId: '+02:00',
      }],
      parcelEvents: [pod, {
        date: '2026-07-16', time: '10:12:00', city: 'Urdorf', country: 'CH',
        translation: 'Your parcel is on its way back to the sender', eventType: 'ZZZ',
      }],
    }, TRACKING_NUMBER, true);

    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([['ZZZ', 'returned']]);
  });

  it('reads failed rounds, a pickup-point hold and its collection by their scan codes', () => {
    const scan = (time: string, eventType: string, translation: string) => ({
      date: '2026-07-16', time, city: 'Example', country: 'DE', translation, eventType,
    });
    const result = parseDPDTrackingApi({
      parcelNumber: TRACKING_NUMBER,
      status: { description: 'DELIVERED' },
      parcelHistory: [],
      parcelEvents: [
        scan('06:00:00', 'SPX', 'Your parcel is on our premises, it will soon be on its way'),
        scan('09:00:00', 'DLR', "We couldn't deliver your parcel and had to return it to the depot"),
        scan('09:30:00', 'DLW', 'Your parcel is being held at our delivery depot, your premises were closed'),
        scan('10:00:00', 'DEX', "We couldn't deliver your parcel, it will soon be available at a retrieval point"),
        scan('11:00:00', 'DEHD', 'Your parcel has been delivered to the retrieval point, it will soon be available for collection'),
        scan('11:01:00', 'DEHDY', 'Your parcel has been delivered to the retrieval point'),
        scan('11:02:00', 'DOMSDLO', 'Your parcel is available at the retrieval point'),
        scan('11:03:00', 'DODEI', 'Your parcel is available at the retrieval point'),
        scan('15:00:00', 'DODEY', 'You have collected your parcel'),
        scan('15:01:00', 'DODEYY', 'We received the proof of delivery'),
      ],
    }, TRACKING_NUMBER, true);

    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'You have collected your parcel' });
    // The proof of delivery is dropped beside the collection, like DEYY beside DEY.
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['DODEY', 'delivered'], ['DODEI', 'ready_for_pickup'], ['DOMSDLO', 'ready_for_pickup'], ['DEHDY', 'ready_for_pickup'],
      ['DEHD', 'ready_for_pickup'], ['DEX', 'failed_attempt'], ['DLW', 'failed_attempt'], ['DLR', 'failed_attempt'], ['SPX', 'in_transit'],
    ]);
  });

  it('keeps the stage of the scan before a notice that reads like a failed round, and never summarizes it', () => {
    const scan = (time: string, eventType: string, translation: string) => ({
      date: '2026-07-16', time, city: 'Example', country: 'DE', translation, eventType,
    });
    const result = parseDPDTrackingApi({
      parcelNumber: TRACKING_NUMBER,
      status: { description: 'IN_TRANSIT' },
      parcelHistory: [],
      parcelEvents: [
        scan('06:00:00', 'HUS', 'Your parcel is ready to be transported to our next premises'),
        scan('06:30:00', 'SPL', 'Your parcel is on its way'),
        scan('07:00:00', 'MSDLX', "We couldn't send a notification with your delivery details"),
        scan('08:00:00', 'LHI', 'Your parcel is on its way'),
        scan('09:00:00', 'DLO', 'Your parcel is out for delivery'),
        scan('10:00:00', 'DEXD', 'There was an issue to drop off your parcel due to a lack of space in the retrieval point'),
        scan('10:05:00', 'MSDLX', "We couldn't send a notification with your delivery details"),
      ],
    }, TRACKING_NUMBER, true);

    expect(result.last_status_text).toBe('There was an issue to drop off your parcel due to a lack of space in the retrieval point');
    expect(result.events?.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['MSDLX', 'failed_attempt', 'none'], ['DEXD', 'failed_attempt', undefined], ['DLO', 'out_for_delivery', undefined],
      ['LHI', 'in_transit', undefined], ['MSDLX', 'in_transit', 'none'], ['SPL', undefined, undefined], ['HUS', 'in_transit', undefined],
    ]);
  });

  it('keeps the stage of the scan before DPD’s internal data exchange, which no rule reads', () => {
    const scan = (time: string, eventType: string, translation: string) => ({
      date: '2026-10-19', time, city: 'Example', country: 'DE', translation, eventType,
    });
    const labelled = parseDPDTrackingApi({
      parcelNumber: TRACKING_NUMBER,
      parcelHistory: [],
      parcelEvents: [
        scan('08:00:00', 'CNP', 'We received your labelling information'),
        scan('08:05:00', 'ENA', 'We are exchanging data internally'),
      ],
    }, TRACKING_NUMBER, true);
    expect(labelled.last_status_text).toBe('We received your labelling information');
    expect(labelled.events?.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['ENA', 'registered', 'none'], ['CNP', 'registered', undefined],
    ]);

    const collected = parseDPDTrackingApi({
      parcelNumber: TRACKING_NUMBER,
      parcelHistory: [],
      parcelEvents: [
        scan('09:00:00', 'PKY', 'We have collected your parcel'),
        scan('09:30:00', 'ENA', 'We are exchanging data internally'),
      ],
    }, TRACKING_NUMBER, true);
    expect(collected.events?.map((event) => [event.provider_code, event.stage])).toEqual([['ENA', 'accepted'], ['PKY', 'accepted']]);
  });

  it('leaves unknown scan codes to the wording rules', () => {
    const result = parseDPDTrackingApi({
      parcelNumber: TRACKING_NUMBER,
      status: { description: 'IN_TRANSIT' },
      parcelEvents: [
        { date: '2026-07-15', time: '09:00:00', country: 'CH', eventType: 'XYZ', translation: 'Something new' },
        { date: '2026-07-15', time: '08:00:00', country: 'CH', eventType: 'not a code!', translation: 'Odd code' },
      ],
    }, TRACKING_NUMBER);

    expect(result.events).toEqual([
      { time: '2026-07-15T09:00:00+02:00', location: 'CH', description: 'Something new', provider_code: 'XYZ' },
      { time: '2026-07-15T08:00:00+02:00', location: 'CH', description: 'Odd code' },
    ]);
  });

  it('drops the receiver, sender address, references, product and proof-of-delivery link', () => {
    const serialized = JSON.stringify(parseDPDTrackingApi(DELIVERED_VERIFIED, TRACKING_NUMBER, true));

    for (const privateValue of [
      'Private Recipient', 'recipient@example.invalid', '+41000000000', 'Private Street', 'Private Town',
      '9999', '46.000001', '8.000001', 'geoPosition', 'Sender Street', 'Sender City', '00000',
      'SENDER0000000001', 'PRIVATE-REFERENCE', 'delivery preference', 'pod.example.invalid',
      'parcelNumber', TRACKING_NUMBER, 'DPD-CH', '[object Object]',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
});

describe('DPD delivery notices', () => {
  type Scan = [date: string, time: string, code: string, translation: string];
  const ESTIMATED: Scan = ['2026-07-14', '19:20:00', 'SPE', 'Your parcel is estimated to be delivered on: Friday, July 17, 2026'];
  const CHANGED: Scan = ['2026-07-15', '12:30:00', 'SPE', 'Your parcel delivery date has changed, it will be delivered on: Thursday, July 16, 2026'];
  const EMAILED: Scan = ['2026-07-16', '06:00:00', 'MSDLO', 'We informed you via email that your parcel will be delivered on Thursday, July 16, 2026 between 12:32 PM and 1:32 PM'];
  const SAFE_PLACE: Scan = ['2026-07-15', '22:50:00', 'MIDLI', 'Your parcel will be delivered to a safe place according to your instructions'];
  const OUT: Scan = ['2026-07-16', '06:00:00', 'DLO', 'Your parcel is out for delivery'];
  const DEPOT: Scan = ['2026-07-14', '19:05:00', 'ORI', 'Your parcel arrived at our depot'];
  /** A verified in-transit reply shaped like the guest API's, oldest scan first. */
  const notices = (scans: Scan[], fields: Record<string, unknown> = {}, description = 'IN_TRANSIT') => parseDPDTrackingApi({
    parcelNumber: TRACKING_NUMBER,
    status: { description, eventDateAndTime: '2026-07-14T19:05:00', eventDateAndTimeZoneId: 'Europe/Zurich' },
    isPredictiveDate: false,
    ...fields,
    parcelEvents: scans.map(([date, time, eventType, translation]) => ({
      date, time, eventType, translation, eventTypeText: 'Status parcel - Information', city: null, country: 'CH',
    })),
  }, TRACKING_NUMBER, true);

  it('reads the newest notice without changing the scans', () => {
    const result = notices([DEPOT, ESTIMATED, CHANGED, SAFE_PLACE]);

    expect(result.expected_delivery).toBe('2026-07-16');
    expect(result.events?.map((event) => event.description)).toEqual([SAFE_PLACE, CHANGED, ESTIMATED, DEPOT].map((scan) => scan[3]));
    // Each notice keeps the stage of the scan before it and is never the summary.
    expect(result.events?.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['MIDLI', 'in_transit', 'none'], ['SPE', 'in_transit', 'none'], ['SPE', 'in_transit', 'none'], ['ORI', undefined, undefined],
    ]);
    expect(result.last_status_text).toBe(DEPOT[3]);
    expect(notices([DEPOT, ESTIMATED]).expected_delivery).toBe('2026-07-17');
  });

  it('keeps a parcel DPD has only the label for registered through instructions, estimates and notices', () => {
    const LABEL: Scan = ['2026-07-14', '08:00:00', 'CNP', 'We received your labelling information'];
    const RECEIVED: Scan = ['2026-07-14', '22:55:00', 'MIA', 'We received your delivery instructions'];
    const INSTRUCTED: Scan = ['2026-07-14', '22:56:00', 'MII', SAFE_PLACE[3]];
    const OTHER: Scan = ['2026-07-14', '23:10:00', 'OTHER', 'Other tracking update'];
    const INSTRUCTION: Scan = ['2026-07-14', '22:50:00', 'MIDLI', SAFE_PLACE[3]];
    const ESTIMATE: Scan = ['2026-07-14', '23:00:00', 'SPE', ESTIMATED[3]];
    const EMAIL: Scan = ['2026-07-14', '23:20:00', 'MSDLO', EMAILED[3]];
    const result = notices([LABEL, INSTRUCTION, RECEIVED, INSTRUCTED, ESTIMATE, OTHER, EMAIL], {}, 'ORDER_CREATED');

    expect(result.events?.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['MSDLO', 'registered', 'none'], ['OTHER', 'registered', 'none'], ['SPE', 'registered', 'none'],
      ['MII', 'registered', 'none'], ['MIA', 'registered', 'none'], ['MIDLI', 'registered', 'none'], ['CNP', 'registered', undefined],
    ]);
    expect(result).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: LABEL[3] });
    expect(result.expected_delivery).toBe('2026-07-16 12:32–13:32');
  });

  it('keeps the round a notice follows', () => {
    const result = notices([DEPOT, OUT, ['2026-07-16', '06:30:00', 'MSDLO', EMAILED[3]]]);
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['MSDLO', 'out_for_delivery'], ['DLO', 'out_for_delivery'], ['ORI', undefined],
    ]);
    expect(result.last_status_text).toBe(OUT[3]);
  });

  it('keeps scans of one instant in the carrier\'s order', () => {
    expect(notices([DEPOT, OUT, EMAILED]).events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['MSDLO', 'out_for_delivery'], ['DLO', 'out_for_delivery'], ['ORI', undefined],
    ]);
  });

  it('reads the email window as a 24-hour wall clock', () => {
    expect(notices([DEPOT, CHANGED, OUT, EMAILED]).expected_delivery).toBe('2026-07-16 12:32–13:32');
    const window = (text: string) => notices([DEPOT, [...EMAILED.slice(0, 3), text] as Scan]).expected_delivery;
    expect(window('We informed you via SMS that your parcel will be delivered on Thursday, July 16, 2026 between 9:00 AM and 12:00 PM'))
      .toBe('2026-07-16 09:00–12:00');
    expect(window('We informed you via email that your parcel will be delivered on Thursday, July 16, 2026 between 12:15 AM and 08:45'))
      .toBe('2026-07-16 00:15–08:45');
    // An impossible or reversed window keeps the day.
    for (const clocks of ['13:00 PM and 2:00 PM', '11:00 AM and 10:00 AM', '25:00 and 26:00']) {
      expect(window(`We informed you via email that your parcel will be delivered on Thursday, July 16, 2026 between ${clocks}`)).toBe('2026-07-16');
    }
  });

  it('lets the newest notice end an older day when it cannot be read', () => {
    const undated: Scan = ['2026-07-15', '12:30:00', 'SPE', 'Your parcel will be delivered on the next working day'];
    expect(notices([DEPOT, ESTIMATED, undated]).expected_delivery).toBeNull();
    for (const day of ['Thursday, Julember 16, 2026', 'Thursday, February 30, 2026', 'Thursday, 16.07.2026']) {
      expect(notices([DEPOT, ESTIMATED, ['2026-07-15', '12:30:00', 'SPE', `Your parcel is estimated to be delivered on: ${day}`]]).expected_delivery).toBeNull();
    }
  });

  it('keeps the payload estimate, adding a window only for its own day', () => {
    expect(notices([DEPOT, CHANGED, OUT, EMAILED], { deliveryDate: '2026-07-16' }).expected_delivery).toBe('2026-07-16 12:32–13:32');
    expect(notices([DEPOT, CHANGED, OUT, EMAILED], { deliveryDate: '2026-07-16', deliveryTimeFrom: '12:00:00', deliveryTimeTo: '14:00:00' }).expected_delivery)
      .toBe('2026-07-16 12:00–14:00');
    expect(notices([DEPOT, ESTIMATED], { deliveryDate: '2026-07-18' }).expected_delivery).toBe('2026-07-18');
  });

  it('drops a notice once delivered, returned, at a pickup point or overtaken by a later day', () => {
    const delivered: Scan = ['2026-07-16', '10:55:00', 'DEY', 'Your parcel has been delivered successfully'];
    expect(notices([DEPOT, CHANGED, OUT, EMAILED, delivered], {}, 'DELIVERED').expected_delivery).toBeNull();
    expect(notices([DEPOT, CHANGED], {}, 'RETURN_TO_SENDER').expected_delivery).toBeNull();
    expect(notices([DEPOT, CHANGED], {}, 'AVAILABLE_FOR_COLLECTION').expected_delivery).toBeNull();
    expect(notices([DEPOT, CHANGED, ['2026-07-17', '04:00:00', 'DLI', 'Your parcel arrived at our delivery depot']]).expected_delivery).toBeNull();
    expect(notices([DEPOT, CHANGED, OUT]).expected_delivery).toBe('2026-07-16');
  });
});

describe('DPD unverified guest payload', () => {
  it('reads each scan with its own offset, code and enumeration stage', () => {
    const result = parseDPDTrackingApi(DELIVERED_UNVERIFIED, TRACKING_NUMBER, false);

    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-07-16T10:12:00+02:00',
      delivered_at: '2026-07-16T10:12:00+02:00',
      expected_delivery: null,
      dpd_postcode_verified: false,
    });
    expect(result.sender_name).toBeUndefined();
    expect(result.weight_kg).toBeUndefined();
    // Exact strings: stored events are keyed on them.
    expect(result.events).toEqual([
      {
        time: '2026-07-16T10:12:00+02:00', location: '', description: 'Delivered',
        stage: 'delivered', provider_code: 'DELIVERED',
      },
      {
        time: '2026-07-16T06:10:45+02:00', location: '', description: 'Parcel out for delivery',
        stage: 'out_for_delivery', provider_code: 'PARCEL_OUT_FOR_DELIVERY',
      },
      {
        time: '2026-07-16T03:48:00+02:00', location: '', description: 'At delivery center',
        provider_code: 'AT_DELIVERY_CENTER',
      },
      {
        time: '2026-07-15T18:05:12+02:00', location: '', description: 'Parcel handed to DPD',
        provider_code: 'PARCEL_HANDED',
      },
    ]);
  });

  it('reads a hand-over dated after the parcel moved as a hand-off between DPD units', () => {
    const milestones = (handed: string) => parseDPDTrackingApi({
      parcelNumber: TRACKING_NUMBER,
      status: { description: 'PARCEL_HANDED' },
      parcelHistory: [
        { description: 'PARCEL_HANDED', eventDateAndTime: handed },
        { description: 'IN_TRANSIT', eventDateAndTime: '2026-10-23T17:39:42' },
      ],
    }, TRACKING_NUMBER, false);
    const abroad = milestones('2026-10-23T18:47:42');
    expect(abroad).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Parcel handed to DPD' });
    expect(abroad.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['PARCEL_HANDED', 'in_transit'], ['IN_TRANSIT', undefined],
    ]);
    // Before the parcel moves, it is left to its wording.
    const accepted = milestones('2026-10-22T15:15:58');
    expect(accepted.current_stage).toBeUndefined();
    expect(accepted.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['IN_TRANSIT', undefined], ['PARCEL_HANDED', undefined],
    ]);
  });

  it('reads no movement into the catch-all before a hand-over', () => {
    const result = parseDPDTrackingApi({
      parcelNumber: TRACKING_NUMBER,
      status: { description: 'PARCEL_HANDED' },
      parcelHistory: [
        { description: 'PARCEL_HANDED', eventDateAndTime: '2026-10-23T18:47:42' },
        { description: 'OTHER', eventDateAndTime: '2026-10-23T17:39:42' },
      ],
    }, TRACKING_NUMBER, false);
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['PARCEL_HANDED', undefined, undefined], ['OTHER', 'registered', 'none'],
    ]);
  });
});

describe('DPD scan times', () => {
  it('takes each scan offset from its parcelHistory twin', () => {
    // 02:30 happens twice in Zurich on 2026-10-25; only the twin says which.
    expect(scanWithTwinAt('2026-10-25', '02:30:00', '+01:00')).toBe('2026-10-25T02:30:00+01:00');
    expect(scanWithTwinAt('2026-10-25', '02:30:00', '+02:00')).toBe('2026-10-25T02:30:00+02:00');
    expect(scanWithTwinAt('2026-10-25', '02:30:00', null)).toBe('2026-10-25T02:30:00+02:00');
    expect(scanWithTwinAt('2026-07-15', '10:00:00', '+01:00')).toBe('2026-07-15T10:00:00+01:00');
    expect(scanWithTwinAt('2026-07-15', '10:00:00', 'not a zone')).toBe('2026-07-15T10:00:00+02:00');
  });

  it('pairs a scan with a twin only when neither shares its wall clock', () => {
    const scansAt = (history: Array<[string, string]>, codes: string[]) => parseDPDTrackingApi({
      parcelNumber: TRACKING_NUMBER,
      status: { description: 'DELIVERED' },
      parcelHistory: history.map(([description, zone]) => ({
        description, eventDateAndTime: '2026-10-25T02:30:00', eventDateAndTimeZoneId: zone,
      })),
      parcelEvents: codes.map((code) => ({
        date: '2026-10-25', time: '02:30:00', city: 'Urdorf', country: 'CH', eventType: code, translation: code,
      })),
    }, TRACKING_NUMBER).events?.map((event) => [event.provider_code, event.time, event.stage ?? null]);

    // One history entry, two scans: the unknown code borrows no stage.
    expect(scansAt([['DELIVERED', '+01:00']], ['DEY', 'ZZZ'])).toEqual([
      ['DEY', '2026-10-25T02:30:00+01:00', 'delivered'],
      ['ZZZ', '2026-10-25T02:30:00+01:00', null],
    ]);
    // Two entries that disagree on the repeated hour: neither offset is guessed.
    expect(scansAt([['OTHER', '+01:00'], ['DELIVERED', '+02:00']], ['ZZY', 'ZZZ'])).toEqual([
      ['ZZY', '2026-10-25T02:30:00+02:00', null],
      ['ZZZ', '2026-10-25T02:30:00+02:00', null],
    ]);
    expect(scansAt([['OTHER', '+01:00'], ['DELIVERED', '+01:00']], ['ZZZ'])).toEqual([
      ['ZZZ', '2026-10-25T02:30:00+01:00', null],
    ]);
  });

  it('keeps the stored spelling when a zone id names the instant already stored', () => {
    // 02:30 does not exist in Zurich on 2026-03-29, so Swiss time read it as
    // 03:30+02:00; a +01:00 twin names that same instant.
    expect(scanWithTwinAt('2026-03-29', '02:30:00', null)).toBe('2026-03-29T03:30:00+02:00');
    expect(scanWithTwinAt('2026-03-29', '02:30:00', '+01:00')).toBe('2026-03-29T03:30:00+02:00');
    expect(historyAt('2026-03-29T02:30:00', 'GMT+1')).toBe('2026-03-29T03:30:00+02:00');
  });

  it('keeps a page row that shows only its date as that date, never midnight', () => {
    const summary = parseDPDTrackingHtml(`<html><body><div>${TRACKING_NUMBER}</div><div class="parcelStatus">
      <div class="row"><div class="col-xs-5">03.08.2026</div><div class="col-xs-7">Parcel handed to DPD</div></div>
      <div class="row"><div class="col-xs-5">04.08.2026</div><div class="col-xs-7">At delivery centre</div></div>
      <div class="row"><div class="col-xs-5">04.08.2026</div><div class="col-xs-7">Delivered</div></div>
      <div class="row"><div class="col-xs-5">31.02.2026</div><div class="col-xs-7">Not a day</div></div>
    </div></body></html>`, TRACKING_NUMBER);
    expect(summary.events).toEqual([
      { local_time: '2026-08-04', location: '', description: 'Delivered' },
      { local_time: '2026-08-04', location: '', description: 'At delivery centre' },
      { local_time: '2026-08-03', location: '', description: 'Parcel handed to DPD' },
    ]);
    expect(summary).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-08-04' });

    const scans = parseDPDTrackingHtml(`<html><body><div>${TRACKING_NUMBER}</div>
      <li class="content-item-track"><span class="entry-date">04.08.2026</span><span class="entry-body">At delivery centre</span></li>
      <li class="content-item-track"><span class="entry-date">03.08.2026</span><span class="entry-time">17:05</span><span class="entry-body">Parcel handed to DPD</span></li>
    </body></html>`, TRACKING_NUMBER);
    expect(scans.events?.map((event) => event.time ?? event.local_time)).toEqual(['2026-08-04', '2026-08-03T17:05:00+02:00']);
    expect(scans.events?.[0]?.time).toBeUndefined();
  });

  it('accepts the zone spellings DPD could plausibly send', () => {
    for (const zone of ['+01:00', '+0100', '+01', 'UTC+1', 'GMT+01:00', 'Europe/Zurich', null, '', 'not a zone', {}]) {
      expect(historyAt('2026-01-15T10:00:00', zone)).toBe('2026-01-15T10:00:00+01:00');
    }
    for (const zone of ['Z', 'UTC', 'utc', 'GMT', '+00:00']) {
      expect(historyAt('2026-01-15T10:00:00', zone)).toBe('2026-01-15T10:00:00Z');
    }
    expect(historyAt('2026-07-15T10:00:00', '+0200')).toBe('2026-07-15T10:00:00+02:00');
    expect(historyAt('2026-07-15T10:00:00', 'Europe/London')).toBe('2026-07-15T10:00:00+01:00');
    // An offset no zone has is ignored rather than stamped on the scan.
    expect(historyAt('2026-07-15T10:00:00', '+25:00')).toBe('2026-07-15T10:00:00+02:00');
    expect(historyAt('2026-07-15T10:00:00+03:00', 'Europe/Zurich')).toBe('2026-07-15T10:00:00+03:00');
  });
});

describe('DPD field hygiene', () => {
  it('never stringifies an object, array or boolean into the projection', () => {
    const odd = { name: 'Example Webshop AG' };
    const result = parseDPDTrackingApi({
      parcelNumber: TRACKING_NUMBER,
      status: { description: { code: 'DELIVERED' }, eventDateAndTime: odd },
      senderName: odd,
      sender: ['Example Webshop AG'],
      deliveryDate: odd,
      deliveryTimeFrom: true,
      weight: odd,
      parcelEvents: [{
        date: '2026-07-16', time: '10:12:00', city: odd, country: 'CH',
        translation: { en: 'Delivered' }, eventTypeText: 'Delivery - Delivered', eventType: 'DEY',
      }, {
        date: '2026-07-16', time: '09:00:00', city: 'Urdorf', country: ['CH'],
        translation: false, eventType: odd,
      }],
    }, TRACKING_NUMBER);

    expect(JSON.stringify(result)).not.toContain('[object Object]');
    expect(JSON.stringify(result)).not.toContain('true');
    expect(result.sender_name).toBeUndefined();
    expect(result.weight_kg).toBeUndefined();
    expect(result.events).toEqual([
      {
        time: '2026-07-16T10:12:00+02:00', location: 'CH', description: 'Delivery - Delivered',
        stage: 'delivered', provider_code: 'DEY',
      },
      { time: '2026-07-16T09:00:00+02:00', location: 'Urdorf', description: 'Tracking update' },
    ]);
  });

  it('reads the weight in kilograms and drops implausible values', () => {
    const weight = (value: unknown) => parseDPDTrackingApi({ ...DELIVERED_UNVERIFIED, weight: value }, TRACKING_NUMBER).weight_kg;

    expect(weight(1.4)).toBe(1.4);
    expect(weight('2,5')).toBe(2.5);
    expect(weight(12)).toBe(12);
    for (const value of [0, -1, 10_000, Number.NaN, '', 'heavy', '1e3', null, {}]) {
      expect(weight(value)).toBeUndefined();
    }
  });
});

describe('DPD status vocabulary', () => {
  it('maps the enumeration values that are unambiguous and leaves the rest unmapped', () => {
    expect(apiStage('DELIVERED')).toBe('delivered');
    expect(apiStage('RETURN_TO_SENDER')).toBe('returned');
    expect(apiStage('UNSUCCESSFUL_DELIVERY_ATTEMPT')).toBe('failed_attempt');
    // Movement through the network has no milestone of its own.
    for (const key of ['PARCEL_HANDED', 'IN_TRANSIT', 'AT_DELIVERY_CENTER', 'OTHER', { key: 'DELIVERED' }]) {
      expect(apiStage(key)).toBeNull();
    }
  });

  it('maps only the scan codes a live lookup paired or labelled with one movement', () => {
    expect(['PKY', 'CCO', 'SPX', 'HUI', 'HUS', 'LHI', 'DLI', 'DLS', 'DLQ', 'DLO', 'DEY'].map(scanStage)).toEqual([
      'accepted', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'out_for_delivery', 'delivered',
    ]);
    expect(['DEX', 'DEXD', 'DLR', 'DLW', 'DEHD', 'DEHDY', 'DODEI', 'DOMSDLO', 'DODEY'].map(scanStage)).toEqual([
      'failed_attempt', 'failed_attempt', 'failed_attempt', 'failed_attempt', 'ready_for_pickup', 'ready_for_pickup', 'ready_for_pickup', 'ready_for_pickup', 'delivered',
    ]);
    // A sender's hand-in at a pickup point, after the label data.
    expect(['CNP', 'DOPKY', 'DODEH', 'ORS'].map(scanStage)).toEqual(['registered', 'accepted', 'in_transit', 'in_transit']);
    // ORI and SPL are left to their wording, like their PARCEL_HANDED and
    // IN_TRANSIT twins; notices and estimates are no scan, nor the proofs of delivery.
    for (const code of ['ORI', 'SPL', 'SPE', 'MSDLO', 'MSDLX', 'MIDLI', 'MIA', 'MII', 'ENA', 'DEYY', 'DODEYY', 'XYZ', '', 'CONSTRUCTOR', '__proto__']) {
      expect(scanStage(code)).toBeNull();
    }
  });

  it('documents every mapped code in statuses.json', () => {
    const { entries } = JSON.parse(
      readFileSync(new URL('./statuses.json', import.meta.url), 'utf8'),
    ) as { entries: Array<{ code: string; stage?: string }> };

    for (const { code, stage } of entries) {
      // The proof-of-delivery scans are staged by the parser, not by a map.
      if (code === 'DEYY' || code === 'DODEYY') continue;
      expect([code, scanStage(code) ?? apiStage(code)]).toEqual([code, stage ?? null]);
    }
  });

  it('treats a failed attempt as a retry and a return as an exception', () => {
    expect(apiStatus('UNSUCCESSFUL_DELIVERY_ATTEMPT', '', true)).toBe('in_transit');
    expect(apiStatus('RETURN_TO_SENDER', '', true)).toBe('exception');
    expect(apiStatus('UNKNOWN_KEY', 'Zugestellt', true)).toBe('delivered');
  });

  it('classifies the rendered page in the four portal languages', () => {
    expect(wordingStatus('Consegnato', false)).toBe('delivered');
    expect(wordingStatus('En cours de livraison', false)).toBe('out_for_delivery');
    expect(wordingStatus('Data received', false)).toBe('pending');
    expect(wordingStatus('Something we do not know', false)).toBe('unknown');
    // A delivery notice is not a delivery.
    expect(wordingStatus('Your parcel will be delivered on Tuesday between 10:00 and 11:00', true)).toBe('in_transit');
    expect(wordingStatus('Votre colis sera livré mardi', false)).toBe('unknown');
    expect(apiStatus('OTHER', 'Ihr Paket wird am Dienstag zugestellt', true)).toBe('in_transit');
  });
});

describe('DPDTracker steps', () => {
  it('serves the lookup from the direct guest protocol and records one step', async () => {
    const fetcher = mockGuestApi(Response.json(READY_FOR_COLLECTION));
    const { recorder, steps } = recordingRecorder();

    const result = await new DPDTracker({ timeoutMs: 1_000, trawl: null, recorder })
      .fetch(TRACKING_NUMBER, '8000');

    expect(result).toMatchObject({ status: 'out_for_delivery' });
    expect(result.tracking_url).toContain(TRACKING_NUMBER);
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([['direct', 'ok']]);
    expect(String(fetcher.mock.calls[3]?.[0])).toContain('dataForVerification=8000');
  });

  it('takes a label typed with its check character and refuses a mistyped one', async () => {
    const fetcher = mockGuestApi(Response.json(READY_FOR_COLLECTION));
    const tracker = new DPDTracker({ timeoutMs: 1_000, trawl: null });

    const result = await tracker.fetch(`${TRACKING_NUMBER}4`, '8000');

    expect(result.tracking_url).toContain(`parcelNumber=${TRACKING_NUMBER}`);
    expect(String(fetcher.mock.calls[3]?.[0])).toContain(TRACKING_NUMBER);
    expect(String(fetcher.mock.calls[3]?.[0])).not.toContain(`${TRACKING_NUMBER}4`);
    const requests = fetcher.mock.calls.length;
    await expect(tracker.fetch(`${TRACKING_NUMBER}5`, '8000')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(tracker.recognizes(`${TRACKING_NUMBER}5`)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it.each([
    ['75001', 'dataForVerification=75001'],
    [' sw1a  1aa ', 'dataForVerification=SW1A+1AA'],
    ['00-001', 'dataForVerification=00-001'],
  ])('sends the postcode of a delivery abroad for verification: %s', async (postcode, query) => {
    const fetcher = mockGuestApi(Response.json(READY_FOR_COLLECTION));

    const result = await new DPDTracker({ timeoutMs: 1_000, trawl: null }).fetch(TRACKING_NUMBER, postcode);

    expect(result.dpd_postcode_verified).toBe(true);
    expect(String(fetcher.mock.calls[3]?.[0])).toContain(query);
  });

  it.each(['12', 'ABCDE', '1'.repeat(13), '75001/2'])('refuses a postcode no country writes before asking DPD: %s', async (postcode) => {
    const fetcher = vi.spyOn(globalThis, 'fetch');

    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: null }).fetch(TRACKING_NUMBER, postcode))
      .rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('holds the German unit to a German postcode', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');

    await expect(new DPDTracker({ country: 'DE', timeoutMs: 1_000, trawl: null }).fetch(TRACKING_NUMBER, '8000'))
      .rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retries without verification when DPD rejects the postcode, and says so', async () => {
    const fetcher = mockGuestApi(refusal('PROVIDE_ZIP_CODE'))
      .mockResolvedValueOnce(Response.json(READY_FOR_COLLECTION));

    const result = await new DPDTracker({ timeoutMs: 1_000, trawl: null })
      .fetch(TRACKING_NUMBER, '9999');

    expect(result.dpd_postcode_verified).toBe(false);
    expect(String(fetcher.mock.calls[4]?.[0])).toContain('continueWithoutVerification=true');
    expect(String(fetcher.mock.calls[4]?.[0])).not.toContain('9999');
  });

  it('falls back to the rendered page and records the recovery as the page step', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<html>maintenance</html>'))
      .mockResolvedValueOnce(new Response(`
        <html><body>
          <div>${TRACKING_NUMBER}</div>
          <li class="content-item-track">
            <span class="entry-date">15.07.2026</span>
            <span class="entry-time">11:28</span>
            <span class="entry-body">Parcel handed to DPD</span>
          </li>
        </body></html>
      `));
    const { recorder, steps } = recordingRecorder();

    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: null, recorder }).fetch(TRACKING_NUMBER))
      .resolves.toMatchObject({ status: 'in_transit' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(steps.map((step) => step.step)).toEqual(['direct', 'page']);
    expect(steps[1]).toMatchObject({ fallbackFrom: 'direct', fallbackReason: 'indeterminate' });
  });

  it('recognizes a number only from the guest API and never tries the page', async () => {
    const known = mockGuestApi(Response.json(DELIVERED_UNVERIFIED));
    const tracker = new DPDTracker({ timeoutMs: 1_000, trawl: null });
    await expect(tracker.recognizes(TRACKING_NUMBER)).resolves.toBe(true);
    expect(String(known.mock.calls[3]?.[0])).toContain('continueWithoutVerification=true');
    // Warm token: one details request per question.
    known.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(tracker.recognizes(TRACKING_NUMBER)).resolves.toBe(false);
    known.mockResolvedValueOnce(refusal('PARCEL_NOT_FOUND'));
    await expect(tracker.recognizes(TRACKING_NUMBER)).resolves.toBe(false);
    known.mockResolvedValueOnce(Response.json({ ...READY_FOR_COLLECTION, parcelNumber: '06080000000009' }));
    await expect(tracker.recognizes(TRACKING_NUMBER)).resolves.toBe(false);
    known.mockResolvedValueOnce(new Response('<html>maintenance</html>', { status: 500 }));
    await expect(tracker.recognizes(TRACKING_NUMBER)).rejects.toThrow();
    // A refusal that does not name the parcel unknown says nothing about it.
    known.mockResolvedValueOnce(refusal('PROVIDE_ZIP_CODE'));
    await expect(tracker.recognizes(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    known.mockResolvedValueOnce(new Response('', { status: 400 }));
    await expect(tracker.recognizes(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(known).toHaveBeenCalledTimes(10);
    await expect(tracker.recognizes('1234')).resolves.toBe(false);
    expect(known).toHaveBeenCalledTimes(10);
  });

  it('keeps a broken guest login a failure rather than an unknown parcel', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 400 }))
      .mockResolvedValueOnce(new Response('', { status: 400 }));
    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: null }).recognizes(TRACKING_NUMBER)).rejects.toThrow();
  });

  it.each(['DE', 'GB'])('does not recognize %s activity as Swiss DPD', async (countryCode) => {
    const payload = structuredClone(READY_FOR_COLLECTION);
    (payload.status as Record<string, unknown>).countryCode = countryCode;
    const fetcher = mockGuestApi(Response.json(payload));
    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: null }).recognizes(TRACKING_NUMBER)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([undefined, null, 'UNDEFINED', {}, ''])('keeps missing or unusable Swiss country evidence inconclusive', async (countryCode) => {
    const payload = structuredClone(READY_FOR_COLLECTION);
    (payload.status as Record<string, unknown>).countryCode = countryCode;
    const fetcher = mockGuestApi(Response.json(payload));
    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: null }).recognizes(TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not recognize a Swiss identity and summary without shipment activity', async () => {
    const fetcher = mockGuestApi(Response.json({
      parcelNumber: TRACKING_NUMBER, status: { description: 'ORDER_CREATED', countryCode: 'CH' }, parcelHistory: [],
    }));
    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: null }).recognizes(TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('shares one guest login between concurrent lookups', async () => {
    const fetcher = mockGuestApi(Response.json(DELIVERED_UNVERIFIED))
      .mockResolvedValueOnce(Response.json(DELIVERED_UNVERIFIED))
      .mockResolvedValueOnce(Response.json(DELIVERED_UNVERIFIED));
    const tracker = new DPDTracker({ timeoutMs: 1_000, trawl: null });
    await expect(Promise.all([1, 2, 3].map(() => tracker.recognizes(TRACKING_NUMBER)))).resolves.toEqual([true, true, true]);
    // Installation, Remote Config and the token once; three details requests.
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('answers lookups from a failed login for a short while, then tries again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
      const tracker = new DPDTracker({ timeoutMs: 1_000, trawl: null });
      await expect(Promise.all([1, 2, 3].map(() => tracker.recognizes(TRACKING_NUMBER)))).rejects.toThrow();
      const calls = fetcher.mock.calls.length;
      await expect(tracker.recognizes(TRACKING_NUMBER)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(calls);
      vi.setSystemTime(Date.now() + 31_000);
      await expect(tracker.recognizes(TRACKING_NUMBER)).rejects.toThrow();
      expect(fetcher.mock.calls.length).toBeGreaterThan(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a lookup that was cut short out of the guest login the others share', async () => {
    const fetcher = mockGuestApi(
      Response.json(DELIVERED_UNVERIFIED),
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(unanswered),
    );
    const tracker = new DPDTracker({ timeoutMs: 1_000, trawl: null });
    const waiter = new AbortController();
    const owning = tracker.recognizes(TRACKING_NUMBER, { budgetMs: 40 });
    const waiting = tracker.recognizes(TRACKING_NUMBER, { signal: waiter.signal });
    const sharing = tracker.recognizes(TRACKING_NUMBER);
    const installation = fetcher.mock.calls[0]![1]!.signal!;

    // A lookup that stops waiting leaves the login running for the others.
    waiter.abort(new Error('caller cancelled'));
    await expect(waiting).rejects.toMatchObject({ kind: 'indeterminate', cause: { message: 'caller cancelled' } });
    expect(installation.aborted).toBe(false);

    // The login ends with the budget of the lookup that started it. It is not
    // remembered as a failed login: the lookup still waiting logs in itself.
    await expect(owning).rejects.toThrow();
    expect(installation.aborted).toBe(true);
    await expect(sharing).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('ends on the budget without trying the page once the guest API has used it up', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(unanswered);
    const { recorder, steps } = recordingRecorder();

    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: null, recorder }).fetch(TRACKING_NUMBER, '', { budgetMs: 40 }))
      .rejects.toMatchObject({ kind: 'budget' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([['direct', 'budget']]);
  });

  it.each([
    ['a 404', () => new Response('', { status: 404 })],
    ['a 400 typed PARCEL_NOT_FOUND', () => refusal('PARCEL_NOT_FOUND')],
  ])('keeps a positive unknown parcel, %s, out of the page fallback', async (_, reply) => {
    const fetcher = mockGuestApi(reply());
    const { recorder, steps } = recordingRecorder();

    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: null, recorder }).fetch(TRACKING_NUMBER))
      .rejects.toBeInstanceOf(DPDTrackingError);

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([['direct', 'not_found']]);
  });

  it('reads PARCEL_NOT_FOUND only from the lookup without a postcode', async () => {
    const fetcher = mockGuestApi(refusal('PARCEL_NOT_FOUND')).mockResolvedValueOnce(refusal('PARCEL_NOT_FOUND'));

    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: null }).fetch(TRACKING_NUMBER, '8000'))
      .rejects.toBeInstanceOf(DPDTrackingError);

    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(String(fetcher.mock.calls[3]?.[0])).toContain('dataForVerification=8000');
    expect(String(fetcher.mock.calls[4]?.[0])).toContain('continueWithoutVerification=true');
  });

  it('asks for a browser solver when the page itself is challenged', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<html>maintenance</html>'))
      .mockResolvedValueOnce(new Response('<title>Just a moment...</title>', {
        status: 403, headers: { 'CF-Mitigated': 'challenge' },
      }));

    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: null }).fetch(TRACKING_NUMBER))
      .rejects.toThrow('configure FLARESOLVERR_URL');
  });

  it('solves the page through the browser service when one is configured', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<html>maintenance</html>'))
      .mockResolvedValueOnce(Response.json({
        status: 'ok',
        solution: {
          status: 200,
          response: `<html><body><div>${TRACKING_NUMBER}</div>
            <li class="content-item-track"><span class="entry-date">15.07.2026</span>
            <span class="entry-body">Parcel handed to DPD</span></li></body></html>`,
        },
      }));

    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: new TrawlClient('http://trawl.internal:8191') })
      .fetch(TRACKING_NUMBER)).resolves.toMatchObject({ status: 'in_transit' });

    expect(String(fetcher.mock.calls[1]?.[0])).toBe('http://trawl.internal:8191/v1');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      cmd: 'request.get',
      maxTimeout: 1_000,
    });
  });

  it('reports a Cloudflare challenge with the shared challenge status', () => {
    expect(new DPDChallengeError()).toMatchObject({ kind: 'challenge', status: 403, provider: 'DPD' });
  });
});

describe('DPD pickup shop address', () => {
  /** A tracker whose shop records answer `shop`; its timeout leaves room for the lookup. */
  function shopTracker(shop: (id: string, options: { signal: AbortSignal; timeoutMs: number }) => Promise<typeof SHOP | undefined>, timeoutMs = 10_000) {
    const parcelShop = vi.fn(shop);
    return { parcelShop, tracker: new DPDTracker({ timeoutMs, trawl: null, shops: { parcelShop } }) };
  }

  it('adds the address of the shop holding the parcel to its name', async () => {
    mockGuestApi(Response.json(awaitingShop()));
    const { parcelShop, tracker } = shopTracker(async () => SHOP);

    const result = await tracker.fetch(TRACKING_NUMBER, '8000');

    // The verified reply names no shop: the shop's record does.
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'Kiosk Example\nEXAMPLE STREET 1\n0000 EXAMPLE TOWN' });
    expect(parcelShop).toHaveBeenCalledOnce();
    const [id, options] = parcelShop.mock.calls[0]!;
    expect(id).toBe('CH00001');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    // The lookup keeps a moment to answer without the address.
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(5_000);
    expect(JSON.stringify(result)).not.toMatch(/Private|CH00001/);

    // A shop the reply names keeps that name.
    mockGuestApi(Response.json({ ...awaitingShop(), pickupPoint: { name: 'Pickup parcelshop Zürich Wiedikon' } }));
    await expect(shopTracker(async () => SHOP).tracker.fetch(TRACKING_NUMBER, '8000')).resolves.toMatchObject({
      pickup_point: 'Pickup parcelshop Zürich Wiedikon\nEXAMPLE STREET 1\n0000 EXAMPLE TOWN',
    });
  });

  it('keeps the result as it was without the shop record', async () => {
    mockGuestApi(Response.json(awaitingShop()));
    const unaddressed = await shopTracker(async () => undefined).tracker.fetch(TRACKING_NUMBER, '8000');
    expect(unaddressed.current_stage).toBe('ready_for_pickup');
    expect(unaddressed.pickup_point).toBeUndefined();

    mockGuestApi(Response.json({ ...awaitingShop(), pickupPoint: { name: 'Pickup parcelshop Zürich Wiedikon' } }));
    await expect(shopTracker(async () => undefined).tracker.fetch(TRACKING_NUMBER, '8000'))
      .resolves.toMatchObject({ pickup_point: 'Pickup parcelshop Zürich Wiedikon' });

    // A record without a name adds nothing to a reply without one.
    mockGuestApi(Response.json(awaitingShop()));
    expect((await shopTracker(async () => ({ ...SHOP, name: '' })).tracker.fetch(TRACKING_NUMBER, '8000')).pickup_point)
      .toBeUndefined();
  });

  it.each([
    ['a parcel no longer waiting', awaitingShop(undefined, 'DELIVERED'), 10_000, 'delivered'],
    ['a parcel the sender dropped off at a shop', awaitingShop([
      { ...OUT_SCAN, time: '18:05:12', eventType: 'ORI', translation: 'Your parcel arrived at our depot' }, SHOP_SCAN,
    ]), 10_000, 'ready_for_pickup'],
    ['a reply without a shop scan', awaitingShop([OUT_SCAN]), 10_000, 'ready_for_pickup'],
    ['a shop id of another shape', awaitingShop([{ ...SHOP_SCAN, pudoId: 'shop 1' }]), 10_000, 'ready_for_pickup'],
    ['an unverified reply', { ...DELIVERED_UNVERIFIED, status: awaitingShop().status }, 10_000, 'ready_for_pickup'],
    ['a lookup without time to wait for it', awaitingShop(), 1_000, 'ready_for_pickup'],
  ])('does not ask for a shop record for %s', async (_, payload, timeoutMs, stage) => {
    mockGuestApi(Response.json(payload));
    const { parcelShop, tracker } = shopTracker(async () => SHOP, timeoutMs);

    const result = await tracker.fetch(TRACKING_NUMBER, '8000');

    expect(result.current_stage).toBe(stage);
    expect(parcelShop).not.toHaveBeenCalled();
    expect(result.pickup_point).toBeUndefined();
  });

  it('ends a lookup cancelled while it waits for the shop record', async () => {
    mockGuestApi(Response.json(awaitingShop()));
    const controller = new AbortController();
    const { tracker } = shopTracker((_id, { signal }) => {
      controller.abort(new Error('caller cancelled'));
      return Promise.reject(signal.reason as Error);
    });

    await expect(tracker.fetch(TRACKING_NUMBER, '8000', { signal: controller.signal })).rejects.toThrow();
  });
});

describe('DPD adapter factory', () => {
  it('declares both tiers and forwards the postcode as the tracking credential', async () => {
    const fetcher = mockGuestApi(Response.json(READY_FOR_COLLECTION));
    const { recorder } = recordingRecorder();
    const instance = adapter({
      trawl: null, browserExecutablePath: null, recorder, env: {},
    });

    expect(instance.id).toBe('dpd');
    expect(instance.steps).toEqual(['direct', 'page']);
    await expect(instance.track({ number: TRACKING_NUMBER, postcode: '8000' }))
      .resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(String(fetcher.mock.calls[3]?.[0])).toContain('dataForVerification=8000');
  });

  it('signs in with the pinned key', async () => {
    const { recorder } = recordingRecorder();
    const pinned = mockGuestApi(Response.json(READY_FOR_COLLECTION));
    await adapter({ trawl: null, browserExecutablePath: null, recorder, env: {} })
      .track({ number: TRACKING_NUMBER, postcode: '8000' });
    expect(new Headers(pinned.mock.calls[0]?.[1]?.headers).get('X-Goog-Api-Key')).toMatch(/^AIza/);
  });

  it("reads the shop's record from the German DPD app's service through the host's transport, over the process's session", async () => {
    const soap = (operation: string, result: string) => new Response('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
      + `<soap:Body><${operation}Response xmlns="https://cloud.dpd.com/"><${operation}Result><Ack>true</Ack>${result}`
      + `</${operation}Result></${operation}Response></soap:Body></soap:Envelope>`, { headers: { 'content-type': 'text/xml' } });
    const replies: Record<string, () => Response> = {
      getSessionFullState: () => soap('getSessionFullState', '<SessionFullState><SessionToken>U1lOVEhFVElDX1NFU1NJT04=</SessionToken></SessionFullState>'),
      getParcelShopByID: () => soap('getParcelShopByID', '<ParcelShop><ShopAddress><Company>Kiosk Example</Company><Street>EXAMPLE STREET</Street>'
        + '<HouseNo>1</HouseNo><ZipCode>0000</ZipCode><City>EXAMPLE TOWN</City></ShopAddress><PUDOID>CH00001</PUDOID></ParcelShop>'),
    };
    const guest = mockGuestApi(Response.json(awaitingShop()), vi.fn<typeof fetch>());
    const operations: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url) !== DPD_DE_APP_API) return guest(url, init);
      const operation = /\/(\w+)"$/.exec(new Headers(init?.headers).get('SOAPAction') ?? '')![1]!;
      operations.push(operation);
      return replies[operation]!();
    };
    const track = () => adapter({ trawl: null, browserExecutablePath: null, recorder: recordingRecorder().recorder, env: {}, fetcher })
      .track({ number: TRACKING_NUMBER, postcode: '8000' });

    const result = await track();

    expect(result.pickup_point).toBe('Kiosk Example\nEXAMPLE STREET 1\n0000 EXAMPLE TOWN');
    expect(operations).toEqual(['getSessionFullState', 'getParcelShopByID']);
    expect(guest).toHaveBeenCalledTimes(4);
    // Another registry's adapter, over the same transport, reads with the same session.
    mockGuestApi(Response.json(awaitingShop()), guest);
    expect((await track()).pickup_point).toBe(result.pickup_point);
    expect(operations).toEqual(['getSessionFullState', 'getParcelShopByID', 'getParcelShopByID']);
  });
});

describe('DPD transient read retry', () => {
  it('retries a parcel-details 503 once without repeating authentication', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetcher = mockGuestApi(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json(READY_FOR_COLLECTION));
    await expect(new DPDTracker({ timeoutMs: 5_000, trawl: null }).fetch(TRACKING_NUMBER))
      .resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(String(fetcher.mock.calls[3]![0])).toEqual(String(fetcher.mock.calls[4]![0]));
  });
  it('does not spend the retry delay when the request budget is nearly exhausted', async () => {
    const fetcher = mockGuestApi(new Response('', { status: 503 }));
    const { recorder, steps } = recordingRecorder();
    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: new TrawlClient('http://browser.invalid:8191'), recorder })
      .fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'maintenance', status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(steps.map(step => step.step)).toEqual(['direct']);
  });
  it('ends a persistent details 503 after one retry without trying the page', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetcher = mockGuestApi(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    const { recorder, steps } = recordingRecorder();
    await expect(new DPDTracker({ timeoutMs: 5_000, trawl: new TrawlClient('http://browser.invalid:8191'), recorder })
      .fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'maintenance', status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(steps.map(step => step.step)).toEqual(['direct']);
  });
  it.each([0, 1, 2])('ends a 503 at login step %s without trying the page', async (step) => {
    const fetcher = mockGuestApi(Response.json(READY_FOR_COLLECTION));
    const responses = [
      Response.json({ fid: 'synthetic', authToken: { token: 'synthetic', expiresIn: '604800s' } }),
      Response.json({ entries: { basic_dpd_token: 'c3ludGhldGlj' } }),
      Response.json({ access_token: 'synthetic', expires_in: 3600 }),
    ];
    fetcher.mockReset();
    for (const response of responses.slice(0, step)) fetcher.mockResolvedValueOnce(response);
    fetcher.mockResolvedValueOnce(new Response('', { status: 503 }));
    const { recorder, steps } = recordingRecorder();
    await expect(new DPDTracker({ timeoutMs: 1_000, trawl: new TrawlClient('http://browser.invalid:8191'), recorder })
      .fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'maintenance', status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(step + 1);
    expect(steps.map(record => record.step)).toEqual(['direct']);
  });
});
