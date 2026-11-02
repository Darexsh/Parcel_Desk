import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import type { CarrierEvent } from '../../core/result/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, parseUPSApiResponse, parseUPSTrackingResponse, upsTrackingUrl, UPSTracker } from './adapter.js';
import { UPS_API_URL, UPSApiClient, upsApiCredentials, type UPSApiCredentials } from './api.js';

// 1Z999AA10123456784 is a made-up number in UPS's published format, and the
// credentials and tokens below are placeholders. The fixtures carry PRIVATE …
// values where UPS returns recipient, shipper, payment and signature details.
const TRACKING_NUMBER = '1Z999AA10123456784';
// The same number with a check digit that does not match.
const BAD_CHECK_DIGIT = '1Z999AA10123456785';
// A made-up 26-digit USPS package number with a valid check digit.
const POSTAL_PIC = '92612900000000000000123454';
const CREDENTIALS: UPSApiCredentials = { id: 'test-client-id', secret: 'test-client-secret', url: UPS_API_URL };
const TOKEN_URL = `${UPS_API_URL}/security/v1/oauth/token`;
const TRACK_URL = `${UPS_API_URL}/api/track/v1/details/${TRACKING_NUMBER}`;
const STATUS_API = 'https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US';
const TRAWL_URL = 'http://trawl.internal:8191';
const API_REPLY = JSON.parse(
  readFileSync(new URL('./fixtures/api-out-for-delivery.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const PAGE_REPLY = JSON.parse(
  readFileSync(new URL('./fixtures/out-for-delivery.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const TODAY = new Date('2026-08-04T06:00:00Z');

type Item = Record<string, unknown>;

/** The fixture's only package, changed by `edit` first. */
function apiFixture(edit: (item: Item) => void = () => {}): Record<string, unknown> {
  const payload = structuredClone(API_REPLY);
  edit((payload.trackResponse as { shipment: { package: Item[] }[] }).shipment[0]!.package[0]!);
  return payload;
}

/** One synthetic scan in the API's shape. */
function activity(code: string, description: string, clock: Item = {}, type = 'I'): Item {
  return {
    location: { address: { city: 'EXAMPLE CITY', stateProvince: 'XX', countryCode: 'US' } },
    status: { type, description, code },
    date: '20260804', time: '100000', gmtDate: '20260804', gmtTime: '14:00:00', gmtOffset: '-04:00',
    ...clock,
  };
}

/** UPS's reply for a number it has no tracking for. */
const NOT_FOUND = { trackResponse: { shipment: [{ inquiryNumber: TRACKING_NUMBER, userRelation: [], warnings: [{ code: 'TW0001', message: 'Tracking Information Not Found' }] }] } };
const NOT_FOUND_ERROR = { response: { errors: [{ code: 'TW0001', message: 'Tracking Information Not Found' }] } };

function tokenReply(token = 'test-access-token', expiresIn = '14399'): Response {
  return Response.json({ token_type: 'Bearer', issued_at: '1', client_id: 'test-client-id', access_token: token, expires_in: expiresIn, status: 'approved' });
}

function trawlReply(payload: unknown): Response {
  return Response.json({
    tier: 2, statusCode: 200, url: upsTrackingUrl(TRACKING_NUMBER), html: '<html><body>tracking</body></html>',
    cookies: [], userAgent: 'Mozilla/5.0 (test browser)',
    capturedResponses: [{ url: STATUS_API, status: 200, headers: {}, body: JSON.stringify(payload), truncated: false, base64Encoded: false, error: null }],
  });
}

/** Answers each request with the next reply, and keeps what was asked. */
function fetchSequence(...replies: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request to ${String(url)}`);
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

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

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}

/** Everything an error carries, causes included, as text. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth += 1) {
    parts.push(current.message, JSON.stringify(current), JSON.stringify(Object.entries(current)));
  }
  return parts.join('\n');
}

describe('UPS API credentials', () => {
  it('needs both credentials, and an https URL to point them elsewhere', () => {
    expect(upsApiCredentials({})).toBeNull();
    expect(upsApiCredentials({ UPS_CLIENT_ID: 'id', UPS_CLIENT_SECRET: ' ' })).toBeNull();
    expect(upsApiCredentials({ UPS_CLIENT_ID: ' id ', UPS_CLIENT_SECRET: 'secret' })).toEqual({ id: 'id', secret: 'secret', url: UPS_API_URL });
    expect(upsApiCredentials({ UPS_CLIENT_ID: 'id', UPS_CLIENT_SECRET: 'secret', UPS_API_URL: 'https://wwwcie.ups.com/api' }))
      .toMatchObject({ url: 'https://wwwcie.ups.com' });
    expect(upsApiCredentials({ UPS_CLIENT_ID: 'id', UPS_CLIENT_SECRET: 'secret', UPS_API_URL: 'http://wwwcie.ups.com' }))
      .toMatchObject({ url: '' });
  });

  it('adds the api step only for a deployment with credentials', () => {
    const environment = { recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null };
    expect(adapter({ ...environment, env: {} }).steps).toEqual(['direct', 'trawl']);
    expect(adapter({ ...environment, env: { UPS_CLIENT_ID: 'id', UPS_CLIENT_SECRET: 'secret' } }).steps).toEqual(['api', 'direct', 'trawl']);
  });
});

describe('UPS API reply', () => {
  it('reads the same shipment as the page, each scan at the same instant', () => {
    const result = parseUPSApiResponse(API_REPLY, TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'out_for_delivery',
      current_stage_source: 'carrier_map',
      last_status_text: 'Out For Delivery Today',
      last_update: '2026-08-04T09:12:04+02:00',
      expected_delivery: '2026-08-04',
      destination_country: 'CH',
      service_name: 'UPS Standard',
    });
    const mapped = { stage_source: 'carrier_map' };
    expect(result.events).toEqual([
      { time: '2026-08-04T09:12:04+02:00', location: 'Zuerich, Switzerland', description: 'Out For Delivery Today', provider_code: 'OT', stage: 'out_for_delivery', ...mapped },
      { time: '2026-08-04T05:03:51+02:00', location: 'Zuerich, Switzerland', description: 'Arrived at Facility', provider_code: 'AR', stage: 'in_transit', ...mapped },
      { time: '2026-08-03T23:41:10+02:00', location: 'Koeln, Germany', description: 'Departed from Facility', provider_code: 'DP', stage: 'in_transit', ...mapped },
      { time: '2026-08-02T18:00:00+02:00', location: 'Germany', description: 'Shipper created a label, UPS has not received the package yet.', provider_code: 'MP', stage: 'registered', ...mapped },
    ]);
    const page = parseUPSTrackingResponse(PAGE_REPLY, TRACKING_NUMBER, TODAY);
    expect(result.events?.slice(0, 3).map((event) => event.time)).toEqual(page.events?.map((event) => event.time));
  });

  it('lets a scan read from the API and the page take over the row the other stored at its instant', () => {
    const policy = sameInstantIdentityPolicy('ups', { supportsScanMatching: true });
    const evidence = (event: CarrierEvent) => ({
      stage: event.stage ?? '', description: event.description ?? '', location: event.location ?? '', providerCode: event.provider_code ?? '',
    });
    const api = parseUPSApiResponse(API_REPLY, TRACKING_NUMBER).events!.slice(0, 3).map(evidence);
    // The page's reply as it is stored now, with US places and its country names.
    const page = parseUPSTrackingResponse(PAGE_REPLY, TRACKING_NUMBER, TODAY).events!
      .map(evidence).map((scan) => ({ ...scan, location: scan.location.replace(', CH', ', Switzerland').replace(', DE', ', Germany') }));
    api.forEach((scan, index) => {
      expect(policy?.matches?.(scan, page[index]!)).toBe(true);
      expect(policy?.matches?.(page[index]!, scan)).toBe(true);
    });
    expect(policy?.matches?.(api[0]!, { ...page[0]!, providerCode: 'AR' })).toBe(false);
    expect(policy?.matches?.(api[0]!, { ...page[0]!, location: 'Basel, Switzerland' })).toBe(false);
    expect(policy?.matches?.({ ...api[0]!, location: 'DES MOINES, IA, United States' }, { ...page[0]!, location: 'Des Moines, IA, United States' })).toBe(true);
  });

  it("dates a scan on its place's clock when UPS states the offset the place keeps in the other season", () => {
    const place = { location: { address: { city: 'DIJON', stateProvince: '', countryCode: 'FR' } }, date: '20261027' };
    const events = parseUPSApiResponse(apiFixture((item) => {
      item.activity = [
        activity('KB', 'DELIVERED', { ...place, time: '173950', gmtDate: '20261027', gmtTime: '15:39:50', gmtOffset: '+02:00' }),
        activity('KB', 'DELIVERED', { ...place, time: '173950', gmtDate: undefined, gmtTime: undefined, gmtOffset: '+02:00' }),
      ];
    }), TRACKING_NUMBER).events;
    expect(events?.map(({ time, local_time, time_zone }) => ({ time, local_time, time_zone }))).toEqual([
      { time: '2026-10-27T17:39:50+01:00', local_time: '2026-10-27T17:39:50', time_zone: 'Europe/Paris' },
      { time: '2026-10-27T17:39:50+01:00', local_time: '2026-10-27T17:39:50', time_zone: 'Europe/Paris' },
    ]);
  });

  it('keeps a scan in UTC unless its local reading agrees with the stated offset, and the clock UPS gives without a UTC pair', () => {
    const times = parseUPSApiResponse(apiFixture((item) => {
      item.activity = [
        activity('AR', 'Arrived at Facility'),
        // The local reading is another minute than the UTC pair on the offset.
        activity('AR', 'Arrived at Facility', { time: '110000' }),
        // The API's schema shows the UTC time without colons.
        activity('AR', 'Arrived at Facility', { gmtTime: '74700', time: '034700' }),
        activity('DP', 'Departed from Facility', { gmtDate: undefined, gmtTime: undefined }),
        activity('DP', 'Departed from Facility', { gmtDate: undefined, gmtTime: undefined, gmtOffset: undefined }),
        activity('XD', 'Drop-Off', { time: '', gmtDate: undefined, gmtTime: undefined, gmtOffset: undefined }),
        activity('XD', 'Drop-Off', { date: '20260230', time: '', gmtDate: undefined, gmtTime: undefined, gmtOffset: undefined }),
      ];
    }), TRACKING_NUMBER).events?.map(({ time, local_time, provider_time_text }) => ({ time, local_time, provider_time_text }));
    expect(times).toEqual([
      { time: '2026-08-04T10:00:00-04:00', local_time: undefined, provider_time_text: undefined },
      { time: '2026-08-04T14:00:00+00:00', local_time: undefined, provider_time_text: undefined },
      { time: '2026-08-04T03:47:00-04:00', local_time: undefined, provider_time_text: undefined },
      { time: '2026-08-04T10:00:00-04:00', local_time: undefined, provider_time_text: undefined },
      { time: undefined, local_time: '2026-08-04T10:00:00', provider_time_text: undefined },
      { time: undefined, local_time: '2026-08-04', provider_time_text: undefined },
      { time: undefined, local_time: undefined, provider_time_text: '20260230' },
    ]);
  });

  it('writes US places with their state, and a town UPS capitalises as its page does', () => {
    const places = parseUPSApiResponse(apiFixture((item) => {
      item.activity = [
        activity('AR', 'Arrived at Facility', { location: { address: { city: 'WINSTON-SALEM', stateProvince: 'NC', countryCode: 'US' } } }),
        activity('AR', 'Arrived at Facility', { location: { address: { city: 'Des Moines', stateProvince: 'IA', countryCode: 'US' } } }),
        activity('AR', 'Arrived at Facility', { location: { address: { city: 'EXAMPLE CITY', country: 'Example Country' } } }),
        activity('AR', 'Arrived at Facility', { location: {} }),
      ];
    }), TRACKING_NUMBER).events?.map((event) => event.location);
    expect(places).toEqual(['Winston-Salem, NC, United States', 'Des Moines, IA, United States', 'Example City, Example Country', '']);
  });

  it('lets the newest scan code outrank the status type, which decides only for an unmapped code', () => {
    const delayed = parseUPSApiResponse(apiFixture((item) => {
      item.activity = [activity('Q5', 'We&#39;re sorry this package may experience a temporary delay.', {}, 'X')];
      item.currentStatus = { type: 'X', description: 'Delay', code: 'Q5' };
    }), TRACKING_NUMBER);
    expect(delayed).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(delayed.events?.[0]?.description).toBe("We're sorry this package may experience a temporary delay.");
    for (const [type, status] of [['D', 'delivered'], ['X', 'exception'], ['M', 'pending'], ['I', 'in_transit']] as const) {
      const unmapped = parseUPSApiResponse(apiFixture((item) => {
        item.activity = [activity('X9', 'Wording UPS has not used before', {}, type)];
        item.currentStatus = { type, description: 'Wording UPS has not used before', code: 'X9' };
      }), TRACKING_NUMBER);
      expect(unmapped.status).toBe(status);
      expect(unmapped.current_stage).toBeUndefined();
    }
    // The receiver's delivery instructions are a notice: the label before them decides.
    const instructed = parseUPSApiResponse(apiFixture((item) => {
      item.activity = [activity('L0', 'Delivery instructions have been provided by the receiver.', { gmtDate: '20260805' }, 'I'),
        activity('MP', 'Shipper created a label, UPS has not received the package yet.', {}, 'M')];
      item.currentStatus = { type: 'I', description: 'Delivery instructions have been provided by the receiver.', code: 'L0' };
    }), TRACKING_NUMBER);
    expect(instructed).toMatchObject({ status: 'pending', current_stage: 'registered',
      last_status_text: 'Shipper created a label, UPS has not received the package yet.' });
    expect(instructed.events?.[0]).toMatchObject({ provider_code: 'L0', stage: 'registered', stage_source: 'none' });
    const delivered = parseUPSApiResponse(apiFixture((item) => {
      item.activity = [activity('FS', 'DELIVERED ', {}, 'D')];
      item.deliveryDate = [{ type: 'DEL', date: '20260804' }];
    }), TRACKING_NUMBER);
    expect(delivered).toMatchObject({ status: 'delivered', delivered_at: '2026-08-04T10:00:00-04:00', expected_delivery: null });
    const rescheduled = parseUPSApiResponse(apiFixture((item) => {
      item.deliveryDate = [{ type: 'SDD', date: '20260804' }, { type: 'RDD', date: '20260806' }];
    }), TRACKING_NUMBER);
    expect(rescheduled.expected_delivery).toBe('2026-08-06');
  });

  it('asks the receiver to pay the duties at the codes that say they are due', () => {
    const held = parseUPSApiResponse(apiFixture((item) => {
      item.activity = [activity('OQ', 'Your package is being held until duties and taxes are paid.'),
        activity('Z1', 'Your package is prepared for clearance.')];
    }), TRACKING_NUMBER);
    expect(held.events?.map((event) => [event.provider_code, event.recipient_action ?? null])).toEqual([['OQ', 'duties'], ['Z1', null]]);
  });

  it('names the USPS number of a parcel handed to the post office, and nothing that is not one', () => {
    const handed = (alternate: Item[]) => parseUPSApiResponse(apiFixture((item) => { item.alternateTrackingNumber = alternate; }), TRACKING_NUMBER);
    expect(handed([{ type: 'USPS_PIC', number: POSTAL_PIC }])).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: POSTAL_PIC });
    expect(handed([{ type: 'USPS_PIC', number: 'PRIVATE-NOT-A-PIC' }]).delivery_tracking_number).toBeUndefined();
    expect(handed([{ number: '1Z999AA10123456793' }]).delivery_carrier).toBeUndefined();
  });

  it('keeps the addresses, recipient, signature, payments and references out of the result', () => {
    const serialized = JSON.stringify(parseUPSApiResponse(API_REPLY, TRACKING_NUMBER));
    for (const value of [
      'PRIVATE RECIPIENT', 'PRIVATE DOOR', 'PRIVATE-SIGNATURE-IMAGE', 'PRIVATE-PROOF-OF-DELIVERY', 'PRIVATE SHIPPER',
      '1 PRIVATE ORIGIN STREET', 'PRIVATE ORIGIN CITY', 'PRIVATE ORIGIN POSTCODE', '10 PRIVATE STREET', 'PRIVATE CITY',
      'PRIVATE POSTCODE', 'PRIVATE ATTENTION NAME', 'PRIVATE-REFERENCE', 'PRIVATE-PAYMENT-ID', 'receivedBy', 'weight',
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it('reports a number UPS has no tracking for as not found, and fails closed on other answers', () => {
    expect(() => parseUPSApiResponse(NOT_FOUND, TRACKING_NUMBER)).toThrow(expect.objectContaining({ name: 'NotFoundError' }));
    const warned = structuredClone(NOT_FOUND);
    warned.trackResponse.shipment[0]!.warnings = [{ code: 'TW9999', message: 'Example warning' }];
    expect(() => parseUPSApiResponse(warned, TRACKING_NUMBER)).toThrow(expect.objectContaining({ name: 'SchemaError' }));
    expect(() => parseUPSApiResponse({ response: {} }, TRACKING_NUMBER)).toThrow(expect.objectContaining({ name: 'SchemaError' }));
    expect(() => parseUPSApiResponse(apiFixture((item) => { item.trackingNumber = '1Z999AA10123456793'; }), TRACKING_NUMBER))
      .toThrow('UPS did not return the requested parcel');
    const several = apiFixture();
    const packages = (several.trackResponse as { shipment: { package: Item[] }[] }).shipment[0]!.package;
    packages.push({ ...structuredClone(packages[0]!), trackingNumber: '1Z999AA10123456793', activity: [] });
    expect(parseUPSApiResponse(several, TRACKING_NUMBER).events).toHaveLength(4);
  });
});

describe('UPS API client', () => {
  it('buys a token with the credentials over Basic auth and reads the number with it, once per token', async () => {
    const { calls, fetcher } = fetchSequence(tokenReply(), Response.json(API_REPLY), Response.json(API_REPLY));
    const client = new UPSApiClient(CREDENTIALS, fetcher);
    await client.track(TRACKING_NUMBER, AbortSignal.timeout(5_000), 5_000);
    await client.track(TRACKING_NUMBER, AbortSignal.timeout(5_000), 5_000);
    expect(calls.map((call) => call.url.split('?')[0])).toEqual([TOKEN_URL, TRACK_URL, TRACK_URL]);
    const tokenRequest = calls[0]!.init;
    expect(tokenRequest.method).toBe('POST');
    expect(new Headers(tokenRequest.headers).get('authorization'))
      .toBe(`Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`);
    expect(tokenRequest.body).toBe('grant_type=client_credentials');
    const trackRequest = new Headers(calls[1]!.init.headers);
    expect(trackRequest.get('authorization')).toBe('Bearer test-access-token');
    expect(trackRequest.get('transid')).toMatch(/^[0-9a-f]{32}$/);
    expect(trackRequest.get('transactionsrc')).toBe('universal-parcel-scraper');
    expect(trackRequest.get('transid')).not.toBe(new Headers(calls[2]!.init.headers).get('transid'));
    expect(new URL(calls[1]!.url).searchParams.get('returnSignature')).toBe('false');
    expect(new URL(calls[1]!.url).searchParams.get('returnPOD')).toBe('false');
  });

  it('replaces a token UPS stops accepting once, then remembers credentials it refuses', async () => {
    const { calls, fetcher } = fetchSequence(
      tokenReply('first-token'), new Response('{}', { status: 401 }),
      tokenReply('second-token'), new Response('{}', { status: 401 }),
    );
    const client = new UPSApiClient(CREDENTIALS, fetcher);
    const refused = await failure(client.track(TRACKING_NUMBER, AbortSignal.timeout(5_000), 5_000));
    expect(refused).toMatchObject({ name: 'TransportError', reason: 'credentials_rejected', status: 401 });
    expect(new Headers(calls[3]!.init.headers).get('authorization')).toBe('Bearer second-token');
    // Refused credentials are not offered again for a while.
    await expect(client.track(TRACKING_NUMBER, AbortSignal.timeout(5_000), 5_000)).rejects.toBe(refused);
    expect(calls).toHaveLength(4);
  });

  it('remembers credentials refused for a token, without their secret or a token in any failure', async () => {
    for (const status of [400, 401, 403]) {
      const { calls, fetcher } = fetchSequence(Response.json({ response: { errors: [{ code: '250002', message: 'Invalid Authentication Information.' }] } }, { status }));
      const client = new UPSApiClient(CREDENTIALS, fetcher);
      const error = await failure(client.track(TRACKING_NUMBER, AbortSignal.timeout(5_000), 5_000));
      expect(error).toMatchObject({ name: 'TransportError', reason: 'credentials_rejected' });
      await expect(client.track(TRACKING_NUMBER, AbortSignal.timeout(5_000), 5_000)).rejects.toBe(error);
      expect(calls).toHaveLength(1);
    }
    const offline = fetchSequence(new Error('offline'));
    const error = await failure(new UPSApiClient(CREDENTIALS, offline.fetcher).track(TRACKING_NUMBER, AbortSignal.timeout(5_000), 5_000));
    expect(error).toMatchObject({ name: 'UpstreamNetworkError' });
    expect((error as { request?: unknown }).request).toBeUndefined();
    const throttled = fetchSequence(tokenReply(), new Response('{}', { status: 503 }));
    const outage = await failure(new UPSApiClient(CREDENTIALS, throttled.fetcher).track(TRACKING_NUMBER, AbortSignal.timeout(5_000), 5_000));
    expect(errorText(outage)).not.toMatch(/test-client-secret|test-access-token|dGVzdC1jbGllbnQ/);
  });

  it('reads not found, a refused check digit and a throttle from their HTTP replies', async () => {
    const answer = async (number: string, reply: Response) => failure(
      new UPSApiClient(CREDENTIALS, fetchSequence(tokenReply(), reply).fetcher).track(number, AbortSignal.timeout(5_000), 5_000));
    expect(await answer(TRACKING_NUMBER, Response.json(NOT_FOUND_ERROR, { status: 404 }))).toMatchObject({ name: 'NotFoundError' });
    // A 404 that is not UPS's answer about the number says nothing about the parcel.
    expect(await answer(TRACKING_NUMBER, new Response('<html>Not Found</html>', { status: 404 }))).toMatchObject({ name: 'TransportError', kind: 'transport' });
    expect(await answer(TRACKING_NUMBER, Response.json({ response: { errors: [{ code: '404', message: 'Resource not found' }] } }, { status: 404 })))
      .toMatchObject({ kind: 'transport', message: 'UPS API returned HTTP 404 (404)' });
    const invalid = Response.json({ response: { errors: [{ code: 'TV0001', message: 'Invalid tracking number' }] } }, { status: 400 });
    expect(await answer(BAD_CHECK_DIGIT, invalid.clone())).toMatchObject({ name: 'InvalidInputError', reason: 'wrong_number' });
    expect(await answer(TRACKING_NUMBER, invalid)).toMatchObject({ kind: 'transport', message: 'UPS API returned HTTP 400 (TV0001)' });
    expect(await answer(TRACKING_NUMBER, new Response('{}', { status: 429, headers: { 'Retry-After': '30' } })))
      .toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
  });
});

describe('UPS lookup with the official API', () => {
  const tracker = (fetcher: typeof fetch, recorder: StepRecorder, trawl: TrawlClient | null = new TrawlClient(TRAWL_URL)) =>
    new UPSTracker({ timeoutMs: 5_000, trawl, fetcher, recorder, api: CREDENTIALS });

  it('answers from the API first, without the browser', async () => {
    const { calls, fetcher } = fetchSequence(tokenReply(), Response.json(API_REPLY));
    const { recorder, records } = stepRecorder();
    const result = await tracker(fetcher, recorder).fetch(TRACKING_NUMBER.toLowerCase());
    expect(result).toMatchObject({ status: 'out_for_delivery', tracking_source: 'official-api-response', tracking_url: upsTrackingUrl(TRACKING_NUMBER) });
    expect(calls).toHaveLength(2);
    expect(records).toEqual(['api:ok', 'lookup:api:ok']);
  });

  it('takes the number not found from the API as the answer', async () => {
    const { calls, fetcher } = fetchSequence(tokenReply(), Response.json(NOT_FOUND));
    const { recorder, records } = stepRecorder();
    await expect(tracker(fetcher, recorder).fetch(TRACKING_NUMBER)).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(calls).toHaveLength(2);
    expect(records).toEqual(['api:not_found', 'lookup:api:not_found']);
  });

  it('lets the browser answer after the API refused the credentials, throttled or failed', async () => {
    for (const [replies, outcome] of [
      [[new Response('{}', { status: 401 })], 'transport'],
      [[tokenReply(), new Response('{}', { status: 429 })], 'rate_limited'],
      [[tokenReply(), new Response('{}', { status: 503 })], 'maintenance'],
      [[tokenReply(), Response.json({ trackResponse: {} })], 'schema'],
    ] as const) {
      const { calls, fetcher } = fetchSequence(...replies, trawlReply(PAGE_REPLY));
      const { recorder, records } = stepRecorder();
      const result = await tracker(fetcher, recorder).fetch(TRACKING_NUMBER);
      expect(result).toMatchObject({ tracking_source: 'structured-web-response' });
      expect(calls.at(-1)?.url).toBe(`${TRAWL_URL}/scrape`);
      expect(records).toEqual([`api:${outcome}`, 'trawl:ok', 'lookup:trawl:ok']);
    }
  });

  it('leaves the plain HTTP tier to a deployment without a browser after the API failed', async () => {
    const { calls, fetcher } = fetchSequence(new Response('{}', { status: 403 }), new Response('<html>challenge</html>', { status: 403 }));
    const { recorder, records } = stepRecorder();
    await expect(tracker(fetcher, recorder, null).fetch(TRACKING_NUMBER)).rejects.toMatchObject({ name: 'ChallengeError' });
    expect(calls[1]?.url).toContain('ups.com/track');
    expect(records).toEqual(['api:transport', 'direct:challenge', 'lookup:direct:challenge']);
  });
});
