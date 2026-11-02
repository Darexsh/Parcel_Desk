import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { IndeterminateError, InvalidInputError, NotFoundError } from '../../core/errors/index.js';
import { resolveResult } from '../../core/result/resolve.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { STATUS_HOLD_MS, UPSStatusHeldError, UPSTracker, parseUPSTrackingHtml, parseUPSTrackingResponse, upsTrackingUrl } from './adapter.js';
import statuses from './statuses.json' with { type: 'json' };
import { UPS_PROGRESS_STATUS, upsActivityStage, upsStatus } from './status.js';

// 1Z999AA10123456784 is a made-up number in UPS's published format; it is the
// same value numbers.json records as synthetic. No real shipment, recipient or
// session cookie appears in this file.
const TRACKING_NUMBER = '1Z999AA10123456784';
// The same number with a check digit that does not match.
const BAD_CHECK_DIGIT = '1Z999AA10123456785';
// A made-up 26-digit USPS package number with a valid check digit.
const POSTAL_PIC = '92612900000000000000123454';
const STATUS_API = 'https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US';
const TRAWL_URL = 'http://trawl.internal:8191';
const OUT_FOR_DELIVERY = JSON.parse(
  readFileSync(new URL('./fixtures/out-for-delivery.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;
// The day the fixture's scans happen on, so the year-less scheduled delivery
// date resolves without rolling into the next year.
const TODAY = new Date('2026-08-04T06:00:00Z');
/** UPS's successful reply for a number it has no record of: expired, or not active yet. */
const UNKNOWN_NUMBER = JSON.stringify({
  statusCode: '200', statusText: 'Successful',
  trackDetails: [{
    errorCode: '504', errorText: 'Tracking number not found in database',
    requestedTrackingNumber: TRACKING_NUMBER, trackingNumber: TRACKING_NUMBER,
  }],
});
/** A successful reply whose parcel carries one of the error codes UPS's page reads as an outage. */
function outage(errorCode: string, trackingNumber?: string): string {
  return JSON.stringify({
    statusCode: '200', statusText: 'Successful',
    trackDetails: [{ errorCode, errorText: 'Example outage text', ...(trackingNumber ? { trackingNumber } : {}) }],
  });
}
const RENDERED_PAGE = `
  <html><head><meta name="stapp-tracknum" content="${TRACKING_NUMBER}"></head>
  <body>
    <span id="stApp_nameKey">Delivered <span>check_circle</span></span>
    <p id="stApp_deliveredToAddress">ZUERICH CH</p>
  </body></html>
`;

function fixture(): Record<string, unknown> {
  return structuredClone(OUT_FOR_DELIVERY);
}

/** A synthetic page that establishes the direct session's test cookie. */
function directPage(url: string): Response {
  const page = new Response(RENDERED_PAGE, { headers: { 'Set-Cookie': 'X-XSRF-TOKEN-ST=token; Domain=ups.com; Path=/' } });
  Object.defineProperty(page, 'url', { value: url });
  return page;
}

/** One synthetic scan; `utc` is the UTC pair UPS sends as `gmtDate` / `gmtTime`. */
function scan(actCode: string, activityScan: string, utc: string | null, location = 'EXAMPLE CITY, DE'): Record<string, unknown> {
  return {
    actCode, activityScan, location,
    ...(utc ? { gmtDate: utc.slice(0, 8), gmtTime: utc.slice(9), gmtOffset: '+02:00' } : {}),
  };
}

/** The fixture's parcel with other scans and package fields. */
function withScans(activities: Record<string, unknown>[], detail: Record<string, unknown> = {}): Record<string, unknown> {
  const payload = fixture();
  const [first] = payload.trackDetails as Record<string, unknown>[];
  Object.assign(first!, { scheduledDeliveryDateDetail: null, shipmentProgressActivities: activities }, detail);
  return payload;
}

const ACCESS_POINT = {
  locationType: 'Retail store',
  location: {
    companyName: 'EXAMPLE KIOSK',
    attentionName: 'PRIVATE ATTENTION NAME',
    streetAddress1: 'EXAMPLESTR. 1',
    streetAddress2: '',
    streetAddress3: '',
    city: 'EXAMPLE CITY',
    state: '',
    province: '',
    zipCode: '00000',
    country: 'DE',
  },
  dailyHoursOfOperations: { Monday: 'PRIVATE HOURS' },
  geoLatitude: '1.2345',
  geoLongitude: '2.3456',
};
const KIOSK = 'EXAMPLE KIOSK\nEXAMPLESTR. 1\n00000 EXAMPLE CITY';

function stepRecorder(): { recorder: StepRecorder; records: string[] } {
  const records: string[] = [];
  return {
    records,
    recorder: {
      step: (record) => records.push(`${record.step}:${record.outcome}`),
      lookup: (record) => records.push(`lookup:${record.finalStep}:${record.outcome}`),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('UPS status vocabulary', () => {
  it('maps every activity code statuses.json records, and nothing else', () => {
    const codes = statuses.entries.flatMap((entry) => 'code' in entry && /^[0-9A-Z]{2}$/.test(entry.code ?? '')
      ? [{ code: entry.code!, stage: entry.stage }] : []);
    expect(codes.length).toBeGreaterThan(30);
    for (const { code, stage } of codes) expect(upsActivityStage(code), code).toBe(stage);
    for (const code of ['', 'XX', 'constructor', 'toString', '__proto__']) expect(upsActivityStage(code)).toBeUndefined();
  });

  it('maps the progress token, the prose, and nothing else', () => {
    expect(UPS_PROGRESS_STATUS.outfordelivery).toBe('out_for_delivery');
    expect(UPS_PROGRESS_STATUS.manifestupload).toBe('pending');
    expect(upsStatus('Returned to Sender')).toBe('exception');
    expect(upsStatus('Your package was left at the front door')).toBe('delivered');
    // A delivery still to come is none.
    expect(upsStatus('Your package will be delivered one business day later than expected.', true)).toBe('in_transit');
    expect(upsStatus('Label Created')).toBe('pending');
    // Unrecognized wording only means "moving" once the shipment has scans.
    expect(upsStatus('Wording UPS has not used before')).toBe('unknown');
    expect(upsStatus('Wording UPS has not used before', true)).toBe('in_transit');
  });
});

describe('UPS structured response', () => {
  it('accepts scalar success codes and rejects structured codes', () => {
    expect(parseUPSTrackingResponse({ ...fixture(), statusCode: 200 }, TRACKING_NUMBER, TODAY).status).toBe('out_for_delivery');
    for (const statusCode of [[200], { value: 200 }]) {
      expect(() => parseUPSTrackingResponse({ ...fixture(), statusCode }, TRACKING_NUMBER, TODAY)).toThrow(IndeterminateError);
    }
  });

  it('projects the scan history, each scan on its place\'s clock to the second', () => {
    const result = parseUPSTrackingResponse(fixture(), TRACKING_NUMBER, TODAY);
    expect(result).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'out_for_delivery',
      current_stage_source: 'carrier_map',
      last_status_text: 'Out For Delivery Today',
      last_update: '2026-08-04T09:12:04+02:00',
      expected_delivery: '2026-08-04',
      destination_country: 'CH',
    });
    const mapped = { stage_source: 'carrier_map' };
    expect(result.events).toEqual([
      {
        time: '2026-08-04T09:12:04+02:00', location: 'Zuerich, Switzerland', description: 'Out For Delivery Today',
        provider_code: 'OT', stage: 'out_for_delivery', ...mapped,
      },
      {
        time: '2026-08-04T05:03:51+02:00', location: 'Zuerich, Switzerland', description: 'Arrived at Facility',
        provider_code: 'AR', stage: 'in_transit', ...mapped,
      },
      {
        time: '2026-08-03T23:41:10+02:00',
        location: 'Koeln, Germany',
        description: 'Departed from Facility — Your package is on the way',
        provider_code: 'DP', stage: 'in_transit', ...mapped,
      },
    ]);
  });

  it('keeps a scan in UTC unless its local reading agrees with the stated offset', () => {
    const clocked = (date: string, time: string, gmtTime: string, gmtOffset: string) => ({
      actCode: 'AR', activityScan: 'Arrived at Facility', location: 'EXAMPLE CITY, US',
      date, time, gmtDate: '20260804', gmtTime, gmtOffset,
    });
    const times = parseUPSTrackingResponse(withScans([
      clocked('08/03/2026', '11:05 P.M.', '04:05:09', '-05:00'),
      // The local reading is another minute than the UTC pair on the offset.
      clocked('08/04/2026', '9:00 A.M.', '04:05:09', '+02:00'),
      clocked('08/04/2026', '4:05 A.M.', '04:05:09', '+00:00'),
      clocked('08/04/2026', '9:35 A.M.', '04:05:09', '+05:30'),
    ]), TRACKING_NUMBER, TODAY).events?.map((event) => event.time);
    expect(times).toEqual(['2026-08-03T23:05:09-05:00', '2026-08-04T04:05:09+00:00', '2026-08-04T04:05:09+00:00',
      '2026-08-04T09:35:09+05:30']);
    // The instant is the UTC pair's, so a scan stored in UTC is the same scan.
    expect(new Set(times!.map((time) => Date.parse(time!)))).toEqual(new Set([Date.parse('2026-08-04T04:05:09Z')]));
  });

  it("dates a scan on its place's clock when UPS states the offset the place keeps in the other season", () => {
    const delivered = (location: string, date: string, time: string, gmtDate: string, gmtTime: string, gmtOffset: string) => ({
      actCode: 'KB', activityScan: 'DELIVERED', location, date, time, gmtDate, gmtTime, gmtOffset,
    });
    const events = parseUPSTrackingResponse(withScans([
      // France keeps +01:00 after the clocks go back, and the United Kingdom +00:00.
      delivered('DIJON, FR', '10/27/2026', '5:39 P.M.', '20261027', '15:39:50', '+02:00'),
      delivered('EXAMPLE CITY, GB', '10/27/2026', '5:39 P.M.', '20261027', '16:39:50', '+01:00'),
      // The United Kingdom keeps +01:00 after the clocks go forward.
      delivered('EXAMPLE CITY, GB', '03/30/2026', '5:39 P.M.', '20260330', '17:39:50', '+00:00'),
      // Offsets the place keeps then.
      delivered('DIJON, FR', '08/04/2026', '5:39 P.M.', '20260804', '15:39:50', '+02:00'),
      delivered('DIJON, FR', '10/27/2026', '5:39 P.M.', '20261027', '16:39:50', '+01:00'),
      // The Canary Islands keep Madrid's winter offset in summer, so Spain's clock is not deduced.
      delivered('LAS PALMAS, ES', '08/04/2026', '5:39 P.M.', '20260804', '16:39:50', '+01:00'),
      // A country spanning several zones names none.
      delivered('EXAMPLE CITY, US', '10/27/2026', '5:39 P.M.', '20261027', '22:39:50', '-05:00'),
    ]), TRACKING_NUMBER, new Date('2026-10-28T00:00:00Z')).events;
    expect(events?.map(({ time, local_time, time_zone, time_zone_basis }) => ({ time, local_time, time_zone, time_zone_basis }))).toEqual([
      { time: '2026-10-27T17:39:50+01:00', local_time: '2026-10-27T17:39:50', time_zone: 'Europe/Paris', time_zone_basis: 'place' },
      { time: '2026-10-27T17:39:50+00:00', local_time: '2026-10-27T17:39:50', time_zone: 'Europe/London', time_zone_basis: 'place' },
      { time: '2026-03-30T17:39:50+01:00', local_time: '2026-03-30T17:39:50', time_zone: 'Europe/London', time_zone_basis: 'place' },
      { time: '2026-08-04T17:39:50+02:00', local_time: undefined, time_zone: undefined, time_zone_basis: undefined },
      { time: '2026-10-27T17:39:50+01:00', local_time: undefined, time_zone: undefined, time_zone_basis: undefined },
      { time: '2026-08-04T17:39:50+01:00', local_time: undefined, time_zone: undefined, time_zone_basis: undefined },
      { time: '2026-10-27T17:39:50-05:00', local_time: undefined, time_zone: undefined, time_zone_basis: undefined },
    ]);
  });

  it('lets the newest scan code outrank the progress token', () => {
    // A Ground Saver delay: UPS's token reads Exception, the parcel is moving.
    const delayed = parseUPSTrackingResponse(withScans([
      scan('ZW', 'Package moving to local post office', '20260806 15:50:00'),
      scan('Q5', 'We&#39;re sorry this package may experience a temporary delay.', '20260805 19:22:00'),
      scan('MP', 'Shipper created a label, UPS has not received the package yet. ', null, 'United States'),
    ], { progressBarType: 'Exception', packageStatus: 'Update' }), TRACKING_NUMBER, TODAY);
    expect(delayed).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', expected_delivery: null });
    expect(delayed.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['ZW', 'in_transit'], ['Q5', 'in_transit'], ['MP', 'registered'],
    ]);
    expect(delayed.events?.[1]?.description).toBe("We're sorry this package may experience a temporary delay.");
    expect(delayed.delivered_at).toBeUndefined();

    // A failed attempt is not a delivery, whatever the token says.
    expect(parseUPSTrackingResponse(withScans([
      scan('G3', 'We tried to deliver to the business, but it was closed.', '20260903 16:21:12'),
      scan('OT', 'Out For Delivery Today', '20260903 07:26:42'),
    ], { progressBarType: 'OutForDelivery' }), TRACKING_NUMBER, TODAY))
      .toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    // The final attempt failed too; a hold, an access point or a return comes as its own scan.
    expect(parseUPSTrackingResponse(withScans([
      scan('49', 'The receiver was not available at the time of the final delivery attempt.', '20260905 15:02:10'),
      scan('OT', 'Out For Delivery Today', '20260905 07:31:02'),
      scan('48', 'The receiver was not available for delivery. We&#39;ll make a second attempt the next business day.', '20260904 14:40:51'),
    ], { progressBarType: 'Exception' }), TRACKING_NUMBER, TODAY))
      .toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map' });

    // A wrong receiver or company name holds the delivery until UPS has the right one.
    expect(parseUPSTrackingResponse(withScans([
      scan('AD', 'The company or receiver name is incorrect. This will delay delivery. We&#39;re attempting to update this information.', '20260905 14:25:10'),
      scan('OT', 'Out For Delivery Today', '20260905 06:53:02'),
    ], { progressBarType: 'Exception' }), TRACKING_NUMBER, TODAY))
      .toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });

    // A code the map does not know leaves the stage to the shared classifier.
    const unmapped = parseUPSTrackingResponse(withScans([
      scan('X9', 'Wording UPS has not used before', '20260806 15:50:00'),
      scan('AR', 'Arrived at Facility', '20260806 10:00:00'),
    ], { progressBarType: 'InTransit' }), TRACKING_NUMBER, TODAY);
    expect(unmapped).toMatchObject({ status: 'in_transit' });
    expect(unmapped.current_stage).toBeUndefined();
    expect(unmapped.events?.[0]).toEqual({
      time: '2026-08-06T15:50:00+00:00', location: 'Example City, Germany',
      description: 'Wording UPS has not used before', provider_code: 'X9',
    });
  });

  it("reads the receiver's delivery instructions as a notice, so the newest other scan decides", () => {
    // Seen weeks after the label, while UPS had only the label: the progress token still read in transit.
    const instructed = parseUPSTrackingResponse(withScans([
      scan('L0', 'Delivery instructions have been provided by the receiver.', '20260930 23:11:14'),
      scan('MP', 'Shipper created a label, UPS has not received the package yet. ', '20260909 10:43:57', 'United States'),
    ], { progressBarType: 'InTransit' }), TRACKING_NUMBER, TODAY);
    expect(instructed).toMatchObject({ status: 'pending', current_stage: 'registered',
      last_status_text: 'Shipper created a label, UPS has not received the package yet.', last_update: instructed.events?.[0]?.time });
    // The notice keeps the label's stage, so the app does not read it as news that the parcel moves.
    expect(instructed.events?.map((event) => [event.provider_code, event.stage, event.stage_source]))
      .toEqual([['L0', 'registered', 'none'], ['MP', 'registered', 'carrier_map']]);
    expect(statusMapAnswer({ carrier: 'ups', providerCode: 'L0', description: 'delivery instructions have been provided by the receiver.' }))
      .toMatchObject({ kind: 'intentional_gap', note: expect.stringContaining('keeps the stage of the scan before it') });
    // A receiver's Saturday delivery, and a delivery home rather than to the access point, are new plans.
    for (const [code, description] of [['RF', 'Saturday Delivery has been requested. / Delivery will be rescheduled for Saturday.'],
      ['VM', "We will deliver the package to the original receiver's address as the receiver requested."]]) {
      expect(statusMapAnswer({ carrier: 'ups', providerCode: code!, description: description! })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    // On a moving parcel the scan before it keeps the parcel in transit.
    const moving = parseUPSTrackingResponse(withScans([
      scan('L0', 'Delivery instructions have been provided by the receiver.', '20260806 18:00:00'),
      scan('AR', 'Arrived at Facility', '20260806 10:00:00'),
    ], { progressBarType: 'InTransit' }), TRACKING_NUMBER, TODAY);
    expect(moving).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(moving.events?.[0]).toMatchObject({ stage: 'in_transit', stage_source: 'none' });
    // A notice with no scan before it has no stage to keep.
    expect(parseUPSTrackingResponse(withScans([
      scan('L0', 'Delivery instructions have been provided by the receiver.', '20260806 18:00:00'),
    ]), TRACKING_NUMBER, TODAY).events?.[0]?.stage).toBeUndefined();
  });

  it('reads a pickup after the delivery leg, from an access point, as transit', () => {
    const collected = parseUPSTrackingResponse(withScans([
      scan('VM', "We will deliver the package to the original receiver's address as the receiver requested.", '20261029 18:38:47'),
      scan('PU', 'Pickup Scan', '20261029 15:20:13'),
      scan('2Q', 'Delivered to UPS Access Point™', '20261028 13:53:07'),
      scan('5R', "We were unable to deliver your package. It's on the way to a secure UPS Access Point™ location.", '20261028 11:51:33'),
      scan('OT', 'Out For Delivery Today', '20261028 07:50:33'),
      scan('AR', 'Arrived at Facility', '20261027 10:23:00'),
      scan('PU', 'Pickup Scan', '20261026 13:14:15'),
    ]), TRACKING_NUMBER, TODAY);
    expect(collected).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(collected.events?.map((event) => [event.provider_code, event.stage]))
      .toEqual([['VM', 'in_transit'], ['PU', 'in_transit'], ['2Q', 'ready_for_pickup'], ['5R', 'failed_attempt'],
        ['OT', 'out_for_delivery'], ['AR', 'in_transit'], ['PU', 'accepted']]);
  });

  it("writes a delivery's place in capitals and codes as the page writes its other scans'", () => {
    const places = (...locations: string[]) => parseUPSTrackingResponse(withScans(locations.map((location, index) =>
      scan(index ? 'AR' : 'KB', index ? 'Arrived at Facility' : 'Delivered', `2026080${6 - index} 15:50:00`, location))), TRACKING_NUMBER, TODAY)
      .events?.map((event) => event.location);
    expect(places('EXAMPLE CITY (NORTH), DE', 'Example City, Germany')).toEqual(['Example City (North), Germany', 'Example City, Germany']);
    expect(places('SAMPLE-TOWN, NY, US', 'Sample-Town, NY, United States')).toEqual(['Sample-Town, NY, United States', 'Sample-Town, NY, United States']);
    // Nothing else is rewritten: a place with no country code, or one already in lower case.
    expect(places('FRONT DOOR', 'Example City, DE')).toEqual(['FRONT DOOR', 'Example City, DE']);
  });

  it('reads the preparation for clearance, duties to pay, and the hold until they are paid, as customs', () => {
    const held = parseUPSTrackingResponse(withScans([
      scan('OQ', 'Your package is being held until duties and taxes are paid. Awaiting customer action.', '20260807 09:33:49'),
      scan('7F', 'Duties or taxes are due on this package.', '20260807 09:12:07'),
      scan('Z1', 'Your package is prepared for clearance.', '20260806 18:20:00'),
      scan('AR', 'Arrived at Facility', '20260806 10:00:00'),
    ], { progressBarType: 'Exception' }), TRACKING_NUMBER, TODAY);
    expect(held).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map' });
    expect(held.events?.map((event) => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['OQ', 'customs', 'carrier_map'], ['7F', 'customs', 'carrier_map'], ['Z1', 'customs', 'carrier_map'],
      ['AR', 'in_transit', 'carrier_map'],
    ]);
    // Duties to pay ask the receiver to act, whatever words UPS adds to the code.
    expect(held.events?.map((event) => event.recipient_action ?? null)).toEqual(['duties', 'duties', null, null]);
    const worded = parseUPSTrackingResponse(withScans([
      { ...scan('7F', 'Des droits ou taxes sont dus', '20260807 09:12:07'), activityAdditionalDescription: 'Payez en ligne' },
    ]), TRACKING_NUMBER, TODAY);
    expect(worded.events?.[0]).toMatchObject({ provider_code: '7F', recipient_action: 'duties' });
  });

  it('reads the clearing agency\'s scan, which UPS sends without a code, as customs by its whole wording', () => {
    // Live shape: the customs broker's note has an empty actCode and no location.
    const broker = scan('', 'The package is at the clearing agency awaiting final release.', '20260807 11:41:00', '');
    const held = parseUPSTrackingResponse(withScans([broker, scan('AR', 'Arrived at Facility', '20260806 10:00:00')],
      { progressBarType: 'InTransit' }), TRACKING_NUMBER, TODAY);
    expect(held).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map' });
    expect(held.events?.[0]).toEqual({
      time: '2026-08-07T11:41:00+00:00', location: '', description: 'The package is at the clearing agency awaiting final release.',
      stage: 'customs', stage_source: 'carrier_map',
    });
    // The parcel app asks the map about the scan it stored without a code.
    expect(statusMapAnswer({ carrier: 'ups', providerCode: null, description: 'the package is at the clearing agency awaiting final release.' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
    // Other wording without a code stays with the shared classifier, and a code is still read by itself.
    expect(statusMapAnswer({ carrier: 'ups', providerCode: null, description: 'Your package is being held by the clearing agency.' }))
      .toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'ups', providerCode: 'X9', description: 'The package is at the clearing agency awaiting final release.' }))
      .toEqual({ kind: 'unknown' });
  });

  it('names the access point and its address only while the parcel waits there', () => {
    const waiting = parseUPSTrackingResponse(withScans([
      scan('ZP', 'UPS Access Point&#8482; possession ', '20260811 09:22:52'),
      scan('2Q', 'Delivered to UPS Access Point&#8482; ', '20260811 09:22:39'),
      scan('ZC', 'The package will be delivered to the UPS Access Point&#8482; location requested by the receiver.', '20260810 16:22:20'),
    ], { progressBarType: 'Delivered', upsAccessPoint: ACCESS_POINT }), TRACKING_NUMBER, TODAY);
    expect(waiting).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'ready_for_pickup',
      pickup_point: KIOSK,
      last_status_text: 'UPS Access Point™ possession',
    });
    expect(waiting.delivered_at).toBeUndefined();
    expect(waiting.events?.map((event) => event.stage)).toEqual(['ready_for_pickup', 'ready_for_pickup', 'in_transit']);

    const collected = parseUPSTrackingResponse(withScans([
      scan('2W', 'DELIVERED ', '20260811 10:14:47'),
      scan('ZP', 'UPS Access Point™ possession ', '20260811 09:22:52'),
    ], { progressBarType: 'Delivered', upsAccessPoint: ACCESS_POINT }), TRACKING_NUMBER, TODAY);
    expect(collected).toMatchObject({
      status: 'delivered', current_stage: 'delivered', delivered_at: '2026-08-11T10:14:47+00:00', expected_delivery: null,
    });
    expect(collected.pickup_point).toBeUndefined();

    // A suggested access point on a parcel still on its way is not a pickup point.
    const suggested = parseUPSTrackingResponse(withScans([scan('AR', 'Arrived at Facility', '20260806 10:00:00')],
      { upsAccessPoint: ACCESS_POINT }), TRACKING_NUMBER, TODAY);
    expect(suggested.pickup_point).toBeUndefined();
    // Without a business name the point stays unnamed: the attention name can be a person's.
    const unnamed = parseUPSTrackingResponse(withScans([scan('ZP', 'UPS Access Point™ possession ', '20260811 09:22:52')],
      { upsAccessPoint: { ...ACCESS_POINT, location: { ...ACCESS_POINT.location, companyName: '' } } }), TRACKING_NUMBER, TODAY);
    expect(unnamed).toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(unnamed.pickup_point).toBeUndefined();
    for (const result of [waiting, collected, suggested, unnamed]) {
      const serialized = JSON.stringify(result);
      for (const value of ['PRIVATE', '1.2345', '2.3456']) expect(serialized).not.toContain(value);
    }
  });

  it("reads UPS's reminder to collect a held parcel as waiting for pickup, not as its return", () => {
    const reminded = parseUPSTrackingResponse(withScans([
      scan('5G', 'Pick up your package soon as it is nearing the maximum hold limit and may be returned to the sender.', '20260813 11:16:56'),
      scan('48', "The receiver was not available for delivery. We'll make a second attempt the next business day.", '20260812 12:39:00'),
    ], { upsAccessPoint: ACCESS_POINT }), TRACKING_NUMBER, TODAY);
    expect(reminded).toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(reminded.events?.map((event) => [event.stage, event.stage_source])).toEqual([
      ['ready_for_pickup', 'carrier_map'], ['failed_attempt', 'carrier_map']]);
    // The reminder does not say where the parcel is held.
    expect(reminded.pickup_point).toBeUndefined();
  });

  it('lays out the access point address as UPS gives it, and keeps the name alone without a street or town', () => {
    const point = (location: Record<string, string>) => parseUPSTrackingResponse(withScans(
      [scan('ZP', 'UPS Access Point™ possession ', '20260811 09:22:52')],
      { upsAccessPoint: { ...ACCESS_POINT, location: { ...ACCESS_POINT.location, ...location } } }), TRACKING_NUMBER, TODAY).pickup_point;
    expect(point({ streetAddress2: 'EXAMPLE MALL', streetAddress3: 'UNIT 2' }))
      .toBe('EXAMPLE KIOSK\nEXAMPLESTR. 1\nEXAMPLE MALL, UNIT 2\n00000 EXAMPLE CITY');
    expect(point({ streetAddress1: '1 EXAMPLE ST', city: 'EXAMPLETOWN', state: 'GA', zipCode: '00000', country: 'US' }))
      .toBe('EXAMPLE KIOSK\n1 EXAMPLE ST\nEXAMPLETOWN, GA 00000');
    expect(point({ streetAddress1: '&#49; EXAMPLE ST', zipCode: '' })).toBe('EXAMPLE KIOSK\n1 EXAMPLE ST\nEXAMPLE CITY');
    expect(point({ streetAddress1: '' })).toBe('EXAMPLE KIOSK');
    expect(point({ city: '' })).toBe('EXAMPLE KIOSK');
  });

  it('keeps scans without a UTC pair on the clock UPS gives, and none when it gives none', () => {
    const result = parseUPSTrackingResponse(withScans([
      { actCode: 'AR', activityScan: 'Arrived at Facility', date: '08/04/2026', time: '12:05 P.M.', gmtOffset: '+02:00' },
      { actCode: 'DP', activityScan: 'Departed from Facility', date: '08/04/2026', time: '12:41 A.M.' },
      { actCode: 'XD', activityScan: 'Drop-Off', date: '08/03/2026' },
      { actCode: 'XD', activityScan: 'Drop-Off', date: '02/30/2026' },
      { actCode: 'MP', activityScan: 'Shipper created a label, UPS has not received the package yet. ' },
    ]), TRACKING_NUMBER, TODAY);
    expect(result.events?.map(({ time, local_time, provider_time_text }) => ({ time, local_time, provider_time_text }))).toEqual([
      { time: '2026-08-04T12:05:00+02:00', local_time: undefined, provider_time_text: undefined },
      { time: undefined, local_time: '2026-08-04T00:41:00', provider_time_text: undefined },
      { time: undefined, local_time: '2026-08-03', provider_time_text: undefined },
      { time: undefined, local_time: undefined, provider_time_text: '02/30/2026' },
      { time: undefined, local_time: undefined, provider_time_text: undefined },
    ]);
    expect(result.events?.every((event) => !('time' in event) || event.time)).toBe(true);
    expect(resolveResult(result).events.map((event) => event.instant)).toEqual(['2026-08-04T12:05:00+02:00', null, null, null, null]);

    const labelOnly = parseUPSTrackingResponse(withScans([
      { actCode: 'MP', activityScan: 'Shipper created a label, UPS has not received the package yet. ' },
    ], { progressBarType: 'ManifestUpload' }), TRACKING_NUMBER, TODAY);
    expect(labelOnly).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: null });
  });

  it('reports a number UPS refuses for its check digit as invalid input', () => {
    const refused = { statusCode: '402', statusText: 'Invalid Request', trackDetails: null };
    expect(() => parseUPSTrackingResponse(refused, BAD_CHECK_DIGIT)).toThrow(InvalidInputError);
    expect(() => parseUPSTrackingResponse(refused, BAD_CHECK_DIGIT)).toThrow(expect.objectContaining({ reason: 'wrong_number' }));
    // A number that passes the check proves nothing by a refusal.
    expect(() => parseUPSTrackingResponse(refused, TRACKING_NUMBER)).toThrow(IndeterminateError);
  });

  it('reports a number UPS has no record of as not found, and only that error', () => {
    const unknown = JSON.parse(UNKNOWN_NUMBER) as { trackDetails: Record<string, unknown>[] };
    expect(() => parseUPSTrackingResponse(unknown, TRACKING_NUMBER)).toThrow(NotFoundError);
    // An error that does not name the number, or another code, keeps the old reading.
    const unnamed = structuredClone(unknown);
    unnamed.trackDetails = [{ errorCode: '504', errorText: 'Tracking number not found in database' }];
    expect(parseUPSTrackingResponse(unnamed, TRACKING_NUMBER)).toMatchObject({ status: 'unknown', events: [] });
    const other = structuredClone(unknown);
    Object.assign(other.trackDetails[0]!, { errorCode: '505', errorText: 'Example error text' });
    expect(parseUPSTrackingResponse(other, TRACKING_NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'Example error text' });
  });

  it('reports the codes UPS reads as an outage as inconclusive, whichever number the reply names', () => {
    const thrown = (payload: unknown): unknown => {
      try {
        parseUPSTrackingResponse(payload, TRACKING_NUMBER, TODAY);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    for (const code of ['298', '299']) {
      const unavailable = { name: 'UPSUnavailableError', kind: 'indeterminate', message: `UPS tracking is temporarily unavailable (error ${code})` };
      expect(thrown({ statusCode: code, statusText: 'Example outage text' })).toMatchObject(unavailable);
      for (const payload of [outage(code, TRACKING_NUMBER), outage(code), outage(code, '1Z999AA10123456793')]) {
        const error = thrown(JSON.parse(payload));
        expect(error).toBeInstanceOf(IndeterminateError);
        expect(error).toMatchObject(unavailable);
      }
    }
  });

  it('keeps the recipient block out of the result', () => {
    const serialized = JSON.stringify(parseUPSTrackingResponse(fixture(), TRACKING_NUMBER, TODAY));
    for (const value of [
      'PRIVATE RECIPIENT', '10 PRIVATE STREET', 'PRIVATE CITY', 'PRIVATE POSTCODE',
      'PRIVATE-SIGNATURE-LINK', 'PRIVATE-PHOTO-LINK', 'receivedBy', 'signatureLink',
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it('names the shipping service without its trademark signs', () => {
    const payload = fixture();
    const [detail] = payload.trackDetails as Record<string, unknown>[];
    expect(parseUPSTrackingResponse(payload, TRACKING_NUMBER, TODAY)).not.toHaveProperty('service_name');
    for (const [serviceName, name] of [['UPS Standard&#174;', 'UPS Standard'], ['UPS Express™ 12:00', 'UPS Express 12:00'],
      ['UPS Ground', 'UPS Ground']]) {
      detail!.additionalInformation = { serviceInformation: { serviceName, serviceLink: null, serviceAttribute: null } };
      expect(parseUPSTrackingResponse(payload, TRACKING_NUMBER, TODAY).service_name).toBe(name);
    }
    for (const serviceInformation of [null, { serviceName: '&#174;' }, { serviceName: 7 }]) {
      detail!.additionalInformation = { serviceInformation };
      expect(parseUPSTrackingResponse(payload, TRACKING_NUMBER, TODAY)).not.toHaveProperty('service_name');
    }
  });

  it('names the USPS number of a parcel handed to the post office, and nothing that is not one', () => {
    const handedOver = (postalServiceTrackingID: unknown) => withScans([
      scan('YC', 'Package delivered by local post office ', '20260804 15:10:00', 'EXAMPLE TOWN, NY, US'),
      scan('YH', 'Received by the local post office', '20260804 07:30:00', 'EXAMPLE TOWN, NY, US'),
      scan('LX', 'Package transferred to post office', '20260803 22:05:00', 'EXAMPLE CITY, NY, US'),
    ], { additionalInformation: { serviceInformation: { serviceName: 'UPS Ground Saver&#174;' }, postalServiceTrackingID } });
    const result = parseUPSTrackingResponse(handedOver(POSTAL_PIC), TRACKING_NUMBER, TODAY);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', delivered_at: '2026-08-04T15:10:00+00:00',
      service_name: 'UPS Ground Saver', delivery_carrier: 'usps', delivery_tracking_number: POSTAL_PIC,
    });
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([['YC', 'delivered'], ['YH', 'in_transit'], ['LX', 'in_transit']]);
    expect(deliveryHandoff('ups', TRACKING_NUMBER, resolveResult(result))).toEqual({ carrier: 'usps', number: POSTAL_PIC, basis: 'partner' });
    // A routing barcode keeps only the package number after its ZIP code.
    expect(parseUPSTrackingResponse(handedOver(`42000000${POSTAL_PIC}`), TRACKING_NUMBER, TODAY).delivery_tracking_number).toBe(POSTAL_PIC);
    for (const id of [null, undefined, '', `${POSTAL_PIC.slice(0, -1)}5`, TRACKING_NUMBER, 'NOT AVAILABLE', { id: POSTAL_PIC }]) {
      const dropped = parseUPSTrackingResponse(handedOver(id), TRACKING_NUMBER, TODAY);
      expect(dropped).not.toHaveProperty('delivery_carrier');
      expect(dropped).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('produces every capability carrier.json declares', () => {
    const result = parseUPSTrackingResponse(fixture(), TRACKING_NUMBER, TODAY);
    expect(CAPABILITIES).toEqual(['history', 'location', 'eta', 'delivered_at', 'pickup_point', 'provider_code', 'service_name',
      'delivery_partner', 'delivery_tracking_number']);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.events?.every((event) => event.provider_code)).toBe(true);
    expect(result.expected_delivery).toBeTruthy();
    expect(parseUPSTrackingResponse(withScans([scan('KB', 'DELIVERED ', '20260804 10:28:15')]), TRACKING_NUMBER, TODAY)
      .delivered_at).toBe('2026-08-04T10:28:15+00:00');
    expect(parseUPSTrackingResponse(withScans([scan('2Q', 'Delivered to UPS Access Point™ ', '20260804 10:28:15')],
      { upsAccessPoint: ACCESS_POINT }), TRACKING_NUMBER, TODAY).pickup_point).toBe(KIOSK);
    const served = fixture();
    Object.assign((served.trackDetails as Record<string, unknown>[])[0]!, { additionalInformation: { serviceInformation: { serviceName: 'UPS Ground' } } });
    expect(parseUPSTrackingResponse(served, TRACKING_NUMBER, TODAY).service_name).toBe('UPS Ground');
    const handed = fixture();
    Object.assign((handed.trackDetails as Record<string, unknown>[])[0]!, { additionalInformation: { postalServiceTrackingID: POSTAL_PIC } });
    expect(parseUPSTrackingResponse(handed, TRACKING_NUMBER, TODAY))
      .toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: POSTAL_PIC });
  });

  it('fails closed on another parcel and reports an unavailable API as inconclusive', () => {
    const other = fixture();
    (other.trackDetails as Record<string, unknown>[])[0]!.trackingNumber = '1Z999AA10123456793';
    expect(() => parseUPSTrackingResponse(other, TRACKING_NUMBER, TODAY))
      .toThrow('UPS did not return the requested parcel');
    // Of several details, only the one that names the number answers.
    const [detail] = fixture().trackDetails as Record<string, unknown>[];
    const unnamed = { ...detail, trackingNumber: undefined, requestedTrackingNumber: undefined };
    expect(() => parseUPSTrackingResponse({ ...fixture(), trackDetails: [unnamed, unnamed] }, TRACKING_NUMBER, TODAY))
      .toThrow('UPS did not return the requested parcel');
    expect(() => parseUPSTrackingResponse({ ...fixture(), trackDetails: [detail, detail] }, TRACKING_NUMBER, TODAY))
      .toThrow('UPS did not return the requested parcel');
    expect(parseUPSTrackingResponse({ ...fixture(), trackDetails: [unnamed, detail] }, TRACKING_NUMBER, TODAY))
      .toEqual(parseUPSTrackingResponse(fixture(), TRACKING_NUMBER, TODAY));
    expect(() => parseUPSTrackingResponse({ statusCode: '500', statusText: 'Unavailable' }, TRACKING_NUMBER))
      .toThrow('Unavailable');
    expect(() => parseUPSTrackingResponse('not an object', TRACKING_NUMBER))
      .toThrow('UPS returned an invalid tracking response');
  });
});

describe('UPS lookup steps', () => {
  it('reports the missing browser service when the direct session is challenged', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<html>challenge</html>', { status: 403 }));
    const { recorder, records } = stepRecorder();

    await expect(new UPSTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawl: null,
      recorder,
    }).fetch(TRACKING_NUMBER)).rejects.toMatchObject({
      name: 'ChallengeError',
      status: 403,
      message: 'UPS challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('ups.com/track');
    expect(records).toEqual(['direct:challenge', 'lookup:direct:challenge']);
  });

  it('leaves the browser 45 seconds by default, so a lookup ends within a minute', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(new UPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch(TRACKING_NUMBER)).rejects.toThrow();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ maxTimeout: 45_000 });
  });

  it('reads the status reply the browser captured instead of replaying its cookies', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      tier: 2,
      statusCode: 200,
      url: upsTrackingUrl(TRACKING_NUMBER),
      html: RENDERED_PAGE,
      cookies: [{ name: 'X-XSRF-TOKEN-ST', value: 'token', domain: '.ups.com', path: '/' }],
      userAgent: 'Mozilla/5.0 (test browser)',
      capturedResponses: [
        { url: STATUS_API, status: 200, headers: {}, body: null, truncated: false, base64Encoded: false, error: 'unreadable' },
        { url: STATUS_API, status: 200, headers: {}, body: JSON.stringify(fixture()), truncated: false, base64Encoded: false, error: null },
      ],
    }));
    const { recorder, records } = stepRecorder();

    const result = await new UPSTracker({ timeoutMs: 2_000, trawl: new TrawlClient(TRAWL_URL), recorder }).fetch(TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'out_for_delivery',
      tracking_source: 'structured-web-response',
      tracking_url: upsTrackingUrl(TRACKING_NUMBER),
    });
    expect(result.events?.length ?? 0).toBeGreaterThan(1);
    // One browser call and nothing else: no direct session, no cookie replay.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${TRAWL_URL}/scrape`);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: upsTrackingUrl(TRACKING_NUMBER),
      skipHttp: true,
      maxTier: 3,
      captureResponses: [STATUS_API],
    });
    expect(records).toEqual(['trawl:ok', 'lookup:trawl:ok']);
  });

  it('falls back to the page the browser rendered when no status reply was captured', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        url: upsTrackingUrl(TRACKING_NUMBER),
        html: RENDERED_PAGE,
        cookies: [],
        userAgent: 'Mozilla/5.0 (test browser)',
        capturedResponses: [],
      }), { headers: { 'Content-Type': 'application/json' } }));
    const { recorder, records } = stepRecorder();

    const result = await new UPSTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawl: new TrawlClient('http://trawl.internal:8191/v1'),
      recorder,
    }).fetch(TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      tracking_source: 'rendered-page',
      tracking_url: upsTrackingUrl(TRACKING_NUMBER),
      events: [{ location: 'ZUERICH CH' }],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://trawl.internal:8191/scrape');
    expect(records).toEqual(['trawl:ok', 'lookup:trawl:ok']);
  });

  it('reports a refused check digit from either tier instead of a challenge', async () => {
    const refused = JSON.stringify({ statusCode: '402', statusText: 'Invalid Request', trackDetails: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      tier: 2, statusCode: 200, url: upsTrackingUrl(BAD_CHECK_DIGIT), html: RENDERED_PAGE, cookies: [],
      capturedResponses: [{ url: STATUS_API, status: 200, headers: {}, body: refused, truncated: false, base64Encoded: false, error: null }],
    }));
    await expect(new UPSTracker({ timeoutMs: 2_000, trawl: new TrawlClient(TRAWL_URL) }).fetch(BAD_CHECK_DIGIT))
      .rejects.toMatchObject({ name: 'InvalidInputError', kind: 'invalid_input' });

    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === STATUS_API) return new Response(refused, { headers: { 'Content-Type': 'application/json' } });
      const page = new Response(RENDERED_PAGE, { headers: { 'Set-Cookie': 'X-XSRF-TOKEN-ST=token; Domain=ups.com; Path=/' } });
      Object.defineProperty(page, 'url', { value: String(url) });
      return page;
    });
    const { recorder, records } = stepRecorder();
    await expect(new UPSTracker({ trawl: null, fetcher, recorder }).fetch(BAD_CHECK_DIGIT))
      .rejects.toMatchObject({ name: 'InvalidInputError', kind: 'invalid_input' });
    expect(records).toEqual(['direct:invalid_input', 'lookup:direct:invalid_input']);
  });

  it('reports a number UPS has no record of from either tier, without reading the page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      tier: 2, statusCode: 200, url: upsTrackingUrl(TRACKING_NUMBER), html: RENDERED_PAGE, cookies: [],
      capturedResponses: [{ url: STATUS_API, status: 200, headers: {}, body: UNKNOWN_NUMBER, truncated: false, base64Encoded: false, error: null }],
    }));
    await expect(new UPSTracker({ timeoutMs: 2_000, trawl: new TrawlClient(TRAWL_URL) }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'NotFoundError', kind: 'not_found' });

    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === STATUS_API) return new Response(UNKNOWN_NUMBER, { headers: { 'Content-Type': 'application/json' } });
      const page = new Response(RENDERED_PAGE, { headers: { 'Set-Cookie': 'X-XSRF-TOKEN-ST=token; Domain=ups.com; Path=/' } });
      Object.defineProperty(page, 'url', { value: String(url) });
      return page;
    });
    const { recorder, records } = stepRecorder();
    await expect(new UPSTracker({ trawl: null, fetcher, recorder }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'NotFoundError', kind: 'not_found' });
    expect(records).toEqual(['direct:not_found', 'lookup:direct:not_found']);
  });

  it('reports an outage from either tier instead of the rendered page or a challenge', async () => {
    const unavailable = { name: 'UPSUnavailableError', kind: 'indeterminate' };
    // The page the browser rendered reads "Delivered"; it must not hide the outage.
    for (const captured of [
      { url: STATUS_API, status: 200, headers: {}, body: outage('299', TRACKING_NUMBER), truncated: false, base64Encoded: false, error: null },
      { url: STATUS_API, status: 200, headers: {}, body: JSON.stringify({ statusCode: '298' }), truncated: false, base64Encoded: false, error: null },
    ]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
        tier: 2, statusCode: 200, url: upsTrackingUrl(TRACKING_NUMBER), html: RENDERED_PAGE, cookies: [], capturedResponses: [captured],
      }));
      await expect(new UPSTracker({ timeoutMs: 2_000, trawl: new TrawlClient(TRAWL_URL) }).fetch(TRACKING_NUMBER)).rejects.toMatchObject(unavailable);
    }
    // An HTTP 428 is the firewall's challenge, not an outage: the rendered page still answers.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      tier: 2, statusCode: 200, url: upsTrackingUrl(TRACKING_NUMBER), html: RENDERED_PAGE, cookies: [], capturedResponses: [
        { url: STATUS_API, status: 428, headers: {}, body: '', truncated: false, base64Encoded: false, error: null },
      ],
    }));
    await expect(new UPSTracker({ timeoutMs: 2_000, trawl: new TrawlClient(TRAWL_URL) }).fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'rendered-page' });

    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === STATUS_API) return new Response(outage('299', TRACKING_NUMBER), { headers: { 'Content-Type': 'application/json' } });
      const page = new Response(RENDERED_PAGE, { headers: { 'Set-Cookie': 'X-XSRF-TOKEN-ST=token; Domain=ups.com; Path=/' } });
      Object.defineProperty(page, 'url', { value: String(url) });
      return page;
    });
    const { recorder, records } = stepRecorder();
    await expect(new UPSTracker({ trawl: null, fetcher, recorder }).fetch(TRACKING_NUMBER)).rejects.toMatchObject(unavailable);
    expect(records).toEqual(['direct:indeterminate', 'lookup:direct:indeterminate']);
  });

  it('rejects a number that is not a UPS number before any request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not fetch'));
    const lookup = new UPSTracker({ trawl: null }).fetch('1Z999');
    await expect(lookup).rejects.toThrow('UPS tracking numbers must start with 1Z');
    await expect(lookup).rejects.toMatchObject({ kind: 'invalid_input' });
    // Before the lookup waits for its turn, so an ended signal does not hide it.
    await expect(new UPSTracker({ trawl: null }).fetch('H9000000000', { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('UPS rate limits', () => {
  const now = Date.parse('2026-08-04T06:00:00Z');
  const retryCases = [
    ['seconds', '60', 60_000],
    ['HTTP date', 'Tue, 04 Aug 2026 06:01:00 GMT', 60_000],
    ['past HTTP date', 'Tue, 04 Aug 2026 05:59:00 GMT', 0],
    ['absent hint', undefined, undefined],
    ['invalid hint', 'not a retry window', undefined],
  ] as const;

  it.each(retryCases)('preserves a direct page rate limit with %s', async (_name, hint, retryAfterMs) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>throttled</html>', {
      status: 429, headers: hint === undefined ? {} : { 'Retry-After': hint },
    }));
    const { recorder, records } = stepRecorder();
    await expect(new UPSTracker({ trawl: null, fetcher, recorder }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(records).toEqual(['direct:rate_limited', 'lookup:direct:rate_limited']);
  });

  it.each(retryCases)('preserves a direct API rate limit with %s instead of reading the page', async (_name, hint, retryAfterMs) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url) === STATUS_API
      ? new Response('', { status: 429, headers: hint === undefined ? {} : { 'Retry-After': hint } })
      : directPage(String(url)));
    const { recorder, records } = stepRecorder();
    await expect(new UPSTracker({ trawl: null, fetcher, recorder }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs });
    expect(fetcher.mock.calls.map(([url]) => String(url) === STATUS_API)).toEqual([false, true]);
    expect(records).toEqual(['direct:rate_limited', 'lookup:direct:rate_limited']);
  });

  it.each(['cached API', 'refresh page', 'refreshed API'] as const)('does not retry or discard a throttled %s session', async (phase) => {
    let lookup = 'warm';
    let apiCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) !== STATUS_API) {
        return lookup === 'throttle' && phase === 'refresh page'
          ? new Response('', { status: 429, headers: { 'Retry-After': '60' } })
          : directPage(String(url));
      }
      apiCalls += 1;
      if (lookup === 'throttle') {
        if (phase !== 'cached API' && apiCalls === 2) return new Response('', { status: 401 });
        return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
      }
      return Response.json(fixture());
    });
    const { recorder, records } = stepRecorder();
    const tracker = new UPSTracker({ trawl: null, fetcher, recorder });
    await expect(tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
    lookup = 'throttle';
    await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 60_000 });
    const expected = phase === 'cached API' ? [false, true, true]
      : phase === 'refresh page' ? [false, true, true, false] : [false, true, true, false, true];
    expect(fetcher.mock.calls.map(([url]) => String(url) === STATUS_API)).toEqual(expected);
    // The caller decides when to check again. A throttle does not reject the jar.
    lookup = 'recovered';
    await expect(tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
    expect(fetcher.mock.calls.map(([url]) => String(url) === STATUS_API)).toEqual([...expected, true]);
    expect(records).toEqual([
      'direct:ok', 'lookup:direct:ok', 'direct:rate_limited', 'lookup:direct:rate_limited', 'direct:ok', 'lookup:direct:ok',
    ]);
  });
});

describe('UPS captured response sequence', () => {
  function capture(status = 200, body: string | null = JSON.stringify(fixture()), overrides = {}) {
    return { url: STATUS_API, status, headers: {}, body, truncated: false, base64Encoded: false, error: null, ...overrides };
  }

  // A 500 holds the browser service it came through, so each case gets its own.
  let services = 0;
  function browser(capturedResponses: unknown[], extra = {}, endpoint = `${TRAWL_URL}/sequence-${services += 1}`) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      tier: 3, statusCode: 200, html: RENDERED_PAGE, cookies: [], capturedResponses, ...extra,
    }));
    const { recorder, records } = stepRecorder();
    return { fetcher, records, tracker: new UPSTracker({ trawl: new TrawlClient(endpoint, fetcher), fetcher, recorder }) };
  }

  it('rests the browser service for five minutes after the status call answers HTTP 500', async () => {
    let now = Date.parse('2026-08-04T06:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const endpoint = `${TRAWL_URL}/held`;
    const failed = browser([capture(), capture(500, '')], {}, endpoint);
    await expect(failed.tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    // Another tracker on the same service, as another registry in the process, asks nothing meanwhile.
    now += STATUS_HOLD_MS - 1_000;
    const held = browser([capture()], {}, endpoint);
    const error = await held.tracker.fetch(TRACKING_NUMBER).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(UPSStatusHeldError);
    expect(error).toMatchObject({ kind: 'indeterminate', name: 'UPSStatusHeldError', heldMs: 1_000 });
    expect(held.fetcher).not.toHaveBeenCalled();
    expect(held.records).toEqual(['trawl:indeterminate', 'lookup:trawl:indeterminate']);
    // Another browser service is not held.
    await expect(browser([capture()]).tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
    // Once the hold ends the browser is asked again.
    now += 1_000;
    await expect(held.tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
    expect(held.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['blocks the page until the tiers run out', { error: 'Max tier reached without success', timings: [{ tier: 2, status: 'blocked' }, { tier: 3, status: 'blocked' }] }],
    ['blocks the page until the deadline runs out', { error: 'Scrape deadline exceeded', timings: [{ tier: 2, status: 'blocked' }] }],
    ['fails the last tier otherwise', { error: 'Max tier reached without success', timings: [{ tier: 2, status: 'blocked' }, { tier: 3, status: 'error' }] }],
    ['fails every tier', { error: 'Max tier reached without success', timings: [{ tier: 2, status: 'error' }, { tier: 3, status: 'error' }] }],
  ])('rests the browser service after the page %s', async (name, reply) => {
    const endpoint = `${TRAWL_URL}/failed-${name.replaceAll(' ', '-')}`;
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(Response.json(reply, { status: 500 }));
    const failed = new UPSTracker({ trawl: new TrawlClient(endpoint, blocked), fetcher: blocked });
    await expect(failed.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    const held = browser([capture()], {}, endpoint);
    await expect(held.tracker.fetch(TRACKING_NUMBER)).rejects.toBeInstanceOf(UPSStatusHeldError);
    expect(held.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['another failure', { error: 'Browser pool exhausted' }],
    ['a failure before the browser', { error: 'Max tier reached without success', timings: [{ tier: 1, status: 'error' }] }],
  ])('does not rest the browser service after %s', async (name, reply) => {
    const endpoint = `${TRAWL_URL}/unblocked-${name.replaceAll(' ', '-')}`;
    const failing = vi.fn<typeof fetch>().mockResolvedValue(Response.json(reply, { status: 500 }));
    await expect(new UPSTracker({ trawl: new TrawlClient(endpoint, failing), fetcher: failing }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ status: 500 });
    const next = browser([capture()], {}, endpoint);
    await expect(next.tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
  });

  it.each([429, 502, 503])('does not rest the browser service after HTTP %i', async (status) => {
    const endpoint = `${TRAWL_URL}/not-held-${status}`;
    await expect(browser([capture(status, '')], {}, endpoint).tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ status });
    const next = browser([capture()], {}, endpoint);
    await expect(next.tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
    expect(next.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'challenge'], [403, 'challenge'], [419, 'challenge'], [429, 'rate_limited'],
    [404, 'indeterminate'], [410, 'indeterminate'], [500, 'indeterminate'], [503, 'maintenance'],
  ] as const)('keeps a newer HTTP %i refusal ahead of older JSON and rendered success', async (status, kind) => {
    const { tracker, fetcher, records } = browser([
      capture(), capture(status, null, { truncated: true, headers: { 'Retry-After': '60' } }),
    ]);
    await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(records).toEqual([`trawl:${kind}`, `lookup:trawl:${kind}`]);
  });

  it.each([
    ['seconds', '60', 60_000],
    ['HTTP date', 'Tue, 04 Aug 2026 06:01:00 GMT', 60_000],
    ['invalid hint', 'not a retry window', undefined],
  ] as const)('retains a captured rate-limit retry hint from %s', async (_name, hint, retryAfterMs) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-04T06:00:00Z'));
    const { tracker } = browser([capture(), capture(429, null, { headers: { 'rEtRy-AfTeR': hint } })]);
    await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs });
  });

  it('reads the latest sequence past the earlier capture bound', async () => {
    const { tracker } = browser([
      capture(), ...Array.from({ length: 20 }, () => capture(428, '')),
      capture(429, '', { headers: { 'retry-after': '120' } }),
    ]);
    await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
  });

  it('retains the newest refusal through the browser client capture bound', async () => {
    const { tracker, fetcher } = browser([
      ...Array.from({ length: 50 }, () => capture()),
      capture(429, '', { headers: { 'retry-after': '60' } }),
    ]);
    await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 60_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts a successful verification retry after an earlier refusal', async () => {
    const { tracker } = browser([capture(429, ''), capture()]);
    await expect(tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
  });

  it('ignores refusals outside the exact status endpoint', async () => {
    const { tracker } = browser([capture(), capture(429, '', { url: `${STATUS_API}&unrelated=true` })]);
    await expect(tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
  });

  it('uses the rendered page for a latest 428 instead of an older history', async () => {
    const { tracker } = browser([capture(), capture(428, '')]);
    await expect(tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ status: 'delivered', tracking_source: 'rendered-page' });
  });

  it.each([
    ['malformed JSON', capture(200, 'PRIVATE MALFORMED BODY')],
    ['invalid schema', capture(200, '[]')],
    ['wrong identity', capture(200, JSON.stringify(withScans([], { trackingNumber: BAD_CHECK_DIGIT })))],
    ['truncated body', capture(200, JSON.stringify(fixture()), { truncated: true })],
    ['missing body', capture(200, null)],
    ['encoded body', capture(200, JSON.stringify(fixture()), { base64Encoded: true })],
    ['body read failure', capture(200, null, { error: 'PRIVATE READ FAILURE' })],
  ])('retains the latest %s as schema failure instead of using old JSON or HTML', async (_name, latest) => {
    const { tracker, records } = browser([capture(), latest]);
    const error: unknown = await tracker.fetch(TRACKING_NUMBER).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ kind: 'schema' });
    expect(String(error)).not.toContain('PRIVATE');
    expect(records).toEqual(['trawl:schema', 'lookup:trawl:schema']);
  });

  it.each(['60', 'Tue, 04 Aug 2026 06:01:00 GMT'])('preserves an outer-page 429 with Retry-After %s', async (hint) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-04T06:00:00Z'));
    const { tracker, records } = browser([capture()], { statusCode: 429, responseHeaders: { 'Retry-After': hint } });
    await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 60_000 });
    expect(records).toEqual(['trawl:rate_limited', 'lookup:trawl:rate_limited']);
  });

  it.each([401, 403])('preserves an outer-page HTTP %i challenge', async (statusCode) => {
    const { tracker } = browser([capture()], { statusCode });
    await expect(tracker.fetch(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'challenge', status: statusCode });
  });
});

describe('UPS lookup context', () => {
  /** A request that ends only when its signal aborts. */
  const held = (init?: RequestInit) => new Promise<Response>((_, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error), { once: true });
  });

  it('answers a caller cancelled in the queue at once and leaves the next caller its turn', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce((_url, init) => held(init))
      .mockImplementation(async () => Response.json({ tier: 3, statusCode: 200, html: RENDERED_PAGE, cookies: [] }));
    const tracker = new UPSTracker({ trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher });
    const first = new AbortController();
    const second = new AbortController();
    const running = tracker.fetch(TRACKING_NUMBER, { signal: first.signal });
    const queued = tracker.fetch(TRACKING_NUMBER, { signal: second.signal });
    const next = tracker.fetch(TRACKING_NUMBER);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    second.abort(new Error('second caller left'));
    await expect(queued).rejects.toThrow('second caller left');

    first.abort(new Error('first caller left'));
    await expect(running).rejects.toThrow('first caller left');
    await expect(next).resolves.toMatchObject({ status: 'delivered' });
    // The cancelled turn passed without a request of its own.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a queued lookup when the budget its caller set is spent', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => held(init));
    const tracker = new UPSTracker({ trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher });
    const first = new AbortController();
    const running = tracker.fetch(TRACKING_NUMBER, { signal: first.signal });

    await expect(tracker.fetch(TRACKING_NUMBER, { budgetMs: 40 }))
      .rejects.toMatchObject({ name: 'BudgetExceededError', kind: 'budget' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    first.abort(new Error('first caller left'));
    await expect(running).rejects.toThrow('first caller left');
  });

  it('reports a browser service that outlasts the budget as a transport failure', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => held(init));
    const { recorder, records } = stepRecorder();

    await expect(new UPSTracker({ trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher, recorder }).fetch(TRACKING_NUMBER, { budgetMs: 50 }))
      .rejects.toMatchObject({ name: 'UpstreamNetworkError', kind: 'transport' });
    expect(records).toEqual(['trawl:transport', 'lookup:trawl:transport']);
  });

  // The conformance test always configures a browser service, so it never runs this tier.
  it('bounds the plain HTTP tier by the budget and the signal without spoiling the next lookup', async () => {
    let answering = false;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === STATUS_API) return answering ? Response.json(fixture()) : held(init);
      const page = new Response(RENDERED_PAGE, { headers: { 'Set-Cookie': 'X-XSRF-TOKEN-ST=token; Domain=ups.com; Path=/' } });
      Object.defineProperty(page, 'url', { value: String(url) });
      return page;
    });
    const tracker = new UPSTracker({ trawl: null, fetcher });

    // A spent budget ends the held status call; the page already fetched still answers.
    await expect(tracker.fetch(TRACKING_NUMBER, { budgetMs: 50 }))
      .resolves.toMatchObject({ tracking_source: 'rendered-page' });

    const controller = new AbortController();
    const cancelled = tracker.fetch(TRACKING_NUMBER, { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    controller.abort(new Error('caller left'));
    await expect(cancelled).rejects.toThrow('caller left');

    answering = true;
    await expect(tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
    await expect(tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
    // Neither unfinished session was kept; the one that answered serves the last lookup alone.
    expect(fetcher.mock.calls.map(([url]) => String(url) === STATUS_API))
      .toEqual([false, true, false, true, false, true, true]);
  });
});

describe('UPS rendered page', () => {
  it('verifies the requested number before reading the status banner', () => {
    expect(parseUPSTrackingHtml(RENDERED_PAGE, TRACKING_NUMBER)).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      events: [{ location: 'ZUERICH CH' }],
    });
    expect(() => parseUPSTrackingHtml('<body>another parcel</body>', TRACKING_NUMBER))
      .toThrow('UPS did not return the requested parcel');
  });

  it('marks the banner as a summary, so a provider may still supply the history', () => {
    const result = parseUPSTrackingHtml(RENDERED_PAGE, TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_update: null, summary_only: true });
    expect(result.events).toEqual([{ location: 'ZUERICH CH', description: 'Delivered', stage: 'delivered' }]);
  });

  it('writes the banner\'s place as the scans\' places, and keeps one without commas', () => {
    const place = (text: string) => parseUPSTrackingHtml(RENDERED_PAGE.replace('ZUERICH CH', text), TRACKING_NUMBER).events?.[0]?.location;
    expect(place('ZUERICH, CH')).toBe('Zuerich, Switzerland');
    expect(place('DES MOINES, IA, US')).toBe('Des Moines, IA, United States');
    expect(place('LOS ANGELES CA')).toBe('LOS ANGELES CA');
  });

  it('never places the banner in the ship-to town', () => {
    const result = parseUPSTrackingHtml(`
      <html><head><meta name="stapp-tracknum" content="${TRACKING_NUMBER}"></head>
      <body>
        <span id="stApp_nameKey">On the Way</span>
        <p id="stApp_txtAddress">PRIVATE CITY</p><p id="stApp_txtCountry">DE</p>
      </body></html>`, TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', events: [{ description: 'On the Way' }] });
    expect(result.events?.[0]?.location).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('stages the banner by the milestone it names, the one scan without an activity code', () => {
    const banner = (name: string) => parseUPSTrackingHtml(`
      <html><head><meta name="stapp-tracknum" content="${TRACKING_NUMBER}"></head>
      <body><span id="stApp_nameKey">${name}</span></body></html>`, TRACKING_NUMBER).events?.[0];
    expect(parseUPSTrackingHtml(RENDERED_PAGE, TRACKING_NUMBER).events?.[0]).toMatchObject({ description: 'Delivered', stage: 'delivered' });
    expect(banner('Label Created')).toMatchObject({ stage: 'registered' });
    expect(banner('On the Way')).toMatchObject({ stage: 'in_transit' });
    expect(banner('Out for Delivery')).toMatchObject({ stage: 'out_for_delivery' });
    // Other wording keeps no stage, and the banner never carries a code.
    expect(banner('Delivery Attempted')).toMatchObject({ description: 'Delivery Attempted' });
    expect(banner('Delivery Attempted')?.stage).toBeUndefined();
    expect(banner('Delivered')).not.toHaveProperty('provider_code');
  });
});

it('never opens a plain HTTP session while a browser service is configured', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/scrape')
    ? Response.json({ tier: 3, statusCode: 200, html: RENDERED_PAGE, cookies: [] })
    : new Response('challenge', { status: 403 }));
  const tracker = new UPSTracker({ trawl: new TrawlClient(TRAWL_URL) });
  await tracker.fetch(TRACKING_NUMBER);
  await tracker.fetch(TRACKING_NUMBER);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('ups.com'))).toHaveLength(0);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/scrape'))).toHaveLength(2);
});

describe('UPS rendered progress bar', () => {
  const page = (nameKey: string) => `
    <html><head><meta name="stapp-tracknum" content="${TRACKING_NUMBER}"></head>
    <body>
      <span id="stApp_nameKey">${nameKey}</span>
      <ups-ac-progress-bar id="stApp_shpmtProgress">
        <ol><li class="progress-step active" aria-current="true"></li><li class="progress-step inactive"></li></ol>
        <ol>
          <li class="progress-step active" aria-current="true"><button class="step-label"><span>Label Created </span></button><span class="sr-only">active</span></li>
          <li class="progress-step inactive"><button class="step-label"><span>On the Way </span></button><span class="sr-only">inactive</span></li>
          <li class="progress-step inactive"><button class="step-label"><span>Out for Delivery </span></button><span class="sr-only">inactive</span></li>
        </ol>
      </ups-ac-progress-bar>
    </body></html>`;

  it('reads only the active milestone, not every milestone still ahead', () => {
    expect(parseUPSTrackingHtml(page('Label Created'), TRACKING_NUMBER)).toMatchObject({
      status: 'pending',
      last_status_text: 'Label Created',
    });
    expect(parseUPSTrackingHtml(page(''), TRACKING_NUMBER)).toMatchObject({
      status: 'pending',
      last_status_text: 'Label Created',
    });
  });
});
