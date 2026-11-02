import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AmazonShippingNotFoundError,
  AmazonShippingTracker,
  amazonShippingTrackingApiUrl,
  amazonShippingTrackingUrl,
  normalizeAmazonShippingTrackingNumber,
  parseAmazonShippingTrackingResponse,
} from './adapter.js';
import { amazonShippingStatus } from './status.js';

const TRACKING_NUMBER = 'FR1234567890';

const fixture = (name: string): Record<string, unknown> => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
) as Record<string, unknown>;
const deliveredFixture = () => fixture('delivered');
const notFoundFixture = () => fixture('not-found');
const historyExpiredFixture = () => fixture('history-expired');
/** The delivered parcel earlier that day: its out-for-delivery scan names the delivery centre's arrival. */
const outForDeliveryFixture = () => {
  const value = deliveredFixture();
  const progress = JSON.parse(String(value.progressTracker)) as Record<string, unknown>;
  progress.summary = {
    status: 'OutForDelivery',
    metadata: { trackingStatus: { stringValue: 'OUT_FOR_DELIVERY' }, expectedDeliveryDate: { date: 'Aug 11, 2026, 6:00:00 PM' } },
    containerStatusTags: ['OUT_FOR_DELIVERY'],
  };
  value.progressTracker = JSON.stringify(progress);
  const history = JSON.parse(String(value.eventHistory)) as { eventHistory: Record<string, unknown>[] };
  history.eventHistory = [...history.eventHistory.slice(0, 2), {
    eventCode: 'OutForDelivery',
    subReasonCode: 'NONE',
    statusSummary: { localisedStringId: 'swa_rex_detail_arrived_at_delivery_Center' },
    eventTime: 'Aug 11, 2026, 8:05:00 AM',
    location: { city: 'Paris', stateProvince: 'Île-de-France', countryCode: 'FR' },
  }];
  value.eventHistory = JSON.stringify(history);
  return value;
};
const PARIS = { city: 'Paris', stateProvince: 'Île-de-France', countryCode: 'FR' };
/** The out-for-delivery parcel with a summary of its own and later scans. */
const outForDeliveryWith = (summary: Record<string, unknown>, ...scans: Record<string, unknown>[]) => {
  const value = outForDeliveryFixture();
  const progress = JSON.parse(String(value.progressTracker)) as Record<string, unknown>;
  progress.summary = summary;
  value.progressTracker = JSON.stringify(progress);
  const history = JSON.parse(String(value.eventHistory)) as { eventHistory: Record<string, unknown>[] };
  history.eventHistory.push(...scans);
  value.eventHistory = JSON.stringify(history);
  return value;
};
const scan = (eventCode: string, localisedStringId: string, eventTime: string, location: Record<string, unknown> = PARIS) => ({
  eventCode, statusSummary: { localisedStringId }, eventTime, location,
});
const capabilities = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

afterEach(() => vi.restoreAllMocks());

describe('Amazon Shipping France input', () => {
  it('normalizes the documented FR plus ten-digit format and builds official URLs', () => {
    expect(normalizeAmazonShippingTrackingNumber(' fr12 3456-7890 '))
      .toBe(TRACKING_NUMBER);
    expect(amazonShippingTrackingUrl(TRACKING_NUMBER))
      .toBe(`https://track.amazon.fr/tracking/${TRACKING_NUMBER}`);
    expect(amazonShippingTrackingApiUrl(TRACKING_NUMBER))
      .toBe(`https://track.amazon.fr/api/tracker/${TRACKING_NUMBER}`);
  });

  it('rejects malformed and injectable identifiers', () => {
    for (const value of [
      'FR123456789',
      'FR12345678901',
      'ZZ1234567890',
      'TBA12345678901',
      'TBA1234567890123',
      'FR123456789A',
      'FR1234567890?admin=true',
      'FR123456789É',
    ]) {
      expect(() => normalizeAmazonShippingTrackingNumber(value)).toThrow('European country prefix');
      expect(() => normalizeAmazonShippingTrackingNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Amazon Shipping France status normalization', () => {
  it.each([
    ['CREATION_CONFIRMED', 'pending'],
    ['PICKUP_DONE', 'in_transit'],
    ['IN_TRANSIT', 'in_transit'],
    ['OUT_FOR_DELIVERY', 'out_for_delivery'],
    ['HOLD_FOR_PICKUP', 'out_for_delivery'],
    ['DELIVERED', 'delivered'],
    ['DELAYED_AND_EDD_UPDATED', 'in_transit'],
    ['DELIVERY_ATTEMPTED', 'exception'],
    ['UNDELIVERABLE_DAMAGED', 'exception'],
    ['RETURNED_TO_SENDER', 'exception'],
    ['NEW_PROVIDER_STATUS', 'unknown'],
  ] as const)('maps %s to %s', (value, expected) => {
    expect(amazonShippingStatus(value)).toBe(expected);
  });
});

describe('Amazon Shipping France response normalization', () => {
  it('sorts safe events and discards recipient, street, postcode, merchant, and proof fields', () => {
    const result = parseAmazonShippingTrackingResponse(deliveredFixture());

    expect(result).toEqual({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-08-11T16:31:56Z',
      expected_delivery: null,
      delivered_at: '2026-08-11T16:31:56Z',
      timezone: 'Europe/Paris',
      events: [{
        time: '2026-08-11T16:31:56Z',
        description: 'Delivered',
        stage: 'delivered',
        provider_code: 'Delivered',
      }, {
        time: '2026-08-10T22:10:16Z',
        location: 'Paris, Île-de-France, FR',
        description: 'Departed facility',
        stage: 'in_transit',
        provider_code: 'Departed',
      }, {
        time: '2026-08-07T23:51:15Z',
        description: 'Shipment information received',
        stage: 'registered',
        provider_code: 'CreationConfirmed',
      }],
    });
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'PRIVATE RECIPIENT',
      'PRIVATE STREET',
      'PRIVATE POSTCODE',
      'PRIVATE MERCHANT',
      'private@example.test',
      'PRIVATE DELIVERY IMAGE',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('covers every capability declared in carrier.json', () => {
    expect(capabilities).toEqual(['history', 'location', 'eta', 'provider_code', 'delivered_at']);
    const result = parseAmazonShippingTrackingResponse(deliveredFixture());
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.events?.some((event) => event.provider_code)).toBe(true);
    expect(parseAmazonShippingTrackingResponse(outForDeliveryFixture()).expected_delivery).toBe('2026-08-11');
    expect(result.delivered_at).toBe(result.events?.[0]?.time);
  });

  it('words an out-for-delivery scan by its code, and drops the estimate once delivered', () => {
    const result = parseAmazonShippingTrackingResponse(outForDeliveryFixture());
    expect(result).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'out_for_delivery',
      last_status_text: 'Out for delivery',
      expected_delivery: '2026-08-11',
    });
    expect(result.events?.[0]).toEqual({
      time: '2026-08-11T08:05:00Z',
      location: 'Paris, Île-de-France, FR',
      description: 'Out for delivery',
      stage: 'out_for_delivery',
      provider_code: 'OutForDelivery',
    });
    expect(result).not.toHaveProperty('delivered_at');
    const arrival = outForDeliveryFixture();
    const history = JSON.parse(String(arrival.eventHistory)) as { eventHistory: Record<string, unknown>[] };
    history.eventHistory[2]!.eventCode = 'Received';
    arrival.eventHistory = JSON.stringify(history);
    expect(parseAmazonShippingTrackingResponse(arrival).events?.[0]).toMatchObject({
      description: 'Arrived at delivery center', stage: 'in_transit', provider_code: 'Received',
    });
    expect(parseAmazonShippingTrackingResponse(deliveredFixture()).expected_delivery).toBeNull();
  });

  it('words the final hub as the delivery center it is', () => {
    const hub = outForDeliveryFixture();
    const history = JSON.parse(String(hub.eventHistory)) as { eventHistory: Record<string, unknown>[] };
    history.eventHistory[2] = scan('Received', 'swa_rex_arrived_at_final_hub', 'Aug 11, 2026, 5:48:16 AM');
    hub.eventHistory = JSON.stringify(history);
    expect(parseAmazonShippingTrackingResponse(hub).events?.[0]).toEqual({
      time: '2026-08-11T05:48:16Z', location: 'Paris, Île-de-France, FR',
      description: 'Arrived at delivery center', stage: 'in_transit', provider_code: 'Received',
    });
  });

  it('leaves out a region Amazon does not know', () => {
    const hub = outForDeliveryFixture();
    const history = JSON.parse(String(hub.eventHistory)) as { eventHistory: Record<string, unknown>[] };
    history.eventHistory[2] = scan('Received', 'swa_rex_arrived_at_final_hub', 'Aug 11, 2026, 5:48:16 AM',
      { city: 'Exampleville', stateProvince: 'N/A', countryCode: 'ES' });
    hub.eventHistory = JSON.stringify(history);
    expect(parseAmazonShippingTrackingResponse(hub).events?.[0]?.location).toBe('Exampleville, ES');
  });

  it('keeps a parcel out for delivery when the van leaves the station', () => {
    const summary = {
      status: 'Departed', metadata: { trackingStatus: { stringValue: 'OUT_FOR_DELIVERY' } }, containerStatusTags: ['OUT_FOR_DELIVERY'],
    };
    const departed = scan('Departed', 'swa_rex_detail_departed', 'Aug 11, 2026, 8:05:04 AM');
    const result = parseAmazonShippingTrackingResponse(outForDeliveryWith(summary, departed));
    expect(result).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for delivery',
      last_update: '2026-08-11T08:05:04Z',
    });
    expect(result.events?.slice(0, 2)).toEqual([
      {
        time: '2026-08-11T08:05:04Z', location: 'Paris, Île-de-France, FR',
        description: 'Departed facility', stage: 'out_for_delivery', provider_code: 'Departed',
      },
      {
        time: '2026-08-11T08:05:00Z', location: 'Paris, Île-de-France, FR',
        description: 'Out for delivery', stage: 'out_for_delivery', provider_code: 'OutForDelivery',
      },
    ]);
    // A US number's scans read the same clock.
    expect(parseAmazonShippingTrackingResponse(outForDeliveryWith(summary, departed), null).events?.[0])
      .toMatchObject({ time: '2026-08-11T08:05:04Z', stage: 'out_for_delivery' });
    // A summary whose only signal repeats the departure's code defers to the scan.
    expect(parseAmazonShippingTrackingResponse(outForDeliveryWith({ status: 'Departed', metadata: {} }, departed)))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for delivery' });

    // A departure from another place, from an unnamed one, hours later, or after the parcel came back, is a journey on.
    for (const later of [
      scan('Departed', 'swa_rex_detail_departed', 'Aug 11, 2026, 8:05:04 AM', { city: 'Lyon', countryCode: 'FR' }),
      scan('Departed', 'swa_rex_detail_departed', 'Aug 11, 2026, 8:05:04 AM', {}),
      scan('Departed', 'swa_rex_detail_departed', 'Aug 13, 2026, 8:05:04 AM'),
    ]) {
      expect(parseAmazonShippingTrackingResponse(outForDeliveryWith(summary, later)).events?.[0])
        .toMatchObject({ description: 'Departed facility', stage: 'in_transit' });
    }
    const twice = parseAmazonShippingTrackingResponse(outForDeliveryWith(summary, departed,
      scan('Departed', 'swa_rex_detail_departed', 'Aug 11, 2026, 8:30:00 AM')));
    expect(twice.events?.slice(0, 2).map((event) => event.stage)).toEqual(['in_transit', 'out_for_delivery']);
    const back = parseAmazonShippingTrackingResponse(outForDeliveryWith({ status: 'Departed', metadata: {} },
      scan('Received', 'swa_rex_arrived_at_sort_center', 'Aug 11, 2026, 6:10:00 PM'),
      scan('Departed', 'swa_rex_detail_departed', 'Aug 11, 2026, 9:40:00 PM')));
    expect(back).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(back.events?.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'out_for_delivery', 'in_transit', 'registered']);
    expect(parseAmazonShippingTrackingResponse(deliveredFixture()).events?.[1])
      .toMatchObject({ provider_code: 'Departed', stage: 'in_transit' });
  });

  it('keeps scans of one instant in the tracker\'s order, whichever way it lists them', () => {
    const tied = outForDeliveryWith({ status: 'Departed', metadata: {} },
      scan('Received', 'swa_rex_arrived_at_sort_center', 'Aug 11, 2026, 6:10:00 PM'),
      scan('Departed', 'swa_rex_detail_departed', 'Aug 11, 2026, 6:10:00 PM'));
    const reversed = { ...tied, eventHistory: JSON.stringify({ eventHistory: (JSON.parse(String(tied.eventHistory)) as { eventHistory: unknown[] }).eventHistory.reverse() }) };
    for (const value of [tied, reversed]) {
      expect(parseAmazonShippingTrackingResponse(value).events?.slice(0, 2).map((event) => event.provider_code)).toEqual(['Departed', 'Received']);
    }
  });

  it('takes a delivered summary only when a scan says delivered', () => {
    const summary = {
      status: 'Delivered', metadata: { trackingStatus: { stringValue: 'DELIVERED' } }, containerStatusTags: ['DELIVERED'],
    };
    const departed = scan('Departed', 'swa_rex_detail_departed', 'Aug 11, 2026, 9:40:00 PM');
    const received = scan('Received', 'swa_rex_arrived_at_sort_center', 'Aug 11, 2026, 6:10:00 PM');
    const result = parseAmazonShippingTrackingResponse(outForDeliveryWith(summary, received, departed));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-08-11T21:40:00Z' });
    expect(result).not.toHaveProperty('delivered_at');
    // The delivery scan settles it, and a summary with no scans to weigh it against stands.
    expect(parseAmazonShippingTrackingResponse(outForDeliveryWith(summary,
      scan('Delivered', 'swa_rex_detail_delivered', 'Aug 11, 2026, 11:20:00 AM'))))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-08-11T11:20:00Z' });
    const scanless = outForDeliveryFixture();
    scanless.eventHistory = JSON.stringify({ eventHistory: [] });
    const progress = JSON.parse(String(scanless.progressTracker)) as Record<string, unknown>;
    scanless.progressTracker = JSON.stringify({ ...progress, summary });
    expect(parseAmazonShippingTrackingResponse(scanless)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('keeps a delayed parcel whose scans show only its label registered', () => {
    const delayed = (eventCodes: string[]) => {
      const value = deliveredFixture();
      value.progressTracker = JSON.stringify({
        summary: { status: 'Delayed', metadata: { trackingStatus: { stringValue: 'DELAYED' } }, containerStatusTags: ['DELAYED'] },
        trackerSource: 'SWA',
      });
      value.eventHistory = JSON.stringify({ trackerSource: 'SWA', eventHistory: eventCodes.map((eventCode, index) => ({
        eventCode, statusSummary: {}, eventTime: `Aug ${7 + index}, 2026, 11:51:15 PM`, location: {},
      })) });
      return parseAmazonShippingTrackingResponse(value);
    };
    expect(delayed(['CreationConfirmed'])).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Delivery delayed' });
    // Once a scan has moved the parcel, the delay reads as transit, as before.
    expect(delayed(['CreationConfirmed', 'PickupDone'])).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Delivery delayed' });
  });

  it('uses event history when the summary status is absent', () => {
    const fixtureWithoutSummary = deliveredFixture();
    fixtureWithoutSummary.progressTracker = JSON.stringify({
      summary: { status: null, metadata: {} },
      expectedDeliveryDate: null,
      trackerSource: 'SWA',
    });

    expect(parseAmazonShippingTrackingResponse(fixtureWithoutSummary)).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
    });
  });

  it('maps Amazon\'s HTTP 200 not-found payload to a clean 404 error', () => {
    expect(() => parseAmazonShippingTrackingResponse(notFoundFixture()))
      .toThrow(AmazonShippingNotFoundError);
    try {
      parseAmazonShippingTrackingResponse(notFoundFixture());
    } catch (error) {
      expect(error).toMatchObject({
        name: 'AmazonShippingNotFoundError',
        status: 404,
        message: 'Amazon Shipping could not locate the shipment',
      });
    }
  });

  it('treats an Amazon retail order the public tracker refuses as not found', () => {
    expect(() => parseAmazonShippingTrackingResponse({
      progressTracker: JSON.stringify({
        trackerSource: 'SWA',
        summary: { status: null, metadata: {} },
        errors: [{ errorCode: 'ERROR_INVALID_OFF_AMAZON_ORDER', errorMessage: 'INVALID OFF AMAZON ORDER' }],
      }),
      eventHistory: null,
    })).toThrow(AmazonShippingNotFoundError);
  });

  it('rejects malformed and status-free responses instead of inventing a state', () => {
    expect(() => parseAmazonShippingTrackingResponse([]))
      .toThrow('invalid tracking response');
    expect(() => parseAmazonShippingTrackingResponse({ progressTracker: '{' }))
      .toThrow('invalid progress tracker');
    expect(() => parseAmazonShippingTrackingResponse({
      progressTracker: JSON.stringify({ trackerSource: 'SWA', summary: { status: null, metadata: {} } }),
      eventHistory: null,
    })).toThrow('incomplete tracking details');
  });
});

describe('Amazon Shipping France tracker', () => {
  it('fetches the bounded public JSON endpoint with the matching public-page referer', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(deliveredFixture()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new AmazonShippingTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(amazonShippingTrackingApiUrl(TRACKING_NUMBER));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: expect.objectContaining({
        Accept: 'application/json',
        Referer: amazonShippingTrackingUrl(TRACKING_NUMBER),
      }),
    });
  });

  it('exercises a valid-shaped wrong number through the real adapter path', async () => {
    const wrongNumber = 'FR0000000000';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(notFoundFixture()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new AmazonShippingTracker({ timeoutMs: 1_000 }).fetch(wrongNumber))
      .rejects.toMatchObject({
        name: 'AmazonShippingNotFoundError',
        status: 404,
      });
  });

  it('enforces the response-size limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      headers: { 'Content-Length': '2000001' },
    }));

    await expect(new AmazonShippingTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toThrow('unexpectedly large response');
  });

  it('reads a web page in place of the tracker reply as inconclusive, never as not found', async () => {
    const page = (body: string) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `\n\n\n<html>\n<head>\n<meta name="CSRF-TOKEN" content="synthetic">\n</head>\n<body>${body}</body></html>`,
      { headers: { 'Content-Type': 'text/html;charset=UTF-8' } },
    ));
    page('<div id="root"></div>');
    await expect(new AmazonShippingTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate', message: expect.stringContaining('tracking page') });
    page('<form action="/errors/validateCaptcha"></form>');
    await expect(new AmazonShippingTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('reads a reply that is neither JSON nor a page as a changed reply', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"progressTracker":', {
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(new AmazonShippingTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'schema', message: expect.stringContaining('invalid tracking JSON') });
  });
});

describe('Amazon Shipping discovery boundaries', () => {
  it.each(['FR', 'DE', 'BE', 'UK', 'GB', 'IT', 'ES', 'NL', 'AT', 'IE', 'PL', 'SE', 'PT', 'CH'])(
    'supports the %s format', (prefix) => expect(normalizeAmazonShippingTrackingNumber(`${prefix}0000000001`)).toBe(`${prefix}0000000001`),
  );
  it('uses official regional portals and recognizes US numbers', () => {
    expect(amazonShippingTrackingApiUrl('UK0000000001')).toBe('https://track.amazon.co.uk/api/tracker/UK0000000001');
    expect(amazonShippingTrackingApiUrl('IT0000000001')).toContain('track.amazon.it');
    expect(amazonShippingTrackingApiUrl('ES0000000001')).toContain('track.amazon.es');
    expect(amazonShippingTrackingApiUrl('TBA000000000001')).toContain('track.amazon.com/api/tracker/TBA000000000001');
    expect(amazonShippingTrackingApiUrl('BE0000000001')).toContain('track.amazon.fr');
  });
  it('does not mistake an expired shipment placeholder for real movement', () => {
    expect(() => parseAmazonShippingTrackingResponse(historyExpiredFixture()))
      .toThrow('history has expired');
  });
  it('rejects contradictory identity even with usable tracking history', () => {
    expect(() => parseAmazonShippingTrackingResponse({ ...deliveredFixture(), trackingId: 'FR0000000002' }, 'Europe/Paris', 'FR0000000001'))
      .toThrow('different tracking number');
  });
  it('rejects structured identity even when it contains the requested number', () => {
    for (const trackingId of [['FR0000000001'], { value: 'FR0000000001' }]) {
      expect(() => parseAmazonShippingTrackingResponse({ ...deliveredFixture(), trackingId }, 'Europe/Paris', 'FR0000000001'))
        .toThrow('different tracking number');
    }
    expect(parseAmazonShippingTrackingResponse({ ...deliveredFixture(), trackingId: 'FR0000000001' }, 'Europe/Paris', 'FR0000000001').status)
      .toBe('delivered');
  });
  it('reads the tracker clock as UTC on every host, and the estimate on the day of the number country', () => {
    const uk = parseAmazonShippingTrackingResponse(deliveredFixture(), 'Europe/London');
    expect(uk).toMatchObject({ last_update: '2026-08-11T16:31:56Z', timezone: 'Europe/London' });
    expect(parseAmazonShippingTrackingResponse(outForDeliveryFixture(), 'Europe/London').expected_delivery).toBe('2026-08-11');
    const us = parseAmazonShippingTrackingResponse(deliveredFixture(), null);
    expect(us.events?.map((event) => event.time)).toEqual(['2026-08-11T16:31:56Z', '2026-08-10T22:10:16Z', '2026-08-07T23:51:15Z']);
    expect(us).toMatchObject({ last_update: '2026-08-11T16:31:56Z', delivered_at: '2026-08-11T16:31:56Z' });
    expect(us.timezone).toBeUndefined();
    // A US promise for 3 AM is the evening before, in the recipient's zone.
    expect(parseAmazonShippingTrackingResponse(outForDeliveryFixture(), null).expected_delivery).toBeNull();
    const unreadable = deliveredFixture();
    type Row = Record<string, unknown>;
    const history = JSON.parse(String(unreadable.eventHistory)) as { eventHistory: [Row, Row, ...Row[]] };
    history.eventHistory[0].eventTime = 'Aug 7, 2026, 23:51:15 +0200';
    history.eventHistory[1].eventTime = 'sometime in August';
    unreadable.eventHistory = JSON.stringify(history);
    const mixed = parseAmazonShippingTrackingResponse(unreadable, null);
    expect(mixed.events?.find((event) => event.provider_code === 'Departed')).toMatchObject({ provider_time_text: 'sometime in August' });
    expect(mixed.events?.find((event) => event.provider_code === 'CreationConfirmed')).toMatchObject({ provider_time_text: 'Aug 7, 2026, 23:51:15 +0200' });
  });
});
