import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { TrawlClient, type TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { adapter, normalizeSwiftxNumber, parseSwiftx, parseSwiftxCapture, swiftxTrackingUrl, SwiftxTracker, swiftxWording } from './adapter.js';
import { SWIFTX_API } from './parser.js';
import { statusMap, swiftxScanStage, swiftxStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'SWX000000000000000001';
const MOVING = 'SWX000000000000000002';
const FAILED = 'SWX000000000000000003';
const UNKNOWN = 'SWX000000000000000009';
// After every synthetic scan.
const READ_AT = Date.parse('2026-06-01T00:00:00Z');
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Result = Record<string, unknown> & { trackingEventList: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(text(name)) as { data: { getOfficialWebsiteTrackingInfoBatch: Record<string, unknown> & { results: Result[] } } };
/** The fixture's one result, as the batch reply carries it. */
const answer = (payload: ReturnType<typeof fixture>) => payload.data.getOfficialWebsiteTrackingInfoBatch.results[0]!;
const reply = (overrides: Record<string, unknown> = {}) => ({ url: SWIFTX_API, status: 200, headers: {}, body: text('delivered'),
  truncated: false, base64Encoded: false, error: null, ...overrides });
const page = (capturedResponses: unknown[]) => ({ url: swiftxTrackingUrl(DELIVERED), html: '', cookies: [], userAgent: null, tier: 3,
  statusCode: 200, capturedResponses, raw: {} }) as TrawlScrapeResponse;

describe('SwiftX numbers', () => {
  it('accepts SWX and eighteen digits in any case and spacing, and nothing else', () => {
    expect(normalizeSwiftxNumber(' swx 000000000-000000001 ')).toBe(DELIVERED);
    expect(swiftxTrackingUrl(DELIVERED)).toBe(`https://swiftx-express.com/track?trackingNumber=${DELIVERED}`);
    for (const raw of ['SWX00000000000000001', 'SWX0000000000000000001', 'SWY000000000000000001', '000000000000000000001', 'SWX00000000000000000A']) {
      expect(() => normalizeSwiftxNumber(raw), raw).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('SwiftX tracking reply', () => {
  it('keeps a bound BASIC summary without scans as recipient input, not a challenge or missing parcel', () => {
    const basic = fixture('delivered');
    Object.assign(answer(basic), { unlockStatus: 'BASIC', trackingEventList: [] });
    expect(() => parseSwiftx(basic, DELIVERED, READ_AT)).toThrow(expect.objectContaining({ kind: 'input_required', field: 'recipient verification' }));
    expect(() => parseSwiftx(basic, MOVING, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    answer(basic).trackingEventList = null as unknown as Record<string, unknown>[];
    expect(() => parseSwiftx(basic, DELIVERED, READ_AT)).toThrow(expect.objectContaining({ kind: 'input_required' }));
    const partial = fixture('delivered');
    answer(partial).unlockStatus = 'BASIC';
    expect(parseSwiftx(partial, DELIVERED, READ_AT)).toMatchObject({ history_truncated: true });
    const missing = fixture('not-found');
    answer(missing).unlockStatus = 'BASIC';
    expect(() => parseSwiftx(missing, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('reads a delivered parcel newest first on each site\'s own offset, with towns only at SwiftX sites', () => {
    const result = parseSwiftx(fixture('delivered'), DELIVERED, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-12T15:41:07-04:00', delivered_at: '2026-03-12T15:41:07-04:00' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-03-12T15:41:07-04:00', 'DELIVERED', 'delivered', undefined],
      ['2026-03-12T08:02:19-04:00', 'OUT_FOR_DELIVERY', 'out_for_delivery', 'EASTFIELD, NY'],
      ['2026-03-11T17:13:52-04:00', 'DELIVERY_FAILED', 'failed_attempt', undefined],
      ['2026-03-11T07:58:40-04:00', 'OUT_FOR_DELIVERY', 'out_for_delivery', 'EASTFIELD, NY'],
      ['2026-03-10T23:36:05-04:00', 'WHS_ARRIVAL_SCAN', 'in_transit', 'EASTFIELD, NY'],
      ['2026-03-10T21:04:33-04:00', 'DESTINATION_HUB_DEPARTURE', 'in_transit', 'HARBOR CITY, NJ'],
      ['2026-03-10T09:27:48-04:00', 'TRANSFER_ARRIVAL_SCAN', 'in_transit', 'HARBOR CITY, NJ'],
      ['2026-03-07T02:19:11-08:00', 'ORIGIN_HUB_DEPARTURE', 'in_transit', 'WESTVALE, CA'],
      ['2026-03-06T22:45:30-08:00', 'PICKUP_ARRIVAL_SCAN', 'in_transit', 'WESTVALE, CA'],
      ['2026-03-05T06:31:58-07:00', 'CREATED', 'registered', undefined],
    ]);
    expect(result.events![2]!.description).toBe('Delivery failed Note: Business was closed during delivery attempt. Please provide alternative delivery instructions.');
    // The recipient's town and postcode, the sites' postcodes, the help line and the proof of delivery stay out.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLETOWN|0000[1-8]|555|example\.com|For assistance|pod/i);
  });

  it('keeps a quoted note without its help line and calls a missing package an exception', () => {
    const result = parseSwiftx(fixture('failed-attempt'), FAILED, READ_AT);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt',
      last_status_text: 'Delivery failed Note: Delivery address could not be located. Please verify the address.' });
    expect(result.delivered_at).toBeUndefined();
    // A label a station created carries its town.
    expect(result.events!.map((event) => event.location)).toEqual([undefined, 'LAKEMONT, CA', 'LAKEMONT, CA']);
    const missing = fixture('failed-attempt');
    answer(missing).trackingEventList[0]!.description = 'Package Missing';
    expect(parseSwiftx(missing, FAILED, READ_AT)).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Package Missing' });
  });

  it('reads single-digit offsets, keeps a failed pickup out of the stage and drops scans after the reply was read', () => {
    const result = parseSwiftx(fixture('in-transit'), MOVING, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-05-03T06:10:44-07:00' });
    expect(result.events!.map((event) => [event.provider_code, event.stage, event.location])).toEqual([
      ['WHS_ARRIVAL_SCAN', 'in_transit', 'HILLCREST, CA'],
      ['SORTING_CENTER_INBOUND_SCAN', 'in_transit', 'WESTVALE, CA'],
      ['PICKUP_FAILED', undefined, undefined],
      ['CREATED', 'registered', undefined],
    ]);
    const early = parseSwiftx(fixture('in-transit'), MOVING, Date.parse('2026-05-02T19:00:00Z'));
    expect(early).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Scheduled pickup failed' });
    expect(early.events!.map((event) => event.provider_code)).toEqual(['PICKUP_FAILED', 'CREATED']);
    expect(() => parseSwiftx(fixture('in-transit'), MOVING, Date.parse('2026-05-01T00:00:00Z'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('is not found only on the tracker\'s notice for the whole number', () => {
    expect(() => parseSwiftx(fixture('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const other = fixture('not-found');
    answer(other).message = 'Service unavailable';
    expect(() => parseSwiftx(other, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSwiftx(fixture('not-found'), DELIVERED, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSwiftx(fixture('delivered'), MOVING, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSwiftx({ errors: [{ message: 'Internal error' }], data: null }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A query without the page's verification gets this notice for any number.
    const unverified = fixture('not-found');
    answer(unverified).message = 'Verification required.';
    expect(() => parseSwiftx(unverified, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSwiftxCapture(page([reply({ body: JSON.stringify(unverified) })]), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    // The batch refuses a query whose verification token is missing or refused, and names no result.
    const refused = { data: { getOfficialWebsiteTrackingInfoBatch: { success: false, message: 'Human verification failed', errorCode: 'HUMAN_VERIFICATION_REQUIRED', results: [] } } };
    expect(() => parseSwiftx(refused, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const sliderRefused = { data: { getOfficialWebsiteTrackingInfoBatch: { ...refused.data.getOfficialWebsiteTrackingInfoBatch,
      errorCode: 'SLIDER_VERIFICATION_FAILED' } } };
    expect(() => parseSwiftx(sliderRefused, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const tooMany = { data: { getOfficialWebsiteTrackingInfoBatch: { ...refused.data.getOfficialWebsiteTrackingInfoBatch, errorCode: 'TOO_MANY_TRACKING_NUMBERS' } } };
    expect(() => parseSwiftx(tooMany, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // One result per lookup: a second or no result is another answer.
    const twice = fixture('not-found');
    twice.data.getOfficialWebsiteTrackingInfoBatch.results.push(answer(fixture('delivered')));
    expect(() => parseSwiftx(twice, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = fixture('delivered');
    answer(empty).trackingEventList = [];
    expect(() => parseSwiftx(empty, DELIVERED, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses clocks without a valid offset and unreadable rows', () => {
    for (const [field, value] of [['localGmtOffset', ''], ['localGmtOffset', 'PST'], ['localGmtOffset', 'GMT-15:00'], ['localTime', '2026-03-12T15:41:07'],
      ['event', ''], ['description', '  ']] as const) {
      const changed = fixture('delivered');
      answer(changed).trackingEventList[3]![field] = value;
      expect(() => parseSwiftx(changed, DELIVERED, READ_AT), `${field} ${value}`).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [null, [], {}, { data: {} }, { data: { getOfficialWebsiteTrackingInfoBatch: { results: [] } } },
      { data: { getOfficialWebsiteTrackingInfoBatch: { success: true, results: [{ trackingNo: DELIVERED }] } } }]) {
      expect(() => parseSwiftx(payload, DELIVERED, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('cleans failed-delivery wording as the tracker shows it', () => {
    expect(swiftxWording('Delivery failed \n Note: Gate was locked. For assistance, please contact SwiftX at +1 555-010-0000 or help@example.com'))
      .toBe('Delivery failed Note: Gate was locked.');
    expect(swiftxWording('Delivery failed, Note: Call +1 555-010-0000')).toBe('Delivery failed, Note: Call');
    expect(swiftxWording('"Out for Delivery"')).toBe('Out for Delivery');
  });
});

describe('SwiftX browser capture', () => {
  it('reads the newest captured reply and keeps refusals, rate limits and gaps distinct', () => {
    const stale = reply({ body: text('not-found') });
    expect(parseSwiftxCapture(page([stale, reply()]), DELIVERED, READ_AT)).toMatchObject({ status: 'delivered' });
    expect(() => parseSwiftxCapture(page([reply({ body: text('not-found') })]), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const [rows, name] of [
      [[], 'ChallengeError'],
      [[reply({ url: `${SWIFTX_API}?other=1` })], 'ChallengeError'],
      [[reply({ status: 403, body: null })], 'ChallengeError'],
      [[reply({ status: 429, body: null, headers: { 'retry-after': '60' } })], 'RateLimitedError'],
      [[reply({ status: 502, body: null })], 'UpstreamHttpError'],
      [[reply({ body: null, error: 'unsupported or oversized tracking response' })], 'TransportError'],
      [[reply({ truncated: true })], 'TransportError'],
      [[reply({ body: '<!DOCTYPE html><title>Just a moment...</title>' })], 'ChallengeError'],
      [[reply({ body: '{"data":' })], 'SchemaError'],
    ] as const) {
      expect(() => parseSwiftxCapture(page([...rows]), DELIVERED, READ_AT), JSON.stringify(rows)).toThrow(expect.objectContaining({ name }));
    }
  });

  it('asks the browser service for the tracking page and its GraphQL reply only', async () => {
    const scrape = vi.fn().mockResolvedValue(page([reply()]));
    const result = await new SwiftxTracker({ trawl: { scrape } as unknown as TrawlClient }).fetch(DELIVERED.toLowerCase(), { budgetMs: 40_000 });
    expect(result.status).toBe('delivered');
    expect(scrape).toHaveBeenCalledOnce();
    const [request, options] = scrape.mock.calls[0]!;
    expect(request).toMatchObject({ url: `https://swiftx-express.com/track?trackingNumber=${DELIVERED}`, skipHttp: true, maxTier: 3,
      captureResponses: [SWIFTX_API], settleTimeout: 10_000 });
    expect(request.maxTimeout).toBeLessThanOrEqual(30_000);
    expect(options).toMatchObject({ provider: 'TRAWL while fetching SwiftX', timeoutMs: request.maxTimeout });
  });

  it('calls the service\'s refusal a challenge only when its browser stood at a check', async () => {
    const service = (body: string, status = 500) => new TrawlClient('http://trawl.test',
      vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } })));
    const failed = (attempt: Record<string, unknown>) => JSON.stringify({ error: 'Max tier reached without success',
      timings: [{ tier: 2, status: 'error', durationMs: 900, reason: 'net::ERR_CONNECTION_RESET' }, { tier: 3, durationMs: 27_500, ...attempt }] });
    // The deadline can run out while tier 3 is still trying; the reply then ends with tier 2.
    const expired = (attempt: Record<string, unknown>) => JSON.stringify({ error: 'Scrape deadline exceeded',
      timings: [{ tier: 2, durationMs: 16_000, ...attempt }] });
    for (const attempt of [
      { status: 'error', reason: 'SwiftX produced no tracking response after submission' },
      { status: 'blocked', reason: 'cloudflare-persistent' },
    ]) {
      for (const body of [failed(attempt), expired(attempt)]) {
        const error = await new SwiftxTracker({ trawl: service(body) }).fetch(DELIVERED, { budgetMs: 40_000 }).catch((caught: unknown) => caught);
        expect(error, body).toMatchObject({ kind: 'challenge', provider: 'SwiftX', cause: expect.objectContaining({ status: 500 }) });
      }
    }
    for (const [body, status] of [
      [failed({ status: 'error', reason: 'Target page, context or browser has been closed' }), 500],
      [failed({ status: 'error', reason: 'SwiftX tracking request failed: net::ERR_FAILED' }), 500],
      [failed({ status: 'timeout', reason: 'deadline' }), 500],
      [expired({ status: 'error', reason: 'net::ERR_CONNECTION_RESET' }), 500],
      [JSON.stringify({ error: 'Scrape deadline exceeded', timings: [] }), 500],
      [JSON.stringify({ error: 'Max tier reached without success', timings: [{ tier: 1, status: 'blocked', statusCode: 403 }] }), 500],
      [JSON.stringify({ error: 'Internal error' }), 500],
      ['{"error":"Max tier', 500],
      [failed({ status: 'blocked', reason: 'cloudflare-persistent' }), 502],
    ] as const) {
      await expect(new SwiftxTracker({ trawl: service(body, status) }).fetch(DELIVERED, { budgetMs: 40_000 }), body)
        .rejects.toMatchObject({ kind: 'indeterminate', status });
    }
  });

  it('needs the browser service and a valid number before any request', async () => {
    await expect(new SwiftxTracker().fetch(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
    const scrape = vi.fn();
    await expect(new SwiftxTracker({ trawl: { scrape } as unknown as TrawlClient }).fetch('SWX123')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(scrape).not.toHaveBeenCalled();
    const environment = { trawl: null, fetcher: vi.fn(), browserExecutablePath: null, env: {} } as never;
    expect(adapter(environment)).toMatchObject({ id: 'swiftx', recordsSteps: true, steps: ['trawl'] });
  });
});

describe('SwiftX status map', () => {
  it('agrees with the recorded codes and wordings', () => {
    for (const entry of statuses.entries) {
      const wording = 'wording' in entry && entry.wording ? entry.wording : 'Synthetic wording';
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(statusMapAnswer({ carrier: 'swiftx', providerCode: entry.code, description: wording }), `${entry.code} ${wording}`)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    const recorded = new Set(statuses.entries.map((entry) => entry.code));
    for (const { code } of statusMap.gaps) expect(recorded.has(code!), code).toBe(true);
    for (const code of ['constructor', 'toString', 'delivered']) expect(swiftxScanStage(code, 'Delivered'), code).toBeUndefined();
    expect(swiftxStage('NEW_CODE', 'Delivered')).toMatchObject({ stage: 'delivered' });
    expect(swiftxStage('PICKUP_FAILED', 'Scheduled pickup failed')).toBe('quiet');
    expect(statusMapAnswer({ carrier: 'swiftx', providerCode: null, description: 'Delivered' })).toEqual({ kind: 'unknown' });
  });
});
