import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, FedExTracker, fedexTrackingUrl, parseFedExApiResponse, parseFedExTrackingResponse } from './adapter.js';
import { FEDEX_API_URL, fedexApiCredentials, type FedExApiCredentials } from './api.js';

// 999999999999 and 999999999998 are made-up numbers in FedEx's published
// format, and the keys and token below are placeholders. The fixture carries
// PRIVATE … values where FedEx returns recipient, shipper and package details.
const DELIVERED_NUMBER = '999999999999';
const OTHER_NUMBER = '999999999998';
const CREDENTIALS: FedExApiCredentials = { key: 'test-api-key', secret: 'test-secret-key', url: FEDEX_API_URL };
const TOKEN_URL = `${FEDEX_API_URL}/oauth/token`;
const TRACK_URL = `${FEDEX_API_URL}/track/v1/trackingnumbers`;
const PAGE_API = 'https://api.fedex.com/track/v2/shipments';
const TRAWL_URL = 'http://trawl.internal:8191';
const API_DELIVERED = JSON.parse(
  readFileSync(new URL('./fixtures/api-delivered.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const PAGE_DELIVERED = JSON.parse(
  readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

type Result = Record<string, unknown>;

/** The fixture's only track result, changed by `edit` first. */
function apiFixture(edit: (result: Result) => void = () => {}): Record<string, unknown> {
  const payload = structuredClone(API_DELIVERED);
  const complete = (payload.output as { completeTrackResults: { trackResults: Result[] }[] }).completeTrackResults;
  edit(complete[0]!.trackResults[0]!);
  return payload;
}

/** An answer for a number FedEx returns with this error and nothing else. */
function apiError(code: string): Record<string, unknown> {
  return apiFixture((result) => {
    for (const key of Object.keys(result)) if (key !== 'trackingNumberInfo') delete result[key];
    result.error = { code, message: 'Synthetic error' };
  });
}

function tokenReply(token = 'test-access-token', expiresIn = 3599): Response {
  return Response.json({ access_token: token, token_type: 'bearer', expires_in: expiresIn, scope: 'CXS' });
}

function trawlReply(payload: unknown): Response {
  return Response.json({
    tier: 3, statusCode: 200, url: fedexTrackingUrl(DELIVERED_NUMBER), html: '<html><body>tracking app</body></html>',
    cookies: [], userAgent: 'Mozilla/5.0 (test browser)',
    capturedResponses: [{ url: PAGE_API, status: 200, headers: {}, body: JSON.stringify(payload), truncated: false, base64Encoded: false, error: null }],
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
  return { fetcher: fetcher as unknown as typeof fetch, calls };
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

afterEach(() => vi.restoreAllMocks());

describe('FedEx official API reply', () => {
  it('reads the API reply as it reads the tracking page reply', () => {
    const result = parseFedExApiResponse(apiFixture(), DELIVERED_NUMBER);
    expect(result).toEqual(parseFedExTrackingResponse(PAGE_DELIVERED, DELIVERED_NUMBER));
    expect(result.events).toEqual([
      { time: '2026-09-02T11:58:00+02:00', location: 'ZUERICH, CH', description: 'Delivered', provider_code: 'DL', stage: 'delivered' },
      { time: '2026-09-01T08:12:00+02:00', location: 'KOELN, DE', description: 'Departed FedEx location', provider_code: 'DP', stage: 'in_transit' },
      { local_time: '2026-08-31', location: 'SEOUL, KR', description: 'Picked up', provider_code: 'PU', stage: 'accepted' },
      { time: '2026-08-30T09:05:00+09:00', location: 'SEOUL, KR', description: 'Shipment information sent to FedEx', provider_code: 'OC', stage: 'registered' },
    ]);
  });

  it('keeps the recipient, shipper, signatory, street, package and service details out of the result', () => {
    const serialized = JSON.stringify(parseFedExApiResponse(apiFixture(), DELIVERED_NUMBER));
    for (const value of ['PRIVATE', 'INTERNATIONAL_PRIORITY', 'International Priority', 'weight', 'dimensions']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('places a scan by its town and its state or province, else its country', () => {
    const result = parseFedExApiResponse(apiFixture((shipment) => {
      shipment.latestStatusDetail = { code: 'AR', description: 'Arrived at FedEx location' };
      shipment.dateAndTimes = [{ type: 'ESTIMATED_DELIVERY', dateTime: '2026-09-04T00:00:00-05:00' }];
      shipment.scanEvents = [
        { date: '2026-09-03T06:10:00-05:00', eventType: 'AR', eventDescription: 'Arrived at FedEx location', scanLocation: { city: 'MEMPHIS', stateOrProvinceCode: 'TN', countryCode: 'US' } },
        { date: '2026-09-02T22:00:00+09:00', eventType: 'DP', eventDescription: 'Departed FedEx location', scanLocation: { countryCode: 'KR' } },
      ];
    }), DELIVERED_NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', expected_delivery: '2026-09-04', last_update: '2026-09-03T06:10:00-05:00' });
    expect(result.events?.map((event) => event.location ?? '')).toEqual(['MEMPHIS, TN', '']);
  });

  it('puts a scan labelled with the offset its state took after it back on the state\'s clock', () => {
    const result = parseFedExApiResponse(apiFixture((shipment) => {
      shipment.latestStatusDetail = { code: 'AR', description: 'Arrived at FedEx location' };
      shipment.scanEvents = [
        { date: '2026-10-31T23:30:00-06:00', eventType: 'AR', eventDescription: 'Arrived at FedEx location', scanLocation: { city: 'EXAMPLE CITY', stateOrProvinceCode: 'TX', countryCode: 'US' } },
        { date: '2026-10-31T23:00:00-05:00', eventType: 'DP', eventDescription: 'Departed FedEx location', scanLocation: { city: 'EXAMPLE CITY', stateOrProvinceCode: 'NC', countryCode: 'US' } },
      ];
    }), DELIVERED_NUMBER, Date.parse('2026-11-01T18:00:00Z'));
    // Texas keeps two clocks, so its label stands.
    expect(result.events?.map((event) => event.time)).toEqual(['2026-10-31T23:30:00-06:00', '2026-10-31T23:00:00-04:00']);
  });

  it('takes the estimated delivery window when FedEx gives no estimated date', () => {
    const result = parseFedExApiResponse(apiFixture((shipment) => {
      shipment.latestStatusDetail = { code: 'OD', description: 'On FedEx vehicle for delivery' };
      shipment.dateAndTimes = [];
      shipment.estimatedDeliveryTimeWindow = { window: { begins: '2026-09-02T09:00:00+02:00', ends: '2026-09-02T13:00:00+02:00' } };
      shipment.scanEvents = [{ date: '2026-09-02T08:01:00+02:00', eventType: 'OD', eventDescription: 'On FedEx vehicle for delivery', scanLocation: { city: 'ZUERICH', countryCode: 'CH' } }];
    }), DELIVERED_NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', expected_delivery: '2026-09-02' });
  });

  it('names the hold location while the parcel waits there, and never a residential one', () => {
    const held = (residential: boolean) => apiFixture((shipment) => {
      shipment.latestStatusDetail = { code: 'HL', description: 'Ready for pickup' };
      shipment.scanEvents = [{ date: '2026-09-02T10:00:00+02:00', eventType: 'HL', eventDescription: 'Ready for pickup', scanLocation: { city: 'ZUERICH', countryCode: 'CH' } }];
      shipment.holdAtLocation = {
        locationId: 'XXXX',
        locationType: 'FEDEX_AUTHORIZED_SHIP_CENTER',
        locationContactAndAddress: {
          contact: { companyName: 'Example Ship Centre', personName: 'PRIVATE CONTACT' },
          address: { streetLines: ['1 Example Street'], city: 'ZUERICH', postalCode: '8000', countryCode: 'CH', residential },
        },
      };
    });
    expect(parseFedExApiResponse(held(false), DELIVERED_NUMBER)).toMatchObject({
      status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: 'Example Ship Centre\n1 Example Street\n8000 ZUERICH',
    });
    expect(parseFedExApiResponse(held(true), DELIVERED_NUMBER).pickup_point).toBeUndefined();
    expect(JSON.stringify(parseFedExApiResponse(held(false), DELIVERED_NUMBER))).not.toContain('PRIVATE');
  });

  it('reports an unknown number as unlocated and a gated shipment as input-required', () => {
    expect(parseFedExApiResponse(apiError('TRACKING.TRACKINGNUMBER.NOTFOUND'), DELIVERED_NUMBER))
      .toMatchObject({ status: 'unknown', events: [] });
    expect(() => parseFedExApiResponse(apiError('TRACKING.AUTHORIZATION.ERROR'), DELIVERED_NUMBER))
      .toThrow(expect.objectContaining({ name: 'InputRequiredError', field: 'recipient verification' }));
  });

  it('fails closed on another parcel, duplicates and invalid envelopes', () => {
    expect(() => parseFedExApiResponse(apiFixture(), OTHER_NUMBER))
      .toThrow(expect.objectContaining({ name: 'SchemaError', message: 'FedEx did not return the requested parcel' }));
    const duplicated = apiFixture();
    const results = (duplicated.output as { completeTrackResults: { trackResults: unknown[] }[] }).completeTrackResults[0]!.trackResults;
    results.push(structuredClone(results[0]));
    expect(() => parseFedExApiResponse(duplicated, DELIVERED_NUMBER))
      .toThrow(expect.objectContaining({ name: 'SchemaError', message: 'FedEx returned several shipments for this number' }));
    for (const payload of [null, {}, { output: {} }, { errors: [{ code: 'SYSTEM.UNAVAILABLE.EXCEPTION' }] }]) {
      expect(() => parseFedExApiResponse(payload, DELIVERED_NUMBER)).toThrow(expect.objectContaining({ name: 'SchemaError' }));
    }
    expect(() => parseFedExApiResponse(apiError('TRACKING.UNEXPECTED.ERROR'), DELIVERED_NUMBER))
      .toThrow(expect.objectContaining({ name: 'SchemaError', message: 'FedEx returned no usable tracking status' }));
  });
});

describe('FedEx official API keys', () => {
  it('reads both keys and an optional https origin from the environment', () => {
    expect(fedexApiCredentials({})).toBeNull();
    expect(fedexApiCredentials({ FEDEX_API_KEY: 'key', FEDEX_SECRET_KEY: ' ' })).toBeNull();
    expect(fedexApiCredentials({ FEDEX_API_KEY: ' key ', FEDEX_SECRET_KEY: 'secret' }))
      .toEqual({ key: 'key', secret: 'secret', url: FEDEX_API_URL });
    expect(fedexApiCredentials({ FEDEX_API_KEY: 'key', FEDEX_SECRET_KEY: 'secret', FEDEX_API_URL: 'https://apis-sandbox.fedex.com/' }))
      .toEqual({ key: 'key', secret: 'secret', url: 'https://apis-sandbox.fedex.com' });
    for (const url of ['http://apis-sandbox.fedex.com', 'not a url']) {
      expect(fedexApiCredentials({ FEDEX_API_KEY: 'key', FEDEX_SECRET_KEY: 'secret', FEDEX_API_URL: url })?.url).toBe('');
    }
  });

  it('adds the API step only when the deployment has keys', () => {
    const environment = { trawl: null, browserExecutablePath: null, recorder: { step: () => {}, lookup: () => {} } };
    expect(adapter({ ...environment, env: {} }).steps).toEqual(['trawl']);
    expect(adapter({ ...environment, env: { FEDEX_API_KEY: 'key', FEDEX_SECRET_KEY: 'secret' } }).steps).toEqual(['api', 'trawl']);
  });
});

describe('FedEx official API lookup', () => {
  it('tracks through the API with one token for several lookups', async () => {
    const { fetcher, calls } = fetchSequence(tokenReply(), Response.json(apiFixture()), Response.json(apiFixture()));
    const { recorder, records } = stepRecorder();
    const tracker = new FedExTracker({ api: CREDENTIALS, trawl: new TrawlClient(TRAWL_URL), fetcher, recorder });

    const result = await tracker.fetch(DELIVERED_NUMBER);
    await tracker.fetch(DELIVERED_NUMBER);

    expect(result).toMatchObject({ status: 'delivered', tracking_source: 'official-api-response', tracking_url: fedexTrackingUrl(DELIVERED_NUMBER) });
    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, TRACK_URL, TRACK_URL]);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body))))
      .toEqual({ grant_type: 'client_credentials', client_id: 'test-api-key', client_secret: 'test-secret-key' });
    expect(new Headers(calls[1]!.init.headers).get('authorization')).toBe('Bearer test-access-token');
    expect(JSON.parse(String(calls[1]!.init.body)))
      .toEqual({ includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber: DELIVERED_NUMBER } }] });
    expect(records).toEqual(['api:ok', 'lookup:api:ok', 'api:ok', 'lookup:api:ok']);
  });

  it('asks for a new token once when FedEx no longer accepts the one it gave', async () => {
    const { fetcher, calls } = fetchSequence(
      tokenReply('first-token'), new Response('{}', { status: 401 }), tokenReply('second-token'), Response.json(apiFixture()));

    await expect(new FedExTracker({ api: CREDENTIALS, fetcher }).fetch(DELIVERED_NUMBER)).resolves.toMatchObject({ status: 'delivered' });

    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, TRACK_URL, TOKEN_URL, TRACK_URL]);
    expect(new Headers(calls[3]!.init.headers).get('authorization')).toBe('Bearer second-token');
  });

  it('falls back to the browser when the API fails, unless the recipient must verify', async () => {
    const { fetcher, calls } = fetchSequence(tokenReply(), new Response('{}', { status: 503 }), trawlReply(PAGE_DELIVERED));
    const { recorder, records } = stepRecorder();

    const result = await new FedExTracker({ api: CREDENTIALS, trawl: new TrawlClient(TRAWL_URL), fetcher, recorder }).fetch(DELIVERED_NUMBER);

    expect(result).toMatchObject({ status: 'delivered', tracking_source: 'structured-web-response' });
    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, TRACK_URL, `${TRAWL_URL}/scrape`]);
    expect(records).toEqual(['api:maintenance', 'trawl:ok', 'lookup:trawl:ok']);

    const gated = fetchSequence(tokenReply(), Response.json(apiError('TRACKING.AUTHORIZATION.ERROR')));
    await expect(new FedExTracker({ api: CREDENTIALS, trawl: new TrawlClient(TRAWL_URL), fetcher: gated.fetcher }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ name: 'InputRequiredError' });
    expect(gated.calls.map((call) => call.url)).toEqual([TOKEN_URL, TRACK_URL]);
  });

  it('answers an unknown number from the API without the browser', async () => {
    const { fetcher, calls } = fetchSequence(tokenReply(), Response.json(apiError('TRACKING.TRACKINGNUMBER.NOTFOUND')));

    await expect(new FedExTracker({ api: CREDENTIALS, trawl: new TrawlClient(TRAWL_URL), fetcher }).fetch(DELIVERED_NUMBER))
      .resolves.toMatchObject({ status: 'unknown', tracking_source: 'official-api-response' });
    expect(calls).toHaveLength(2);
  });

  it('reads a rate limit with its window and lets the browser answer', async () => {
    const { fetcher } = fetchSequence(tokenReply(), new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }));

    await expect(new FedExTracker({ api: CREDENTIALS, fetcher }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ name: 'RateLimitedError', retryAfterMs: 30_000 });
  });

  it('stops offering refused keys for a while', async () => {
    const { fetcher, calls } = fetchSequence(new Response('{"errors":[{"code":"NOT.AUTHORIZED.ERROR"}]}', { status: 401 }));
    const tracker = new FedExTracker({ api: CREDENTIALS, fetcher });

    for (let lookup = 0; lookup < 2; lookup += 1) {
      await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({
        name: 'TransportError', reason: 'credentials_rejected', status: 401,
      });
    }
    expect(calls).toHaveLength(1);
  });

  it('keeps the keys and the token out of every failure', async () => {
    const failures = [
      fetchSequence(new TypeError('fetch failed')),
      fetchSequence(new Response('{}', { status: 500 })),
      fetchSequence(tokenReply(), new TypeError('fetch failed')),
      fetchSequence(tokenReply(), new Response('not json', { status: 200 })),
      fetchSequence(tokenReply(), new Response('{}', { status: 400 })),
    ];
    for (const { fetcher } of failures) {
      const error: unknown = await new FedExTracker({ api: CREDENTIALS, fetcher }).fetch(DELIVERED_NUMBER).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      const seen = JSON.stringify(error, Object.getOwnPropertyNames(error)) + String((error as Error).cause ?? '');
      for (const secret of ['test-api-key', 'test-secret-key', 'test-access-token']) expect(seen).not.toContain(secret);
      expect((error as { request?: unknown }).request).toBeUndefined();
    }
  });

  it('refuses a configured API address that is not https without any request', async () => {
    const { fetcher, calls } = fetchSequence();

    await expect(new FedExTracker({ api: { ...CREDENTIALS, url: '' }, fetcher }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ name: 'TransportError', message: 'FEDEX_API_URL is not an https URL' });
    expect(calls).toHaveLength(0);
  });
});
