import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, EvriUkTracker } from './adapter.js';
import { requestEvriUkInPage } from './browser.js';
import { EVRI_UK_MOBILE_API, readEvriUkMobile } from './mobile.js';
import { evriUkTrackingUrl, normalizeEvriUkNumber, parseEvriUk } from './parser.js';
import { statusMap } from './status.js';

// All identifiers, clocks, credentials and private-field markers here are invented.
const NUMBER = 'H000000000000001';
const URN = `urn:parcel_id:barcode:date:123456:${NUMBER}:2026-01-03`;
const history = () => JSON.parse(readFileSync(new URL('./fixtures/history.json', import.meta.url), 'utf8'));
const search = () => ({ parcels: [{ brand: { name: 'EVRI' }, identifiers: [
  { type: 'PARCEL_ID', value: '123456' }, { type: 'BARCODE', value: NUMBER },
] }] });

class FixedDate extends Date {
  constructor() { super('2026-01-03T10:00:00Z'); }
}

async function inPage(replies: Response[], overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const response = replies.shift();
    if (!response) throw new Error('Unexpected request');
    return Promise.resolve(response);
  };
  const run = runInNewContext(`(${requestEvriUkInPage.toString()})`, {
    location: { origin: 'https://www.evri.com', pathname: '/track-a-parcel' },
    AwsWafIntegration: { getToken: async () => 'SYNTHETIC_WAF_TOKEN', fetch: fetcher },
    fetch: fetcher, AbortSignal, TextDecoder, URL, Date: FixedDate, ...overrides,
  }) as typeof requestEvriUkInPage;
  return { result: await run({ number: NUMBER, budgetMs: 1_000 }), calls };
}

const keys = () => Response.json({ keys: { 'spa-customer-track-key': 'SYNTHETIC_CUSTOMER_KEY', 'spa-track-key': 'SYNTHETIC_TRACK_KEY' } });

describe('Evri UK anonymous history', () => {
  it('projects actual scans, preserves their codes, and excludes progress rails and private fields', () => {
    const result = parseEvriUk(history(), NUMBER, URN);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-03T19:00:00Z' });
    expect(result.events).toHaveLength(6);
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'out_for_delivery', 'in_transit', 'in_transit', 'registered']);
    expect(result.events?.every(event => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|FUTURE_STAGE|proof/);
  });

  it.each(['wrong barcode', 'contradictory barcode', 'wrong urn'])('rejects %s', (kind) => {
    const payload = history();
    if (kind === 'wrong barcode') payload.results[0].parcelIdentifiers[0].value = 'H000000000000002';
    if (kind === 'contradictory barcode') payload.results[0].parcelIdentifiers.push({ type: 'BARCODE', value: 'H000000000000002' });
    if (kind === 'wrong urn') payload.results[0].uniqueId += ':different';
    expect(() => parseEvriUk(payload, NUMBER, URN)).toThrow('requested parcel');
  });

  it.each([{}, { results: [], failures: [] }, { results: [null], failures: [] }, { results: [], failures: [{}] }])('rejects incomplete envelopes: %j', payload => {
    expect(() => parseEvriUk(payload, NUMBER, URN)).toThrow();
  });

  it.each([{}, [], [null], [{ dateTime: '2026-01-03T09:00:00Z' }]])('does not turn malformed or empty history into success: %j', events => {
    const payload = history(); payload.results[0].trackingEvents = events;
    expect(() => parseEvriUk(payload, NUMBER, URN)).toThrow();
  });

  it('keeps unknown future wording unstaged and redacts unmapped delivery prose', () => {
    const payload = history();
    payload.results[0].trackingEvents = [
      { trackingPoint: { trackingPointCode: 'FUTURE', description: 'Your parcel will be delivered tomorrow' }, trackingStage: { trackingStageCode: 'UNKNOWN' }, dateTime: '2026-01-03T19:00:00Z' },
      { trackingPoint: { trackingPointCode: 'UNKNOWN', description: 'Delivered by PRIVATE RECIPIENT' }, trackingStage: { trackingStageCode: 'UNKNOWN' }, dateTime: '2026-01-03T18:00:00Z' },
    ];
    const result = parseEvriUk(payload, NUMBER, URN);
    expect(result.status).toBe('unknown');
    expect(result.events?.[0]).toMatchObject({ description: 'Your parcel will be delivered tomorrow' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(result.events?.[1]).toMatchObject({ description: 'Delivery update' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it("reads a ParcelShop collection as delivered without the collector's wording", () => {
    const payload = history();
    payload.results[0].trackingEvents = [
      { trackingPoint: { trackingPointCode: 'SYNTHETIC_COLLECTED_POINT', description: 'Collected by PRIVATE RECIPIENT' },
        trackingStage: { trackingStageCode: '5_SHOP' }, dateTime: '2026-01-03T19:00:00Z' },
    ];
    const result = parseEvriUk(payload, NUMBER, URN);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', delivered_at: '2026-01-03T19:00:00Z' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('retains partial-clock provider order without assigning an overseas zone', () => {
    const payload = history();
    payload.results[0].trackingEvents.reverse();
    payload.results[0].trackingEvents[2].dateTime = '2026-01-03T10:00:00';
    const result = parseEvriUk(payload, NUMBER, URN);
    expect(result.events?.[0]?.provider_code).toBe('1/EXPECTED');
    expect(result.events?.[2]).toMatchObject({ provider_time_text: '2026-01-03T10:00:00' });
    expect(result.events?.[2]).not.toHaveProperty('time');
  });

  const scan = (stageCode: string, code: string, dateTime: string, extra: Record<string, unknown> = {}) => ({
    trackingPoint: { trackingPointCode: code, description: 'Synthetic scan' }, trackingStage: { trackingStageCode: stageCode }, dateTime, ...extra,
  });

  it('reads the newest delivery window on the British clock until a later scan replaces it', () => {
    const payload = history();
    const window = { eta: { start: '2026-07-03T18:00:00Z', end: '2026-07-03T20:00:00Z' } };
    payload.results[0].trackingEvents = [scan('4_COURIER', 'DELIVERY_1900_2100', '2026-07-03T11:00:00Z', window), scan('3', 'LOCAL_DEPOT', '2026-07-03T05:00:00Z')];
    expect(parseEvriUk(payload, NUMBER, URN)).toMatchObject({ status: 'out_for_delivery', expected_delivery: '2026-07-03 19:00–21:00' });
    payload.results[0].trackingEvents.unshift(scan('4_COURIER', 'NOT_DELIVERED_BUSINESS_CLOSED', '2026-07-03T19:30:00Z'));
    expect(parseEvriUk(payload, NUMBER, URN)).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', expected_delivery: null });
    payload.results[0].trackingEvents.unshift(scan('5_COURIER', 'DELIVERED', '2026-07-04T12:00:00Z'));
    const delivered = parseEvriUk(payload, NUMBER, URN);
    expect(delivered).toMatchObject({ status: 'delivered', expected_delivery: null, delivered_at: '2026-07-04T12:00:00Z' });
  });

  it.each([{ start: '2026-07-03T20:00:00Z', end: '2026-07-03T18:00:00Z' }, { start: '2026-07-03T18:00:00', end: '2026-07-03T20:00:00' }, 'PRIVATE'])('ignores an unusable window: %j', eta => {
    const payload = history();
    payload.results[0].trackingEvents = [scan('4_COURIER', 'DELIVERY_1900_2100', '2026-07-03T11:00:00Z', { eta })];
    expect(parseEvriUk(payload, NUMBER, URN)).toMatchObject({ status: 'out_for_delivery', expected_delivery: null });
  });

  it.each([
    ['0', 'RETURN_REQUEST_RECEIVED', 'registered', 'pending'],
    ['2', 'ARRIVED_PARCELSHOP', 'accepted', 'in_transit'],
    ['2', 'COLLECTED_BY_EVRI', 'accepted', 'in_transit'],
    ['2', 'QUADIENT_LOCKER_DROPOFF', 'accepted', 'in_transit'],
    ['2', 'PROCESSING_HUB', 'in_transit', 'in_transit'],
    ['2', 'PROCESSING_RETURN', 'returned', 'exception'],
    ['4', 'PARCEL_WAY_BACK_TO_RETAILER', 'returned', 'exception'],
    ['4_COURIER', 'COURIER_REATTEMPT_CUSTOMER_NOT_AVAILABLE', 'failed_attempt', 'exception'],
    ['4_COURIER', 'REDELIVER_WORKDAY_COURIER', 'failed_attempt', 'exception'],
    ['4_COURIER', 'NOT_DELIVERED_BUSINESS_CLOSED', 'failed_attempt', 'exception'],
    ['4_COURIER', 'REDELIVERY_1300_1500', 'out_for_delivery', 'out_for_delivery'],
    ['4_SHOP', 'ARRIVED_PARCELSHOP', 'ready_for_pickup', 'out_for_delivery'],
    ['4_LOCKER', 'SYNTHETIC_LOCKER_POINT', 'ready_for_pickup', 'out_for_delivery'],
    ['5_SHOP', 'SYNTHETIC_COLLECTED_POINT', 'delivered', 'delivered'],
  ])('files rail %s point %s as %s', (stageCode, code, stage, status) => {
    const payload = history();
    payload.results[0].trackingEvents = [scan(stageCode, code, '2026-07-03T11:00:00Z')];
    const result = parseEvriUk(payload, NUMBER, URN);
    expect(result.status).toBe(status);
    expect(result.events?.[0]).toMatchObject({ stage, provider_code: `${stageCode}/${code}` });
    // The scan keeps its rail with its tracking point, which the parcel app's review reads.
    const { provider_code: kept, description } = result.events![0]!;
    expect(statusMap.stage(kept ?? null, normalizeStatusWording(description ?? ''))).toBe(stage);
  });

  it('names the delivery service Evri gives the parcel', () => {
    const payload = history();
    expect(parseEvriUk(payload, NUMBER, URN)).not.toHaveProperty('service_name');
    payload.results[0].service = { serviceType: ' Next Day  Delivery ' };
    expect(parseEvriUk(payload, NUMBER, URN).service_name).toBe('Next Day Delivery');
    payload.results[0].service = { serviceType: 2 };
    expect(parseEvriUk(payload, NUMBER, URN)).not.toHaveProperty('service_name');
  });

  it("names a business sender, but not a consumer's or the retailer a return goes back to", () => {
    const payload = history();
    Object.assign(payload.results[0], { c2cClient: false, returnParcel: false, sender: { displayName: '  Example  Retail ', name: 'PRIVATE SENDER' } });
    expect(parseEvriUk(payload, NUMBER, URN).sender_name).toBe('Example Retail');
    for (const flags of [{ c2cClient: true }, { returnParcel: true }, { c2cClient: undefined }]) {
      const other = history();
      Object.assign(other.results[0], { c2cClient: false, returnParcel: false, sender: { displayName: 'PRIVATE PERSON' } }, flags);
      expect(parseEvriUk(other, NUMBER, URN)).not.toHaveProperty('sender_name');
    }
  });

  it.each(['2026-01-03T10:00:00', '2026-02-30T10:00:00Z', '2026-01-03T10:00:00+14:01'])('rejects activity consisting entirely of unresolved clocks: %s', clock => {
    const payload = history(); payload.results[0].trackingEvents.forEach((event: { dateTime: string }) => { event.dateTime = clock; });
    expect(() => parseEvriUk(payload, NUMBER, URN)).toThrow('no dated parcel activity');
  });

  it('normalizes the documented parcel format', async () => {
    expect(normalizeEvriUkNumber('h000 0000 0000 0001')).toBe(NUMBER);
    expect(evriUkTrackingUrl(NUMBER)).toContain(`/parcel/${NUMBER}/details`);
    expect(() => normalizeEvriUkNumber('12345678')).toThrow('16-character');
    expect(() => new EvriUkTracker().fetch('wrong')).toThrow('16-character');
  });
});

describe('Evri UK guest API', () => {
  const reference = (identifiers: unknown[] = [{ urn: URN, redirectUrl: null }]) => Response.json({ parcelIdentifiers: identifiers });
  const rejected = (status: number) => Response.json({ errors: [{ status, errorType: 'SyntheticException', message: 'PRIVATE_MARKER' }] }, { status });
  const service = (replies: Response[]) => {
    const calls: Array<{ url: string; headers: Headers; signal?: AbortSignal | null }> = [];
    const fetcher = ((url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), signal: init?.signal });
      const response = replies.shift();
      return response ? Promise.resolve(response) : Promise.reject(new Error('Unexpected request'));
    }) as typeof fetch;
    return { calls, fetcher };
  };
  const read = (fetcher: typeof fetch) =>
    readEvriUkMobile(NUMBER, { fetcher, userAgent: 'Host/1.0', signal: new AbortController().signal, timeoutMs: 1_000 });

  it('resolves the barcode to its handle and reads the bound history over plain HTTP with the included key', async () => {
    const { calls, fetcher } = service([reference(), Response.json(history())]);
    const result = await read(fetcher);
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-01-03T19:00:00Z' });
    expect(result.events).toHaveLength(6);
    expect(calls.map(call => call.url)).toEqual([`${EVRI_UK_MOBILE_API}/parcels/reference/${NUMBER}`,
      `${EVRI_UK_MOBILE_API}/parcels/?uniqueIds=${encodeURIComponent(URN)}`]);
    const key = calls[0]!.headers.get('apiKey');
    expect(key).toMatch(/^\w{32}$/);
    expect(calls.every(call => call.headers.get('apiKey') === key && call.headers.get('user-agent') === 'Host/1.0'
      && call.signal instanceof AbortSignal)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SYNTHETIC/);
  });

  it.each([
    ['no parcel', () => reference([])],
    ['several parcels', () => reference([{ urn: URN, redirectUrl: null }, { urn: URN, redirectUrl: null }])],
    ['an international redirect', () => reference([{ urn: URN, redirectUrl: 'https://private.example/opaque' }])],
    ['a rejected reference', () => rejected(400)],
    ['an unknown reference', () => rejected(404)],
  ])('leaves %s inconclusive without asking for history', async (_, reply) => {
    const { calls, fetcher } = service([reply()]);
    await expect(read(fetcher)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'parcel_unconfirmed' });
    expect(calls).toHaveLength(1);
  });

  it.each(['another barcode', 'another shape', 'a missing handle'])('rejects %s before asking for history', async kind => {
    const urn = kind === 'another barcode' ? URN.replace(NUMBER, 'H000000000000002') : kind === 'another shape' ? `${URN}&x=1` : undefined;
    const { calls, fetcher } = service([reference([{ urn, redirectUrl: null }])]);
    await expect(read(fetcher)).rejects.toMatchObject({ kind: 'schema' });
    expect(calls).toHaveLength(1);
  });

  it('keeps empty and failed history inconclusive and a foreign history a schema error', async () => {
    const empty = history(); empty.results = [];
    await expect(read(service([reference(), Response.json(empty)]).fetcher)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'parcel_unconfirmed' });
    await expect(read(service([reference(), rejected(400)]).fetcher)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'parcel_unconfirmed' });
    const foreign = history(); foreign.results[0].parcelIdentifiers[0].value = 'H000000000000002';
    await expect(read(service([reference(), Response.json(foreign)]).fetcher)).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([
    [401, 'challenge'], [403, 'challenge'], [404, 'transport'], [410, 'transport'], [429, 'rate_limited'],
    [500, 'indeterminate'], [503, 'maintenance'],
  ])('keeps a bare HTTP %s a %s failure, never a missing parcel', async (status, kind) => {
    const { calls, fetcher } = service([new Response('<html>PRIVATE_MARKER</html>', { status, headers: { 'retry-after': '120' } })]);
    const failure = await read(fetcher).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 120_000 } : {}) });
    expect((failure as { reason?: string }).reason).toBeUndefined();
    const visible = JSON.stringify(failure) + String((failure as Error).message);
    expect(visible).not.toMatch(/PRIVATE_MARKER/);
    expect(visible).not.toContain(calls[0]!.headers.get('apiKey'));
    expect(failure).not.toHaveProperty('request');
  });

  it('reports malformed replies and transport failures without their contents', async () => {
    await expect(read(service([new Response('not JSON')]).fetcher)).rejects.toMatchObject({ kind: 'schema' });
    await expect(read(service([Response.json({ parcelIdentifiers: 'PRIVATE_MARKER' })]).fetcher)).rejects.toMatchObject({ kind: 'schema' });
    const failure = await read(service([]).fetcher).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: 'transport' });
    expect(failure).not.toHaveProperty('cause');
  });
});

describe('Evri UK recognition', () => {
  const recognize = (replies: Response[], number = NUMBER) => {
    const calls: string[] = [];
    const fetcher = ((url: string | URL) => {
      calls.push(String(url));
      const response = replies.shift();
      return response ? Promise.resolve(response) : Promise.reject(new Error('Unexpected request'));
    }) as typeof fetch;
    return { calls, answer: adapter({ fetcher, env: {}, userAgent: 'Host/1.0', recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: '/nonexistent/chromium' }).recognize!(number, { budgetMs: 1_000 }) };
  };
  const reference = (identifiers: unknown[]) => Response.json({ parcelIdentifiers: identifiers });

  it('knows a barcode from the reference lookup alone', async () => {
    const { calls, answer } = recognize([reference([{ urn: URN, redirectUrl: null }])]);
    await expect(answer).resolves.toEqual({ known: true, lastActivityAt: null });
    expect(calls).toEqual([`${EVRI_UK_MOBILE_API}/parcels/reference/${NUMBER}`]);
  });

  it.each([
    ['no parcel', () => reference([])],
    ['a parcel Evri International follows', () => reference([{ urn: URN, redirectUrl: 'https://private.example/opaque' }])],
    ['a barcode rejected for its check digit', () => Response.json({ errors: [{ status: 400, errorType: 'InvalidReferenceException', message: 'PRIVATE_MARKER' }] }, { status: 400 })],
  ])('reads %s as unknown', async (_, reply) => {
    await expect(recognize([reply()]).answer).resolves.toEqual({ known: false });
  });

  it.each([
    ['several parcels', () => reference([{ urn: URN, redirectUrl: null }, { urn: URN, redirectUrl: null }]), 'indeterminate'],
    ['another rejection', () => Response.json({ errors: [{ status: 404, errorType: 'SyntheticException' }] }, { status: 404 }), 'indeterminate'],
    ['a bare server error', () => new Response('', { status: 500 }), 'indeterminate'],
    ['a refused key', () => new Response('', { status: 403 }), 'challenge'],
    ['a rate limit', () => new Response('', { status: 429 }), 'rate_limited'],
    ['another barcode', () => reference([{ urn: URN.replace(NUMBER, 'H000000000000002'), redirectUrl: null }]), 'schema'],
  ])('keeps %s from reading as unknown', async (_, reply, kind) => {
    await expect(recognize([reply()]).answer).rejects.toMatchObject({ kind });
  });

  it('asks nothing about a number that is not a barcode', async () => {
    const { calls, answer } = recognize([], 'H00000000000001');
    await expect(answer).resolves.toEqual({ known: false });
    expect(calls).toHaveLength(0);
  });

  it('is asked about lettered barcodes beside Evri International, and about all-digit ones with a GS1 check digit', () => {
    // Made-up barcodes whose last digit passes the check.
    expect(recognitionAskedCarriers('H00AAA0000000006')).toEqual(['evri-uk', 'evri']);
    expect(recognitionAskedCarriers('C00HHA0000000000')).toEqual(['evri-uk']);
    expect(recognitionAskedCarriers('1234567890123452')).toContain('evri-uk');
    expect(recognitionAskedCarriers('1234567890123453')).not.toContain('evri-uk');
  });
});

describe('Evri UK tiers', () => {
  const reference = () => Response.json({ parcelIdentifiers: [{ urn: URN, redirectUrl: null }] });
  const steps = () => {
    const seen: Array<{ step: string; outcome: string }> = [];
    return { seen, recorder: { step: (event: { step: string; outcome: string }) => { seen.push({ step: event.step, outcome: event.outcome }); }, lookup: () => {} } };
  };

  it('answers from the guest API without a browser', async () => {
    const replies = [reference(), Response.json(history())];
    const { seen, recorder } = steps();
    const result = await new EvriUkTracker({ recorder, fetcher: (() => Promise.resolve(replies.shift()!)) }).fetch(NUMBER);
    expect(result.events).toHaveLength(6);
    expect(seen).toEqual([{ step: 'direct', outcome: 'ok' }]);
  });

  it('does not open the page for a parcel the history service did not confirm', async () => {
    const { seen, recorder } = steps();
    const tracker = new EvriUkTracker({ recorder, executablePath: '/nonexistent/chromium',
      fetcher: (() => Promise.resolve(Response.json({ parcelIdentifiers: [] }))) });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'parcel_unconfirmed' });
    expect(seen).toEqual([{ step: 'direct', outcome: 'indeterminate' }]);
  });

  it('lets the page recover a refused key', async () => {
    const { seen, recorder } = steps();
    const tracker = new EvriUkTracker({ recorder, executablePath: '/nonexistent/chromium',
      fetcher: (() => Promise.resolve(new Response('', { status: 403 }))) });
    await expect(tracker.fetch(NUMBER, { budgetMs: 5_000 })).rejects.toBeDefined();
    expect(seen.map(event => event.step)).toEqual(['direct', 'browser']);
    expect(seen[0]).toEqual({ step: 'direct', outcome: 'challenge' });
  });
});

describe('Evri UK page protocol', () => {
  it('uses fresh rotating keys only inside the page and binds the UTC-day URN', async () => {
    const { result, calls } = await inPage([keys(), Response.json(search()), Response.json(history())]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('Expected history');
    expect(parseEvriUk(result.payload, NUMBER, result.urn).events).toHaveLength(6);
    // The page's scans keep the same rail and tracking point codes as the guest API's.
    expect(parseEvriUk(result.payload, NUMBER, result.urn).events?.map(event => event.provider_code))
      .toEqual(parseEvriUk(history(), NUMBER, URN).events?.map(event => event.provider_code));
    expect(calls.map(call => call.url)).toEqual(['/protected/keys.json', `https://api.evri.com/customer-tracking/v1/search/${NUMBER}`,
      `https://tracking.platform-apis.evri.com/v1/parcels?uniqueIds=${encodeURIComponent(URN)}`]);
    expect(calls.every(call => call.init.signal instanceof AbortSignal)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_.*KEY|SYNTHETIC_WAF_TOKEN|PRIVATE/);
  });

  it('carries the delivery window and a business sender across the browser boundary', async () => {
    const payload = history();
    Object.assign(payload.results[0], { c2cClient: false, returnParcel: false, sender: { displayName: 'Example Retail', client: { clientId: 'PRIVATE_CLIENT' } } });
    payload.results[0].trackingEvents.shift();
    payload.results[0].trackingEvents[0].eta = { start: '2026-01-03T19:00:00Z', end: '2026-01-03T21:00:00Z', private: 'PRIVATE_MARKER' };
    const { result } = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    if (result.kind !== 'ok') throw new Error('Expected history');
    expect(parseEvriUk(result.payload, NUMBER, result.urn)).toMatchObject({ expected_delivery: '2026-01-03 19:00–21:00', sender_name: 'Example Retail' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    Object.assign(payload.results[0], { c2cClient: true, sender: { displayName: 'PRIVATE PERSON' } });
    const consumer = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    expect(consumer.result.kind).toBe('ok');
    expect(JSON.stringify(consumer.result)).not.toContain('PRIVATE');
  });

  it.each([401, 403, 405, 429, 503])('returns the key rejection without sending search/history: HTTP %s', async status => {
    const { result, calls } = await inPage([new Response('', { status, headers: { 'retry-after': '120' } })]);
    expect(result).toMatchObject({ kind: 'http', phase: 'keys', status, retryAfter: '120' });
    expect(calls).toHaveLength(1);
  });

  it.each(['missing', 'ambiguous', 'foreign', 'redirect', 'wrong barcode', 'duplicate identifier'])('stops before history for %s search', async kind => {
    const payload = search();
    if (kind === 'missing') payload.parcels = [];
    if (kind === 'ambiguous') payload.parcels.push(payload.parcels[0]!);
    if (kind === 'foreign') payload.parcels[0]!.brand.name = 'OTHER';
    if (kind === 'redirect') Object.assign(payload.parcels[0]!, { externalRedirectUrl: 'https://private.example/opaque' });
    if (kind === 'wrong barcode') payload.parcels[0]!.identifiers[1]!.value = 'H000000000000002';
    if (kind === 'duplicate identifier') payload.parcels[0]!.identifiers.push({ type: 'BARCODE', value: NUMBER });
    const { result, calls } = await inPage([keys(), Response.json(payload)]);
    expect(result.kind).not.toBe('ok');
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('private.example');
  });

  it('bounds declared and streamed JSON bodies and rejects invalid JSON', async () => {
    for (const reply of [new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '100001' } }),
      new Response(' '.repeat(100001), { headers: { 'content-type': 'application/json' } }),
      new Response('invalid JSON', { headers: { 'content-type': 'application/json' } })]) {
      expect((await inPage([reply])).result.kind).toBe('schema');
    }
  });

  it.each(['dateTime', 'trackingPointCode', 'trackingStageCode', 'description', 'uniqueId'])('rejects a nested private object in %s before crossing the browser boundary', async field => {
    const payload = history();
    const marker = { nested: { address: 'PRIVATE_MARKER' } };
    if (field === 'uniqueId') payload.results[0].uniqueId = marker;
    else if (field === 'dateTime') payload.results[0].trackingEvents[0].dateTime = marker;
    else if (field === 'trackingStageCode') payload.results[0].trackingEvents[0].trackingStage.trackingStageCode = marker;
    else payload.results[0].trackingEvents[0].trackingPoint[field] = marker;
    const { result } = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    expect(result.kind).toBe(field === 'uniqueId' ? 'identity' : 'schema');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MARKER');
  });

  it('rejects excessive history before copying scans across the browser boundary', async () => {
    const payload = history();
    payload.results[0].trackingEvents = Array.from({ length: 501 }, () => payload.results[0].trackingEvents[0]);
    const { result } = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    expect(result.kind).toBe('schema');
    expect(result).not.toHaveProperty('payload');
  });

  it('rejects contradictory history barcodes and exports only the exact lookup identity', async () => {
    const payload = history();
    payload.results[0].parcelIdentifiers.push({ type: 'MERCHANT_REFERENCE', value: 'PRIVATE_MARKER' });
    const success = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    expect(success.result.kind).toBe('ok');
    expect(JSON.stringify(success.result)).not.toContain('PRIVATE_MARKER');
    payload.results[0].parcelIdentifiers.push({ type: 'BARCODE', value: 'H000000000000002' });
    const wrong = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    expect(wrong.result.kind).toBe('identity');
    expect(wrong.result).not.toHaveProperty('payload');
  });

  it.each(['dateTime', 'pointCode', 'stageCode', 'description'])('rejects nested private %s fields before browser projection', async field => {
    const payload = history();
    const row = payload.results[0].trackingEvents[0];
    const nested = { private: 'PRIVATE_NESTED_MARKER' };
    if (field === 'dateTime') row.dateTime = nested;
    if (field === 'pointCode') row.trackingPoint.trackingPointCode = nested;
    if (field === 'stageCode') row.trackingStage.trackingStageCode = nested;
    if (field === 'description') row.trackingPoint.description = nested;
    const { result } = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    expect(result).toMatchObject({ kind: 'schema', phase: 'history' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_NESTED_MARKER');
  });

  it('bounds scan count and scalar lengths before browser projection', async () => {
    for (const field of ['count', 'dateTime', 'pointCode', 'stageCode', 'description']) {
      const payload = history();
      const row = payload.results[0].trackingEvents[0];
      if (field === 'count') payload.results[0].trackingEvents = Array.from({ length: 501 }, () => row);
      if (field === 'dateTime') row.dateTime = 'x'.repeat(65);
      if (field === 'pointCode') row.trackingPoint.trackingPointCode = 'x'.repeat(65);
      if (field === 'stageCode') row.trackingStage.trackingStageCode = 'x'.repeat(65);
      if (field === 'description') row.trackingPoint.description = 'x'.repeat(1001);
      const { result } = await inPage([keys(), Response.json(search()), Response.json(payload)]);
      expect(result).toMatchObject({ kind: 'schema', phase: 'history' });
    }
  });

  it('rejects a foreign execution context before obtaining any keys', async () => {
    const { result, calls } = await inPage([], { location: { origin: 'https://private.example', pathname: '/track-a-parcel' } });
    expect(result.kind).toBe('context'); expect(calls).toHaveLength(0);
  });
});
