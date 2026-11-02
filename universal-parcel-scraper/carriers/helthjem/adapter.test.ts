import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, HELTHJEM_ENDPOINT, HELTHJEM_QUERY, HelthjemTracker } from './adapter.js';
import { normalizeHelthjemNumber, parseHelthjem } from './parser.js';
import { helthjemStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '370724769990000014';
const PICKUP = '70724763999000029';
const POSTNORD = '00370724769990000038';
const SUMMARY = '370724769990000045';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

interface Row { apiKey?: unknown; status?: unknown; createdAt?: unknown; location?: unknown; message?: unknown }
interface Parcel { trackingNumber?: unknown; shipmentNumber?: unknown; status?: unknown; isPostnordProduct?: unknown;
  events: Row[]; servicePoint?: unknown; shop?: unknown; [field: string]: unknown }
interface Reply { data: { getParcelTrackingDetails: Parcel }; errors?: unknown }
const edited = (name: string, change: (parcel: Parcel, payload: Reply) => void = () => {}): Reply => {
  const payload = JSON.parse(text(name)) as Reply;
  change(payload.data.getParcelTrackingDetails, payload);
  return payload;
};
const rows = (result: ReturnType<typeof parseHelthjem>) =>
  result.events!.map(event => [event.time, event.provider_code, event.stage ?? null, event.location ?? null]);

describe('Helthjem tracking adapter', () => {
  it('asks the tracking page’s GraphQL service for the number as typed once, and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new HelthjemTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 3707 2476 9990 0000 14 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(HELTHJEM_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init?.body))).toEqual({ operationName: 'GetTracking', variables: { parcelReference: DELIVERED }, query: HELTHJEM_QUERY });
    const headers = new Headers(init?.headers);
    expect(headers.has('Cookie') || headers.has('Authorization') || headers.has('Origin')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'helthjem', step: 'direct', outcome: 'ok' }));
  });

  it('asks only for fields without addresses, postcodes, phone numbers or coordinates', () => {
    expect(HELTHJEM_QUERY).not.toMatch(/address|postal|phone|coordinates|easting|northing|sender|deliveryPoint|noticeData|description|logoUrl|openingHours/i);
  });

  it('reads a home delivery newest first, with its scans’ own offsets, terminals and codes', () => {
    const result = parseHelthjem(JSON.parse(text('delivered')), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Pakken er levert i postkassen din!', last_update: '2026-03-12T03:41:20+01:00',
      delivered_at: '2026-03-12T03:40:55+01:00', expected_delivery: null, sender_name: 'Example Shop' });
    expect(result.pickup_point).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.summary_only).toBeUndefined();
    expect(result.history_truncated).toBeUndefined();
    // The duplicate sorter row is read once; the page hides sorter rows, the adapter keeps them.
    expect(rows(result)).toEqual([
      ['2026-03-12T03:41:20+01:00', 'DELIVERED/013', 'delivered', null],
      ['2026-03-12T03:40:55+01:00', 'DELIVERED/013', 'delivered', null],
      ['2026-03-11T22:10:05+01:00', 'IN_TRANSIT/003', 'in_transit', 'Sampleby'],
      ['2026-03-11T17:04:02+01:00', 'DELIVERING/113', 'in_transit', null],
      ['2026-03-11T17:02:30+01:00', 'IN_TRANSIT/002', 'in_transit', 'Exampletown'],
      ['2026-03-11T17:02:10+01:00', 'IN_TRANSIT/003', 'in_transit', 'ExampletownSorter'],
      ['2026-03-08T21:15:37+01:00', 'REGISTERED/001', 'registered', null],
    ]);
    expect(result.events!.every(event => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events![3]!.description).toBe('Planlagt levering natt til 12. mars!');
  });

  it('reads a parcel booked on the night’s round as in transit until the night, from its booking', () => {
    const result = parseHelthjem(edited('delivered', parcel => {
      parcel.status = 'DELIVERING';
      parcel.events = parcel.events.slice(2);
    }), DELIVERED);
    // The booking comes the day before the round: no courier has the parcel yet.
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Pakken er under transport.',
      last_update: '2026-03-11T22:10:05+01:00', expected_delivery: '2026-03-12' });
    expect(result.delivered_at).toBeUndefined();
    // A scan on the round itself, which no reply showed, would be out for delivery.
    const round = parseHelthjem(edited('delivered', parcel => {
      parcel.status = 'DELIVERING';
      parcel.events = [{ apiKey: '999', status: 'DELIVERING', createdAt: '2026-03-12T01:00:00+01:00', location: null, message: null },
        ...parcel.events.slice(2)];
    }), DELIVERED);
    expect(round).toMatchObject({ current_stage: 'out_for_delivery', expected_delivery: null });
  });

  it('reads a night the courier did not take the parcel out as a delay, and the night a booking names', () => {
    const missed = { apiKey: '057', status: 'DELIVERING', createdAt: '2026-03-12T02:24:28+01:00', location: null,
      message: { content: 'Budet fikk ikke med seg pakken din ut i natt.' } };
    const result = parseHelthjem(edited('delivered', parcel => {
      parcel.status = 'DELIVERING';
      parcel.events = [missed, ...parcel.events.slice(2)];
    }), DELIVERED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Budet fikk ikke med seg pakken din ut i natt.', expected_delivery: null });
    expect(rows(result).slice(0, 3)).toEqual([
      ['2026-03-12T02:24:28+01:00', 'DELIVERING/057', 'in_transit', null],
      ['2026-03-11T22:10:05+01:00', 'IN_TRANSIT/003', 'in_transit', 'Sampleby'],
      ['2026-03-11T17:04:02+01:00', 'DELIVERING/113', 'in_transit', null],
    ]);
    const rebooked = parseHelthjem(edited('delivered', parcel => {
      parcel.status = 'DELIVERING';
      parcel.events = [{ apiKey: '113', status: 'DELIVERING', createdAt: '2026-03-12T10:04:02+01:00', location: null,
        message: { content: 'Planlagt levering natt til 13. mars!' } }, missed, ...parcel.events.slice(2)];
    }), DELIVERED);
    expect(rebooked).toMatchObject({ current_stage: 'in_transit', expected_delivery: '2026-03-13' });
    // A booking in December for a night in January names the coming year's.
    const newYear = parseHelthjem(edited('delivered', parcel => {
      parcel.status = 'DELIVERING';
      parcel.events = [{ apiKey: '113', status: 'DELIVERING', createdAt: '2026-12-31T10:04:02+01:00', location: null,
        message: { content: 'Planlagt levering natt til 1. januar!' } }];
    }), DELIVERED);
    expect(newYear.expected_delivery).toBe('2027-01-01');
    // A day the calendar lacks, or another wording, gives no night.
    for (const content of ['Planlagt levering natt til 31. april!', 'Planlagt levering snart!']) {
      const unread = parseHelthjem(edited('delivered', parcel => {
        parcel.status = 'DELIVERING';
        parcel.events = [{ apiKey: '113', status: 'DELIVERING', createdAt: '2026-04-29T10:04:02+02:00', location: null, message: { content } }];
      }), DELIVERED);
      expect(unread).toMatchObject({ current_stage: 'in_transit', expected_delivery: null });
    }
  });

  it('names the pickup point a parcel waits at by its name alone, and sorts scans by clock', () => {
    const result = parseHelthjem(JSON.parse(text('pickup')), PICKUP);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'Example Kiosk Sampleby',
      sender_name: 'Sample Store', last_status_text: 'Pakken er klar til henting.', last_update: '2026-06-03T09:15:00+02:00' });
    expect(rows(result).map(row => row[1])).toEqual(['READY_FOR_PICKUP/903', 'DELIVERING_TO_STORE/902', 'CONVERTED_TO_STORE/901', 'IN_TRANSIT/002', 'REGISTERED/001']);
    // A scan without wording takes the page's label for its state.
    expect(result.events![1]!.description).toBe('Leveres til hentested');
    const collected = parseHelthjem(edited('pickup', parcel => {
      parcel.status = 'PICKED_UP';
      parcel.events.push({ apiKey: '904', status: 'PICKED_UP', createdAt: '2026-06-04T16:00:00+02:00', location: null, message: { content: 'Synthetic pickup' } });
    }), PICKUP);
    expect(collected).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-06-04T16:00:00+02:00', pickup_point: 'Example Kiosk Sampleby' });
    // A point the parcel is not at, or no longer bound for, is not named.
    const returning = parseHelthjem(edited('pickup', parcel => { parcel.status = 'RETURN_TO_STORE'; }), PICKUP);
    expect(returning).toMatchObject({ current_stage: 'exception' });
    expect(returning.pickup_point).toBeUndefined();
  });

  it('hands a PostNord parcel’s shipment number on for PostNord’s tracker', () => {
    const result = parseHelthjem(JSON.parse(text('postnord')), POSTNORD);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', delivery_carrier: 'postnord',
      delivery_tracking_number: '70724763999000036', sender_name: 'Example Outlet' });
    const malformed = parseHelthjem(edited('postnord', parcel => { parcel.shipmentNumber = 'ABC'; parcel.trackingNumber = '370724769990000038'; }), POSTNORD);
    expect(malformed.delivery_carrier).toBeUndefined();
    expect(malformed.delivery_tracking_number).toBeUndefined();
  });

  it('answers a state without scans as an identity-bound summary', () => {
    expect(parseHelthjem(JSON.parse(text('summary')), SUMMARY)).toEqual({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      current_stage_source: 'carrier_map', last_status_text: 'Leveres', provider_code: 'DELIVERING', summary_only: true,
      last_update: null, expected_delivery: null, events: [] });
    const unknown = parseHelthjem(edited('summary', parcel => { parcel.status = 'PARCEL_WEIGHED'; }), SUMMARY);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'PARCEL_WEIGHED', provider_code: 'PARCEL_WEIGHED', summary_only: true });
    expect(unknown.current_stage).toBeUndefined();
    expect(() => parseHelthjem(edited('summary', parcel => { parcel.status = null; }), SUMMARY))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a new state visible without a stage, and stages the parcel by its own state', () => {
    const result = parseHelthjem(edited('postnord', parcel => {
      parcel.events.unshift({ apiKey: '999', status: 'WEIGHED', createdAt: '2026-03-20T15:00:00+01:00', location: 'Exampletown', message: { content: 'Synthetic scan' } },
        { apiKey: '998', createdAt: '2026-03-20T14:30:00+01:00', location: null, message: null });
    }), POSTNORD);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic scan' });
    expect(result.events!.slice(0, 2)).toEqual([
      { time: '2026-03-20T15:00:00+01:00', description: 'Synthetic scan', location: 'Exampletown', provider_code: 'WEIGHED/999' },
      { time: '2026-03-20T14:30:00+01:00', description: '998', provider_code: '998' },
    ]);
  });

  it('caps long histories', () => {
    const long = parseHelthjem(edited('postnord', parcel => {
      parcel.events.push(...Array.from({ length: 120 }, (_, index) => ({ apiKey: '003', status: 'IN_TRANSIT',
        createdAt: `2026-03-19T09:${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}+01:00`, location: 'Exampletown',
        message: { content: 'Pakken er under transport.' } })));
    }), POSTNORD);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ current_stage: 'in_transit', history_truncated: true });
  });

  it('drops addresses, postcodes, phone numbers and the long help text even if the service sends them', () => {
    const result = parseHelthjem(edited('pickup', parcel => {
      parcel.servicePoint = { name: 'Example Kiosk Sampleby', address: 'Example Road 1', postalCode: '0001', postalArea: 'SAMPLEBY', phoneNumber: '+47 00000000',
        coordinates: { easting: 1, northing: 2 } };
      parcel.deliveryPoint = { postalCode: '0002', postalArea: 'EXAMPLETOWN', type: 'MAILBOX' };
      parcel.sender = { postalCode: '0003', postalArea: 'SAMPLE CITY' };
      parcel.shop = { id: 7, logoUrl: 'https://example.invalid/logo.png', name: 'Sample Store' };
      parcel.events[0]!.message = { content: 'Nettbutikken har meldt at en pakke er på vei!', description: 'Synthetic help text' };
    }), PICKUP);
    const kept = JSON.stringify(result);
    for (const dropped of ['Example Road', '0001', '0002', '0003', 'SAMPLEBY', 'EXAMPLETOWN', 'SAMPLE CITY', '+47', 'MAILBOX', 'logo', 'Synthetic help text', 'easting']) {
      expect(kept, dropped).not.toContain(dropped);
    }
  });

  it('binds the reply to the whole requested number and rejects malformed parcels', () => {
    expect(parseHelthjem(JSON.parse(text('delivered')), '0037072476999000001 4')).toMatchObject({ current_stage: 'delivered' });
    expect(parseHelthjem(JSON.parse(text('delivered')), '70724763999000012')).toMatchObject({ current_stage: 'delivered' });
    expect(parseHelthjem(JSON.parse(text('pickup')), `401${PICKUP}`)).toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(() => parseHelthjem(JSON.parse(text('delivered')), '370724769990000021')).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A home delivery sent on to a pickup point is relabelled; the reply names the new label and echoes the number asked.
    const relabelled = (parcel: Parcel) => {
      parcel.trackingNumber = '370724769990000069';
      parcel.shipmentNumber = '70724763999000067';
      parcel.status = 'IN_TRANSIT';
      parcel.events = [{ apiKey: '003', status: 'IN_TRANSIT', createdAt: '2026-03-12T00:15:53+01:00', location: null,
        message: { content: 'Pakken sorteres på nytt før den sendes til et hentested.' } }, ...parcel.events.slice(2)];
    };
    expect(parseHelthjem(edited('delivered', relabelled), DELIVERED)).toMatchObject({ current_stage: 'in_transit',
      last_status_text: 'Pakken sorteres på nytt før den sendes til et hentested.', canonical_tracking_number: '370724769990000069' });
    expect(parseHelthjem(edited('delivered', parcel => { relabelled(parcel); parcel.trackingNumber = '00370724769990000069'; }), DELIVERED))
      .toMatchObject({ canonical_tracking_number: '370724769990000069' });
    expect(parseHelthjem(edited('delivered', parcel => { relabelled(parcel); parcel.trackingNumber = null; }), DELIVERED))
      .toMatchObject({ canonical_tracking_number: '70724763999000067' });
    expect(parseHelthjem(JSON.parse(text('delivered')), DELIVERED)).not.toHaveProperty('canonical_tracking_number');
    expect(parseHelthjem(edited('pickup', parcel => { parcel.trackingNumber = '370724769990000069'; parcel.shipmentNumber = '70724763999000067'; }), PICKUP))
      .toMatchObject({ current_stage: 'ready_for_pickup' });
    // Without a scan on the way to a pickup point, or with another number echoed, it is another parcel.
    for (const change of [
      (parcel: Parcel) => { relabelled(parcel); parcel.events = parcel.events.slice(1); },
      (parcel: Parcel) => { relabelled(parcel); parcel.parcelReference = '370724769990000069'; },
    ]) expect(() => parseHelthjem(edited('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (parcel: Parcel) => { delete parcel.trackingNumber; delete parcel.shipmentNumber; },
      (parcel: Parcel) => { parcel.events[0]!.createdAt = '2026-03-12T03:41:20'; },
      (parcel: Parcel) => { parcel.events[0]!.apiKey = null; parcel.events[0]!.status = null; },
      (parcel: Parcel) => { parcel.events[0]!.apiKey = 'X1'; },
      (parcel: Parcel) => { parcel.events[0]!.status = 'not a state'; },
      (parcel: Parcel) => { (parcel as { events: unknown }).events = {}; },
      (parcel: Parcel) => { (parcel.events as unknown[])[0] = 'scan'; },
      (parcel: Parcel) => { parcel.status = 'not a state'; },
    ]) expect(() => parseHelthjem(edited('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [[], null, 'parcel', { data: {} }, { data: { getParcelTrackingDetails: [] } }, { data: null, errors: {} }]) {
      expect(() => parseHelthjem(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('tolerates an error inside the parcel and fails on any other GraphQL error', () => {
    const local = edited('delivered', (parcel, payload) => {
      parcel.shop = null;
      payload.errors = [{ message: 'Synthetic', path: ['getParcelTrackingDetails', 'shop', 'name'], extensions: { code: 'INTERNAL_SERVER_ERROR' } }];
    });
    expect(parseHelthjem(local, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    const failed = { data: { getParcelTrackingDetails: null }, errors: [{ message: 'Synthetic', path: ['getParcelTrackingDetails'], extensions: { code: 'INTERNAL_SERVER_ERROR' } }] };
    expect(() => parseHelthjem(failed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const rejected = { errors: [{ message: 'Synthetic', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] };
    expect(() => parseHelthjem(rejected, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the null parcel as a missing one and recognizes known parcels from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(text('delivered'))).mockResolvedValueOnce(reply(text('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T02:41:20.000Z' });
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const absent = vi.fn<typeof fetch>().mockResolvedValue(reply(text('not-found')));
    await expect(carrier(absent).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads a query the service rejects as a schema change, not a missing parcel', async () => {
    const body = JSON.stringify({ errors: [{ message: 'Synthetic', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body, 400));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('keeps block pages and malformed replies apart from missing parcels', async () => {
    for (const [body, kind] of [
      ['<html><head><title>ERROR: The request could not be satisfied</title></head><body><h2>Request blocked.</h2></body></html>', 'challenge'],
      ['<html><head><title>Just a moment...</title></head></html>', 'challenge'],
      ['<html><body>Maintenance</body></html>', 'schema'], ['{"data":{}}', 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/html' } }));
      await expect(carrier(fetcher).recognize!(DELIVERED), body).rejects.toMatchObject({ kind });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(300_000)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('takes SSCCs and shipment numbers that pass the GS1 check, and nothing else, without a request', async () => {
    expect(normalizeHelthjemNumber('(00) 370724769990000014')).toEqual({ reference: '00370724769990000014', identifier: DELIVERED });
    expect(normalizeHelthjemNumber(`401${PICKUP}`)).toEqual({ reference: `401${PICKUP}`, identifier: PICKUP });
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['370724769990000015', '70724763999000013', '0037072476999000001', '40170724763999000020', 'A-B1C2D', '1234', 'ABC', `${DELIVERED}/x`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    // A shop's own GS1 prefix is still Helthjem's to look up.
    const any = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('not-found')));
    await expect(carrier(any).track({ number: '373332539990000017' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(any).toHaveBeenCalledOnce();
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a parcel filed under Helthjem to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(text('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'helthjem' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'helthjem', source: 'helthjem', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url) === HELTHJEM_ENDPOINT)).toBe(true);
  });

  it('selects Helthjem for SSCCs under its own GS1 prefix whose check digit holds', () => {
    const wrongKey = `${DELIVERED.slice(0, -1)}${(Number(DELIVERED.at(-1)) + 1) % 10}`;
    for (const number of [DELIVERED, `00${DELIVERED}`]) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'helthjem', confidence: 'high' });
    }
    for (const number of [wrongKey, `00${wrongKey}`]) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('helthjem');
    }
    expect(recognitionAskedCarriers('370724769990000015')).not.toContain('helthjem');
    expect(recognitionAskedCarriers('373332539990000017')).not.toContain('helthjem');
    expect(parseTrackingInput(`https://helthjem.no/sporing/${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'helthjem', source: 'link' });
  });
});

describe('Helthjem status vocabulary', () => {
  it('records every state and code with the stage the map gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      const [state, event] = entry.code.split('/');
      expect(helthjemStage(state!, event), entry.code).toBe(entry.stage);
    }
    for (const code of ['constructor', 'toString', '__proto__', '013', '']) expect(statusMap.stage(code, ''), code).toBeUndefined();
    expect(statusMap.stage(null, 'levert')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'helthjem', providerCode: 'DELIVERING/113', description: 'Planlagt levering natt til 12. mars!' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'helthjem', providerCode: 'DELIVERING/999', description: 'Leveres' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'helthjem', providerCode: 'DELIVERING/057', description: 'Budet fikk ikke med seg pakken din ut i natt.' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'helthjem', providerCode: 'WEIGHED/999', description: 'Synthetic scan' })).toEqual({ kind: 'unknown' });
  });
});
