import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, PostnordTracker } from './adapter.js';
import { normalizePostnordNumber, parsePostnord } from './parser.js';
import { classifyPostnordStatus } from './status.js';
import { InvalidInputError } from '../../core/errors/index.js';

const NUMBER = '00573000000000000001';
const OTHER_NUMBER = '00573000000000000002';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const payload = () => structuredClone(fixture);

describe('PostNord direct tracking', () => {
  it('uses item summary status and excludes confirmed administrative notices from shipment history', () => {
    const result = parsePostnord(payload(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-04T12:00:00Z',
      delivered_at: '2026-01-04T12:00:00Z', expected_delivery: null, weight_kg: 1.5, dimensions_text: '40 × 30 × 20 cm',
      sender_name: 'Example Shop AB', destination_country: 'SE', pickup_point: 'Example Service Point', service_name: 'Parcel' });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'out_for_delivery', 'in_transit', 'registered']);
    expect(JSON.stringify(result.events)).not.toContain('text message');
    const waiting = payload(); waiting.items[0].events.splice(4, 1);
    waiting.items[0].status = { code: 'AVAILABLE_FOR_DELIVERY', header: 'The shipment item has been delivered to a service point' };
    const declared = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(declared.capabilities).toEqual(['history', 'location', 'delivered_at', 'weight', 'dimensions', 'sender_name', 'pickup_point', 'service_name']);
    expect(parsePostnord(waiting, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup', pickup_point: 'Example Service Point' });
    expect(parsePostnord(waiting, NUMBER)).not.toHaveProperty('delivered_at');
  });

  it('gives the waiting parcel its service point record and keeps the point once collected there', () => {
    const ready = () => JSON.parse(readFileSync(new URL('./fixtures/ready-for-pickup.json', import.meta.url), 'utf8'));
    const waiting = parsePostnord(ready(), NUMBER);
    expect(waiting).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup',
      pickup_point: 'Example Service Point\nExample Square 1\n111 11 Example Town' });
    expect(waiting.pickup_point).not.toMatch(/Private|99999/);
    // The scans themselves are unchanged by the record.
    expect(waiting.events?.[0]).toMatchObject({ location: 'Example Service Point', description: 'The shipment item has been delivered to a service point.' });
    const partial = ready(); delete partial.servicePoint.address.street;
    expect(parsePostnord(partial, NUMBER).pickup_point).toBe('Example Service Point');
    const noTown = ready(); noTown.servicePoint.address.city = ' ';
    expect(parsePostnord(noTown, NUMBER).pickup_point).toBe('Example Service Point');
    const noPostcode = ready(); delete noPostcode.servicePoint.address.postalCode;
    expect(parsePostnord(noPostcode, NUMBER).pickup_point).toBe('Example Service Point\nExample Square 1\nExample Town');
    for (const record of [undefined, null, 'Example Service Point', { address: ready().servicePoint.address }]) {
      const value = ready(); value.servicePoint = record;
      expect(parsePostnord(value, NUMBER).pickup_point).toBe('Example Service Point');
    }
    // A parcel in transit shows no point, whatever the record says.
    const moving = ready(); moving.items[0].status = { code: 'EN_ROUTE', header: 'The shipment item is under transportation.' };
    expect(parsePostnord(moving, NUMBER)).not.toHaveProperty('pickup_point');

    const delivered = (scan: Record<string, unknown>) => {
      const value = ready(); value.items[0].status = { code: 'DELIVERED', header: 'The shipment item has been delivered to the recipient' };
      value.items[0].events.push({ eventDescription: 'The shipment item has been delivered.', eventTime: '2026-01-05T12:00:00.000Z',
        status: 'DELIVERED', location: { countryCode: 'SE', locationType: 'SERVICE_POINT', name: 'Example Service Point' }, ...scan });
      return value;
    };
    expect(parsePostnord(delivered({}), NUMBER)).toMatchObject({ status: 'delivered', pickup_point: 'Example Service Point\nExample Square 1\n111 11 Example Town' });
    const dropped = delivered({}); delete dropped.servicePoint;
    expect(parsePostnord(dropped, NUMBER).pickup_point).toBe('Example Service Point');
    // Delivered somewhere else, or taken back out for delivery first: no pickup point.
    for (const value of [
      delivered({ location: { countryCode: 'SE', locationType: 'DEPOT', name: 'Example Terminal' } }),
      delivered({ location: { countryCode: 'SE' } }),
    ]) expect(parsePostnord(value, NUMBER)).not.toHaveProperty('pickup_point');
    const redelivered = delivered({});
    redelivered.items[0].events.splice(4, 0, { ...redelivered.items[0].events[1], eventTime: '2026-01-05T08:00:00.000Z' });
    expect(parsePostnord(redelivered, NUMBER)).not.toHaveProperty('pickup_point');
  });

  it('reads a late drop-off as accepted and leaves out a sender or country the portal does not give', () => {
    expect(classifyPostnordStatus('EN_ROUTE', 'The shipment item has been dropped off after latest drop-off time.'))
      .toEqual({ status: 'in_transit', stage: 'accepted' });
    const value = payload(); value.sender = { name: ' ' }; value.receiver.address.countryCode = 'Sweden';
    expect(parsePostnord(value, NUMBER)).not.toHaveProperty('sender_name');
    expect(parsePostnord(value, NUMBER)).not.toHaveProperty('destination_country');
  });

  it('takes the milestone of the newest scan under EN_ROUTE\'s heading', () => {
    // Live shape: the heading stays the same while the status description names the drop-off.
    const dropped = payload();
    dropped.items[0].status = { code: 'EN_ROUTE', header: 'The shipment item is under transportation',
      description: 'The shipment item has been dropped off by sender.' };
    dropped.items[0].events = [payload().items[0].events[0],
      { ...payload().items[0].events[1], eventDescription: 'The shipment item has been dropped off by sender.', location: { countryCode: 'PL' } }];
    expect(parsePostnord(dropped, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'accepted',
      last_status_text: 'The shipment item has been dropped off by sender.' });
    // A later scan of the parcel moving moves the summary with it.
    dropped.items[0].events.push({ ...payload().items[0].events[1], eventTime: '2026-01-03T10:00:00.000Z', status: 'OTHER' });
    expect(parsePostnord(dropped, NUMBER)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'The shipment item is under transportation.' });
    // A scan outside EN_ROUTE's milestones leaves the summary to the code.
    const ready = payload(); ready.items[0].events.splice(4, 2);
    ready.items[0].status = { code: 'EN_ROUTE', header: 'The shipment item is under transportation' };
    expect(parsePostnord(ready, NUMBER)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'The shipment item is under transportation' });
  });

  it('rejects missing, mismatched, ambiguous and group identities', () => {
    const wrongShipment = payload(); wrongShipment.shipmentId = OTHER_NUMBER;
    const wrongSelected = payload(); wrongSelected.actualReturnedId = OTHER_NUMBER;
    const wrongItem = payload(); wrongItem.items[0].itemId = OTHER_NUMBER;
    const duplicate = payload(); duplicate.items.push(duplicate.items[0]);
    const group = payload(); group.items[0].itemId = OTHER_NUMBER; group.actualReturnedId = OTHER_NUMBER;
    for (const value of [null, {}, { ...payload(), items: [] }, { ...payload(), items: [null] }, wrongShipment, wrongSelected, wrongItem, duplicate, group]) {
      expect(() => parsePostnord(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    // An unrelated item never determines the requested item's summary or history.
    const multiple = payload(); multiple.items.unshift({ ...payload().items[0], itemId: OTHER_NUMBER, status: { code: 'RETURNED' }, events: [] });
    expect(parsePostnord(multiple, NUMBER)).toMatchObject({ status: 'delivered', events: expect.any(Array) });
  });

  it('sorts scans by instant while preserving offsets and distinct tied scans', () => {
    const value = payload();
    value.items[0].events[3].eventTime = '2026-01-04T13:01:00+02:00';
    const result = parsePostnord(value, NUMBER);
    expect(result.last_update).toBe('2026-01-04T12:00:00Z');
    expect(result.events?.[1]?.time).toBe('2026-01-04T13:01:00+02:00');
    value.items[0].events.push({ ...value.items[0].events[1], status: 'OTHER', eventDescription: 'The shipment item has been loaded.', eventTime: '2026-01-04T12:00:00Z' });
    value.items[0].events.push(structuredClone(value.items[0].events[4]));
    expect(parsePostnord(value, NUMBER).events).toHaveLength(6);
    expect(parsePostnord(value, NUMBER).events?.slice(0, 2).map((event) => event.provider_code)).toEqual(['OTHER', 'DELIVERED']);
  });

  it('reads a relayed scan without a place on its country\'s wall clock, unless a post delivering abroad relays it', () => {
    const relayed = (country: string, eventTime: string, status = 'OTHER', eventDescription = 'The shipment item is under transportation.') =>
      ({ eventDescription, eventTime, status, location: { countryCode: country, locationType: 'UNDEF' } });
    const value = payload();
    value.items[0].events = [
      relayed('PL', '2026-10-23T10:23:00.000Z', 'EN_ROUTE', 'The shipment item has been dropped off by sender.'),
      // The same departure, labelled with its instant and with its wall clock.
      relayed('PL', '2026-10-24T02:13:00.000Z'), relayed('PL', '2026-10-24T04:13:00.000Z'),
      relayed('DK', '2026-10-24T09:12:00.000Z'),
      relayed('US', '2026-10-24T21:19:00.000Z'),
      relayed('SE', '2026-10-25T12:35:58.000Z', 'OTHER', 'Import Charge sent to recipient.'),
      relayed('DE', '2026-10-26T12:51:00.000Z'),
    ];
    value.items[0].status = { code: 'EN_ROUTE', header: 'The shipment item is under transportation.' };
    const clocks = (result: ReturnType<typeof parsePostnord>) => result.events?.map((event) => event.time ?? `local ${event.local_time}`);
    expect(clocks(parsePostnord(value, NUMBER))).toEqual([
      '2026-10-26T12:51:00+01:00', // to Sweden: Deutsche Post's scan is the origin post's
      '2026-10-25T12:35:58Z', // to the second: PostNord's own instant
      'local 2026-10-24T21:19:00.000', // a country of several clocks
      '2026-10-24T09:12:00+02:00',
      '2026-10-24T02:13:00Z',
      '2026-10-23T10:23:00+02:00',
    ]);
    expect(parsePostnord(value, NUMBER).last_update).toBe('2026-10-26T12:51:00+01:00');
    // Germany's post, delivering there, relays its instants.
    value.receiver.address.countryCode = 'DE';
    expect(clocks(parsePostnord(value, NUMBER))?.[0]).toBe('2026-10-26T12:51:00Z');
    // Nothing tells a foreign post's side without a destination.
    delete value.receiver;
    expect(clocks(parsePostnord(value, NUMBER))?.at(-1)).toBe('2026-10-23T10:23:00Z');
    // A newest scan on a wall clock alone leaves no instant for the update.
    value.receiver = { address: { countryCode: 'SE' } };
    value.items[0].events = [relayed('US', '2026-10-24T21:19:00.000Z'), relayed('SE', '2026-10-23T09:00:00.000Z')];
    expect(parsePostnord(value, NUMBER)).toMatchObject({ last_update: null, events: [{ local_time: '2026-10-24T21:19:00.000' }, { time: '2026-10-23T09:00:00+02:00' }] });
  });

  it('reads a terminal\'s scan to the minute on its country\'s wall clock', () => {
    const scan = (eventTime: string, locationType = 'HUB', name = 'SYNTHETIC BREVTERMINAL', countryCode = 'SE') =>
      ({ eventDescription: 'The shipment item is under transportation.', eventTime, status: 'EN_ROUTE', location: { countryCode, locationType, name } });
    const value = payload();
    value.items[0].events = [
      scan('2026-10-27T15:28:00.000Z'), scan('2026-10-27T15:29:00.000Z'),
      scan('2026-10-27T16:55:06.665Z'), // to the millisecond: the terminal's instant
      scan('2026-10-28T09:05:00.000Z', 'SLINGA', 'Synthetic Town'), // a round's scans come to the second
      scan('2026-10-28T10:00:00.000Z', 'HUB', 'SYNTHETIC HUB', 'DE'),
    ];
    value.items[0].status = { code: 'EN_ROUTE', header: 'The shipment item is under transportation.' };
    expect(parsePostnord(value, NUMBER).events?.map((event) => event.time)).toEqual([
      '2026-10-28T10:00:00Z', '2026-10-28T09:05:00Z', '2026-10-27T16:55:06.665Z', '2026-10-27T15:29:00+01:00', '2026-10-27T15:28:00+01:00',
    ]);
  });

  it('removes only confirmed administrative OTHER rows after validation and treats notice-only replies as inconclusive', () => {
    const value = payload();
    value.items[0].events = [
      'Suggested delivery time.',
      'Information to the driver added by the recipient.',
      'A text message notification has been delivered to the recipient.',
      'A text message notification has been sent to the recipient.',
      'A letter notification has been sent to the recipient.',
      'E-mail notification has been sent to the recipient.',
      'Notification sent via APP.',
      'Pick-up at servicepoint, selected by the receiver.',
    ].map((eventDescription) => ({ ...payload().items[0].events[5], eventDescription }));
    expect(() => parsePostnord(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    value.items[0].events[0].eventTime = 'invalid';
    expect(() => parsePostnord(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    value.items[0].events = [{ ...payload().items[0].events[5], eventDescription: 'Unfamiliar provider wording' }];
    expect(parsePostnord(value, NUMBER).events).toEqual([expect.objectContaining({ description: 'Unfamiliar provider wording', provider_code: 'OTHER' })]);
    expect(parsePostnord(value, NUMBER).events?.[0]).not.toHaveProperty('stage');
  });

  it('rejects incomplete scans, invalid dates and unknown-offset clocks', () => {
    for (const scan of [null, {}, { ...payload().items[0].events[5], eventDescription: '' },
      { ...payload().items[0].events[5], status: null },
      ...['2026-01-04T12:01:00', '2026-02-30T12:01:00Z', '2026-01-04', '2026-01-04T12:01:00+99:00', ''].map((eventTime) => ({ ...payload().items[0].events[5], eventTime }))]) {
      const value = payload(); value.items[0].events.push(scan);
      expect(() => parsePostnord(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = payload(); empty.items[0].events = [];
    expect(() => parsePostnord(empty, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const noSummary = payload(); delete noSummary.items[0].status;
    expect(() => parsePostnord(noSummary, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const tooMany = payload(); tooMany.items[0].events = Array.from({ length: 501 }, () => payload().items[0].events[0]);
    expect(() => parsePostnord(tooMany, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([
    ['AVAILABLE_FOR_DELIVERY', 'The shipment item has been delivered to a service point.', 'in_transit', 'ready_for_pickup'],
    ['DELIVERY_IMPOSSIBLE', 'Delivery was not possible.', 'exception', 'failed_attempt'],
    ['RETURNED', 'Returned', 'exception', 'returned'],
    ['CUSTOMS_STOPPED_VAT', 'Stopped', 'exception', 'customs'],
    ['EN_ROUTE', 'The delivery of the shipment item is in progress.', 'out_for_delivery', 'out_for_delivery'],
    ['OTHER', 'The shipment item has been loaded.', 'in_transit', 'in_transit'],
    ['EN_ROUTE', 'The shipment item has been dropped off by sender.', 'in_transit', 'accepted'],
    ['EN_ROUTE', 'The shipment item has been picked-up for transportation.', 'in_transit', 'accepted'],
    ['EN_ROUTE', 'Customs VAT has been paid.', 'in_transit', 'customs'],
    ['OTHER', 'Import Charge sent to recipient.', 'in_transit', 'customs'],
    ['STOPPED', 'The shipment item is being customs cleared by us.', 'in_transit', 'customs'],
    ['STOPPED', 'The shipment item is being held at a distribution terminal awaiting the booked delivery date or, awaiting an agreement of delivery with the recipient.', 'in_transit', 'in_transit'],
    ['STOPPED', 'The shipment item has been stored.', 'exception', 'exception'],
    ['EXPECTED_DELAY', 'The address is incomplete.', 'exception', 'exception'],
  ])('maps %s independently from final-delivery wording', (code, description, status, stage) => {
    expect(classifyPostnordStatus(code, description)).toEqual({ status, stage });
    const value = payload(); value.items[0].status = { code, header: description };
    const result = normalizeCarrierResult(parsePostnord(value, NUMBER));
    expect(result).toMatchObject({ status, current_stage: stage });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it.each([
    ['OTHER', 'A text message notification has been delivered to the recipient.'],
    ['OTHER', 'Notification sent via APP.'],
    ['OTHER', 'Suggested delivery time.'],
    ['OTHER', 'Information to the driver added by the recipient.'],
    ['DELIVERY_TODAY', 'delivery today'],
    ['ESTIMATED_DELIVERY_DAYS', 'Estimated delivery'],
    ['NEW_CODE', 'Delivered'],
  ])('leaves administrative or unproven code %s unmapped', (code, description) => {
    expect(classifyPostnordStatus(code, description)).toBeUndefined();
    const value = payload(); value.items[0].status = { code, header: description };
    const result = parsePostnord(value, NUMBER);
    expect(result.status).toBe('unknown');
    expect(result).not.toHaveProperty('current_stage');
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.last_status_text).toBe(description);
  });

  it('excludes private fields, bounds history and keeps only unambiguous supported measurements', () => {
    const value = payload(); value.items[0].events[0].eventDescription = 'x'.repeat(600);
    expect(JSON.stringify(parsePostnord(value, NUMBER))).not.toMatch(/Private|Address|99999|references|receiver|senderReference|deliveryInformation/);
    expect(parsePostnord(value, NUMBER).events?.at(-1)?.description).toHaveLength(500);
    value.items[0].measurements[3] = { name: 'weight', unit: 'kg', value: 2.5 };
    expect(parsePostnord(value, NUMBER).weight_kg).toBe(2.5);
    for (const measurement of [{ name: 'weight', unit: 'g', value: 0 }, { name: 'weight', unit: 'lb', value: 1 }, { name: 'weight', unit: 'kg', value: -1 }]) {
      value.items[0].measurements[3] = measurement;
      expect(parsePostnord(value, NUMBER)).not.toHaveProperty('weight_kg');
    }
    value.items[0].measurements[0].unit = 'mm';
    expect(parsePostnord(value, NUMBER)).not.toHaveProperty('dimensions_text');
    value.items[0].measurements.push({ name: 'weight', unit: 'kg', value: 1 }, { name: 'weight', unit: 'g', value: 1000 });
    expect(parsePostnord(value, NUMBER)).not.toHaveProperty('weight_kg');
    value.items[0].events = Array.from({ length: 101 }, (_, index) => ({ ...payload().items[0].events[0], eventTime: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() }));
    expect(parsePostnord(value, NUMBER).events).toHaveLength(100);
  });

  it('sends the complete official anonymous request and a valid fresh proof bound to its number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Origin')).toBe('https://tracking.postnord.com');
      expect(headers.get('x-bap-key')).toBe('web-tracking-sc');
      const decoded = Buffer.from(headers.get('X-CustomHeader')!, 'base64');
      expect(decoded.subarray(64, 66).toString()).toBe('--');
      const nonce = decoded.subarray(66).toString();
      expect(nonce).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
      const digest = createHash('sha512').update(NUMBER + nonce).digest();
      expect(decoded.subarray(0, 64)).toEqual(digest);
      expect(digest[0]).toBe(0);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify(payload()));
    });
    const tracker = new PostnordTracker({ fetcher });
    await tracker.fetch(NUMBER);
    await tracker.fetch(NUMBER);
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe('https://api2.postnord.com/rest/shipment/v1/trackingweb/shipmentInformation');
    expect(Object.fromEntries(url.searchParams)).toEqual({ shipmentId: NUMBER, locale: 'en', timeZone: 'UTC' });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('X-CustomHeader')).not.toBe(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('X-CustomHeader'));
    expect(normalizePostnordNumber('00573 000000000000001')).toBe(NUMBER);
    expect(normalizePostnordNumber('rr 000000005 se')).toBe('RR000000005SE');
    for (const invalid of ['123', 'RR000000006SE', `${NUMBER}?id=other`]) expect(() => normalizePostnordNumber(invalid)).toThrow(InvalidInputError);
  });

  it('requires the observed negative schema and keeps challenges, throttling and outages distinct', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const tracker = new PostnordTracker({ fetcher });
    for (const [status, body, kind] of [
      [404, JSON.stringify({ message: 'Shipment was not found.' }), 'not_found'],
      [404, '<h1>Not Found</h1>', 'indeterminate'],
      [404, '{}', 'indeterminate'],
      [410, JSON.stringify({ message: 'Shipment was not found.' }), 'indeterminate'],
      [403, 'Forbidden', 'challenge'],
      [503, 'Unavailable', 'maintenance'],
    ] as const) {
      fetcher.mockResolvedValue(new Response(body, { status }));
      await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind });
    }
    fetcher.mockResolvedValue(new Response('Too many requests', { status: 429, headers: { 'Retry-After': '600' } }));
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 600_000 });
    fetcher.mockResolvedValue(new Response('{}'));
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    fetcher.mockResolvedValue(new Response('<h1>Unexpected service page</h1>'));
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('recognizes a number through the same lookup, unknown only on the structured negative', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(payload())));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-01-04T12:00:00.000Z' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Shipment was not found.' }), { status: 404 }));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: false });
    fetcher.mockResolvedValueOnce(new Response('<h1>Not Found</h1>', { status: 404 }));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    fetcher.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    fetcher.mockClear();
    await expect(instance.recognize!('RR000000006SE')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('honors cancellation before proof generation and during the fetch, and exhausted budgets make no request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const tracker = new PostnordTracker({ fetcher });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(tracker.fetch(NUMBER, { signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(tracker.fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    fetcher.mockImplementation(async (_url, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    await expect(tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
