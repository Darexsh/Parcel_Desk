import { describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamNetworkError } from '../../core/errors/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, DhlExpressTracker, normalizeNumber, normalizePieceId, parse, parseMobile, parseUnified, parseUnifiedPiece } from './adapter.js';
import { CAPTCHA_MEMORY_MS, HOURLY_REQUESTS, MAX_CAPTCHA_MEMORY_MS, MobilePacedError, SETTINGS_TTL_MS } from './mobile.js';
import { API, ApiPacedError, PAUSE_MS, SPACING_MS } from './api.js';
import { dhlExpressStage } from './status.js';

const number = '1234567891';
const payload = () => ({ results: [{ id: number, duplicate: false, hasDuplicateShipment: false,
  consigneeCountryCode: 'CA', signature: { signatory: 'PRIVATE', link: { url: 'https://example.invalid/private' } },
  checkpoints: [
    { description: 'Delivered', date: 'Monday, October 05, 2026', time: '15:06', location: 'EXAMPLE CITY - CANADA' },
    { description: 'Shipment is out with courier for delivery', date: 'Monday, October 05, 2026', time: '12:35' },
    { description: 'Shipment picked up', date: 'Friday, October 02, 2026', time: '17:18', location: 'EXAMPLE CITY - USA' },
  ] }] });
const unifiedPayload = () => ({ shipments: [{ id: number, service: 'express',
  destination: { address: { countryCode: 'CA', streetAddress: 'PRIVATE' } },
  details: { proofOfDelivery: 'https://example.invalid/private', consignee: 'PRIVATE', pieceIds: ['PRIVATE'] },
  status: { description: 'Delivered', statusCode: 'delivered', timestamp: '2026-10-05T15:06:00-04:00' },
  events: [
    { description: 'Delivered', statusCode: 'delivered', status: 'OK', timestamp: '2026-10-05T15:06:00-04:00', location: { address: { addressLocality: 'EXAMPLE CITY', streetAddress: 'PRIVATE' } } },
    { description: 'Shipment is out with courier for delivery', statusCode: 'transit', status: 'WC', timestamp: '2026-10-05T12:35:00-04:00' },
    { description: 'Shipment picked up', statusCode: 'transit', status: 'PU', timestamp: '2026-10-02T17:18:00-07:00' },
  ] }] });
const captured = (body: unknown = unifiedPayload(), status = 200, url = `https://www.dhl.com/utapi?trackingNumber=${number}`) => ({
  url, status, headers: {}, body: JSON.stringify(body), truncated: false, base64Encoded: false, error: null,
});
const environment = (fetcher: typeof fetch, trawl: TrawlClient | null = null) => ({ fetcher, trawl, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null });
const settings = [{ name: 'api_awb_encryption', value: 'N' }];
const mobilePayload = () => payload().results.map((shipment) => ({ ...shipment, status: '',
  checkpoints: shipment.checkpoints.map((row, index) => ({ ...row, date: 'localized date', date_en: row.date, counter: 3 - index, pIds: ['PRIVATE'] })) }));
const mobileFetcher = (reply: unknown = mobilePayload(), configuration: unknown = settings) => vi.fn<typeof fetch>()
  .mockImplementation(async (_url, init) => new Response(JSON.stringify(JSON.parse(String(init?.body)).method === 'tracking' ? reply : configuration)));
const services = (fetcher: ReturnType<typeof mobileFetcher>) => fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('service'));

describe('DHL Express projection', () => {
  it('distinguishes a matching not-found envelope from malformed or foreign errors', () => {
    const missing = { errors: [{ id: number, code: 404, label: 'Not found' }] };
    expect(() => parse(missing, number)).toThrow(NotFoundError);
    expect(() => parse(missing, '1234567880')).toThrow(SchemaError);
    expect(() => normalizeNumber('1234567890')).toThrow(InvalidInputError);
  });
  it('binds the waybill, maps milestones and preserves facility-local clocks without recipient data', () => {
    const result = parse(payload(), number);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', destination_country: 'CA',
      last_update: null, last_update_local: '2026-10-05T15:06:00', events: [
        { local_time: '2026-10-05T15:06:00', stage: 'delivered' },
        { local_time: '2026-10-05T12:35:00', stage: 'out_for_delivery' }, { local_time: '2026-10-02T17:18:00', stage: 'accepted' },
      ] });
    // A consumer reads an offset-less `time` in the catalog zone, which is UTC here.
    expect(result.events?.some((event) => 'time' in event)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|signature|signatory/);
  });
  it('maps DHL checkpoints that end with their facility, and leaves other wording to the classifier', () => {
    expect([
      'Shipment information received',
      'Processed at EXAMPLE CITY - FRANCE',
      'Arrived at DHL Sort Facility EXAMPLE CITY - FRANCE',
      'Arrived at DHL Delivery Facility EXAMPLE CITY - FRANCE',
      'Shipment has departed from a DHL facility EXAMPLE CITY - FRANCE',
      'Clearance processing complete at EXAMPLE CITY - FRANCE',
    ].map((description) => dhlExpressStage(description))).toEqual([
      { stage: 'registered', source: 'carrier_map' }, { stage: 'in_transit', source: 'carrier_map' },
      { stage: 'in_transit', source: 'carrier_map' }, { stage: 'in_transit', source: 'carrier_map' },
      { stage: 'in_transit', source: 'carrier_map' }, { stage: 'in_transit', source: 'carrier_map' },
    ]);
    // Not the "Processed at" checkpoint: the parcel is in customs.
    expect(dhlExpressStage('Processed for clearance at EXAMPLE CITY - FRANCE')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(dhlExpressStage('Clearance event')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(dhlExpressStage('Shipment accepted')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    // The unified feed's event codes stage wording the map does not know; the wording wins over them.
    expect(dhlExpressStage('Synthetic clearance wording', 'CD')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(dhlExpressStage('Synthetic clearance wording', 'IC')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(dhlExpressStage('Synthetic acceptance wording', 'SA')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    // Fees paid during clearance leave the parcel in customs, coded or not.
    for (const code of ['PY', null]) {
      expect(dhlExpressStage('Payment is received and recorded for shipment related fees', code))
        .toEqual({ stage: 'customs', source: 'carrier_map' });
    }
    expect(dhlExpressStage('Synthetic payment wording', 'PY')).toEqual({ stage: 'customs', source: 'carrier_map' });
    // So does the hold that waits for them until the recipient pays.
    expect(dhlExpressStage('On hold awaiting for payment of shipment related fees')).toEqual({ stage: 'customs', source: 'carrier_map' });
    // The shipper's further data registers the shipment, coded or not.
    for (const code of ['EM', null]) {
      expect(dhlExpressStage('Supplementary information has been received and merged with applicable shipment data', code))
        .toEqual({ stage: 'registered', source: 'carrier_map' });
    }
    // A missort delays the parcel, coded or not.
    for (const code of ['MS', null]) {
      expect(dhlExpressStage('Shipment arrived at incorrect facility. It will be sent to the correct destination', code))
        .toEqual({ stage: 'exception', source: 'carrier_map' });
    }
    expect(dhlExpressStage('Synthetic missort wording', 'MS')).toEqual({ stage: 'exception', source: 'carrier_map' });
    // A wait for collection, a missed delivery and a return, coded or not.
    for (const [description, code, stage] of [
      ['Awaiting collection by the consignee', 'CC', 'ready_for_pickup'],
      ['Delivery attempt could not be completed', 'ND', 'failed_attempt'],
      ['Returned to shipper', 'RT', 'returned'],
    ] as const) {
      for (const coded of [code, null]) expect(dhlExpressStage(description, coded), description).toEqual({ stage, source: 'carrier_map' });
      expect(dhlExpressStage('Synthetic checkpoint', code), code).toEqual({ stage, source: 'carrier_map' });
    }
    expect(dhlExpressStage('Clearance processing complete at EXAMPLE CITY - FRANCE', 'CD').stage).toBe('in_transit');
    expect(dhlExpressStage('Synthetic checkpoint', 'XX').source).not.toBe('carrier_map');
    expect(dhlExpressStage('Customs clearance status updated. Note - The Customs clearance process is under way.'))
      .toEqual({ stage: 'customs', source: 'carrier_map' });
  });
  it('dates a scan where its location settles the facility zone', () => {
    const clock = (location: string, date = 'Monday, October 05, 2026') => {
      const data = payload();
      data.results[0]!.checkpoints = [{ description: 'Processed', date, time: '12:00', location }];
      const result = parse(data, number);
      const scan = result.events![0]!;
      expect(result.last_update).toBe(scan.time ?? null);
      expect('last_update_local' in result).toBe(!scan.time);
      return scan.time ?? `local ${String(scan.local_time)}`;
    };
    // The shapes DHL writes, with the offsets its public page gives those facilities.
    expect(clock('EXAMPLE CITY - FRANCE')).toBe('2026-10-05T12:00:00+02:00');
    expect(clock('EXAMPLE CITY - FRANCE', 'Monday, January 05, 2026')).toBe('2026-01-05T12:00:00+01:00');
    expect(clock('EXAMPLE CITY - NETHERLANDS, THE')).toBe('2026-10-05T12:00:00+02:00');
    expect(clock('EXAMPLE-CITY - UK')).toBe('2026-10-05T12:00:00+01:00');
    expect(clock('EXAMPLE HUB - Ohio - USA')).toBe('2026-10-05T12:00:00-04:00');
    expect(clock('EXAMPLE CITY - New York - USA')).toBe('2026-10-05T12:00:00-04:00');
    expect(clock('EXAMPLE GATEWAY - California - USA')).toBe('2026-10-05T12:00:00-07:00');
    expect(clock('EXAMPLE CITY - VIRGINIA,VA - USA')).toBe('2026-10-05T12:00:00-04:00');
    expect(clock('EXAMPLE CITY - ON - CANADA')).toBe('2026-10-05T12:00:00-04:00');
    expect(clock('EXAMPLE SERVICE AREA - ONTARIO - CANADA')).toBe('2026-10-05T12:00:00-04:00');
    expect(clock('EXAMPLE CITY, CA - USA')).toBe('2026-10-05T12:00:00-07:00');
    // Australia's states by DHL's four letters, their code or name, and gateways named after a capital.
    expect(clock('EXAMPLE CITY - VICT - AUSTRALIA')).toBe('2026-10-05T12:00:00+11:00');
    expect(clock('EXAMPLE CITY - VICT - AUSTRALIA', 'Sunday, June 07, 2026')).toBe('2026-06-07T12:00:00+10:00');
    expect(clock('MELBOURNE - AUSTRALIA')).toBe('2026-10-05T12:00:00+11:00');
    expect(clock('EXAMPLE CITY - QLD - AUSTRALIA')).toBe('2026-10-05T12:00:00+10:00');
    expect(clock('EXAMPLE CITY - SOUTH AUSTRALIA - AUSTRALIA')).toBe('2026-10-05T12:00:00+10:30');
    expect(clock('PERTH - AUSTRALIA')).toBe('2026-10-05T12:00:00+08:00');
    // DHL's own names for countries.
    expect(clock("EXAMPLE CITY - THE PEOPLE'S REPUBLIC OF CHINA")).toBe('2026-10-05T12:00:00+08:00');
    expect(clock('EXAMPLE CITY - CHINA, PEOPLES REPUBLIC')).toBe('2026-10-05T12:00:00+08:00');
    expect(clock('EXAMPLE CITY - HONG KONG SAR, CHINA')).toBe('2026-10-05T12:00:00+08:00');
    expect(clock('EXAMPLE CITY - KOREA, REPUBLIC OF (SOUTH K.)')).toBe('2026-10-05T12:00:00+09:00');
    expect(clock('EXAMPLE CITY - CZECH REPUBLIC, THE')).toBe('2026-10-05T12:00:00+02:00');
    expect(clock('EXAMPLE CITY - IRELAND, REPUBLIC OF')).toBe('2026-10-05T12:00:00+01:00');
    expect(clock('EXAMPLE CITY - TURKEY')).toBe('2026-10-05T12:00:00+03:00');
    expect(clock('EXAMPLE CITY - THAILAND')).toBe('2026-10-05T12:00:00+07:00');
    // Spain and Portugal file their islands under the country: the town tells.
    expect(clock('EXAMPLE CITY - SPAIN')).toBe('2026-10-05T12:00:00+02:00');
    expect(clock('TENERIFE - SPAIN')).toBe('2026-10-05T12:00:00+01:00');
    expect(clock('EXAMPLE CITY - PORTUGAL')).toBe('2026-10-05T12:00:00+01:00');
    expect(clock('PONTA DELGADA - PORTUGAL')).toBe('2026-10-05T12:00:00+00:00');
    // Several clocks and no region DHL names, an unknown country, or no country at all.
    for (const location of ['EXAMPLE CITY - USA', 'EXAMPLE CITY - Example - USA', 'EXAMPLE CITY - CANADA',
      'EXAMPLE CITY - AUSTRALIA', 'EXAMPLE CITY - EXAMPLE - AUSTRALIA',
      'EXAMPLE CITY - UNITED STATES OF AMERICA', 'EXAMPLE CITY - EXAMPLELAND', 'FRANCE', '']) {
      expect(clock(location)).toBe('local 2026-10-05T12:00:00');
    }
  });
  it('rejects a foreign shipment and keeps reused waybills inconclusive', () => {
    expect(() => parse(payload(), '1234567880')).toThrow(SchemaError);
    const duplicate = payload(); duplicate.results[0]!.duplicate = true;
    expect(() => parse(duplicate, number)).toThrow(IndeterminateError);
    expect(() => parse({ results: [payload().results[0], payload().results[0]] }, number)).toThrow(IndeterminateError);
  });
  it('does not invent an instant from an invalid clock or turn empty history into movement', () => {
    const invalid = payload(); invalid.results[0]!.checkpoints[0]!.time = '25:06';
    expect(parse(invalid, number).events?.[0]).not.toHaveProperty('time');
    expect(parse(invalid, number).events?.[0]).not.toHaveProperty('local_time');
    expect(() => parse({ results: [{ id: number, checkpoints: [] }] }, number)).toThrow(IndeterminateError);
  });
});

describe('DHL Express retrieval', () => {
  it('recognizes over HTTP without invoking the browser', async () => {
    const fetcher = mobileFetcher();
    const carrier = adapter(environment(fetcher));
    expect(await carrier.recognize!(number, { budgetMs: 1000 })).toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-10-05T15:06:00' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://dhle.dhl.com/access/access/com.dhl.exp.dhlmobile?appVersion=6.1.0&service=shipments-tracking');
    const init = fetcher.mock.calls[0]![1]!;
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer \S+$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ service: 'shipments', method: 'tracking',
      authentication: { provider: 'DEMP.RS1', login: '', token: '' },
      data: { airWayBill: number, countryCode: 'GB', languageCd: 'en', addShipmentToODD: 'N', moreDetails: 'Y', captchaVerificationData: {} } });
  });
  it('recovers a blocked HTTP request by capturing the exact waybill response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'DRG10012' }), { status: 503 }));
    const trawl = new TrawlClient('https://browser.example');
    const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {},
      capturedResponses: [{ url: `https://www.dhl.com/utapi?trackingNumber=${number}`, status: 200, headers: {},
        body: JSON.stringify(unifiedPayload()), truncated: false, base64Encoded: false, error: null }] });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    expect(await new DhlExpressTracker({ ...environment(fetcher, trawl), recorder }).fetch(number)).toMatchObject({ status: 'delivered' });
    expect(recorder.step).toHaveBeenLastCalledWith(expect.objectContaining({ step: 'trawl', fallbackFrom: 'direct', fallbackReason: 'challenge',
      fallbackErrorType: 'ChallengeError', fallbackError: expect.objectContaining({ status: 503 }) }));
    expect(scrape).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ skipHttp: true, captureResponses: ['https://www.dhl.com/utapi'] }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await adapter(environment(fetcher, trawl)).recognizeWithBrowser!(number, { budgetMs: 20_000 })).toMatchObject({ known: true, result: { events: expect.any(Array) } });
    const request = scrape.mock.calls.at(-1)![0];
    expect(request.maxTimeout).toBeGreaterThan(17_000);
    expect(request.maxTimeout).toBeLessThanOrEqual(18_000);
  });
  it('does not accept a foreign capture or retry a schema failure in a browser', async () => {
    const trawl = new TrawlClient('https://browser.example');
    const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {}, capturedResponses: [] });
    const fetcher = mobileFetcher([{ id: '1234567880', checkpoints: [] }]);
    await expect(new DhlExpressTracker(environment(fetcher, trawl)).fetch(number)).rejects.toThrow(SchemaError);
    expect(scrape).not.toHaveBeenCalled();
    scrape.mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {},
      capturedResponses: [{ url: 'https://www.dhl.com/utapi?trackingNumber=1234567880', status: 200,
        headers: {}, body: JSON.stringify(payload()), truncated: false, base64Encoded: false, error: null }] });
    await expect(new DhlExpressTracker(environment(fetcher, trawl)).browser(number)).rejects.toThrow('no complete matching');
    await expect(new DhlExpressTracker(environment(fetcher)).fetch(number)).rejects.toThrow(SchemaError);
    fetcher.mockResolvedValue(new Response('<html>blocked</html>'));
    await expect(new DhlExpressTracker(environment(fetcher)).fetch(number)).rejects.toThrow(ChallengeError);
  });
  it('starts nothing after cancellation or a spent budget', async () => {
    const fetcher = vi.fn<typeof fetch>(); const carrier = adapter(environment(fetcher));
    await expect(carrier.track({ number }, { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(carrier.track({ number }, { budgetMs: 0 })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('DHL mobile API', () => {
  it('derives status from sorted scans, uses English local dates and discards recipient and piece data', () => {
    const data = mobilePayload(); data[0]!.checkpoints.reverse();
    const result = parseMobile(data, number);
    expect(result).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-10-05T15:06:00',
      events: [{ stage: 'delivered', local_time: '2026-10-05T15:06:00' }, { stage: 'out_for_delivery' }, { stage: 'accepted' }] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|signature|signatory|pIds|counter|pieces/);
  });
  it('rejects foreign identities, duplicate shipments, invalid counters and empty histories', () => {
    expect(() => parseMobile(mobilePayload(), '1234567880')).toThrow(SchemaError);
    const data = mobilePayload(); data.push(data[0]!);
    expect(() => parseMobile(data, number)).toThrow(IndeterminateError);
    for (const counter of [0, 1.5, NaN, 2]) {
      const invalid = mobilePayload(); invalid[0]!.checkpoints[0]!.counter = counter;
      expect(() => parseMobile(invalid, number)).toThrow(SchemaError);
    }
    expect(() => parseMobile([{ id: number, checkpoints: [] }], number)).toThrow(IndeterminateError);
    expect(() => parseMobile([null], number)).toThrow(SchemaError);
  });
  const blank = (row: Record<string, unknown> = {}) => [{ id: number, label: 'Waybill', type: 'airwaybill', checkpoints: [{ counter: 1,
    description: '', time: '', date: '', location: '', totalPieces: 1, pIds: [], date_en: '', ...row }] }];
  it('keeps a waybill DHL shows nothing for inconclusive, and a malformed checkpoint a schema error', async () => {
    expect(() => parseMobile(blank(), number)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseMobile(blank(), '1234567880')).toThrow(SchemaError);
    for (const row of [{ date: 'Monday, October 05, 2026', date_en: 'Monday, October 05, 2026', time: '12:00' }, { location: 'EXAMPLE CITY - FRANCE' },
      { description: undefined }, { location: null }]) {
      expect(() => parseMobile(blank(row), number)).toThrow(SchemaError);
    }
    const mixed = mobilePayload(); mixed[0]!.checkpoints.push({ ...blank()[0]!.checkpoints[0]!, counter: 4 });
    expect(() => parseMobile(mixed, number)).toThrow(SchemaError);
    // The global page is asked next; its own answer settles the lookup.
    const trawl = new TrawlClient('https://browser.example');
    const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {},
      capturedResponses: [captured({ status: 404, title: 'No result found', detail: 'No shipment with given tracking number found.' }, 404)] });
    await expect(new DhlExpressTracker(environment(mobileFetcher(blank()), trawl)).fetch(number)).rejects.toThrow(NotFoundError);
    expect(scrape).toHaveBeenCalledOnce();
    await expect(new DhlExpressTracker(environment(mobileFetcher(blank()))).fetch(number)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    await expect(adapter(environment(mobileFetcher(blank()))).recognize!(number)).rejects.toMatchObject({ reason: 'portal_not_found' });
  });
  it('accepts an empty list only after the configuration answered and never invokes the browser for not-found', async () => {
    const fetcher = mobileFetcher([]); const carrier = adapter(environment(fetcher));
    expect(await carrier.recognize!(number)).toEqual({ known: false });
    expect(services(fetcher)).toEqual(['shipments-tracking', 'common-countrySettingsBySettingName']);
    await expect(carrier.track({ number })).rejects.toThrow(NotFoundError);
  });
  it('rejects missing, duplicate or malformed settings rather than trust an empty list', async () => {
    for (const configuration of [[], [null], [...settings, ...settings], [{ name: 'api_awb_encryption', value: {} }]]) {
      const fetcher = mobileFetcher([], configuration);
      await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toThrow(SchemaError);
      expect(services(fetcher)).toEqual(['shipments-tracking', 'common-countrySettingsBySettingName']);
    }
  });
  it('keeps an empty list under changed encryption recoverable', async () => {
    const fetcher = mobileFetcher([], [{ name: 'api_awb_encryption', value: 'Y' }]);
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toThrow(ChallengeError);
    expect(services(fetcher)).toEqual(['shipments-tracking', 'common-countrySettingsBySettingName']);
  });
  it('reads no setting for a shipment it finds', async () => {
    const fetcher = mobileFetcher(); const tracker = new DhlExpressTracker(environment(fetcher));
    await expect(tracker.direct(number)).resolves.toMatchObject({ status: 'delivered' });
    await expect(tracker.direct(number)).resolves.toMatchObject({ status: 'delivered' });
    expect(services(fetcher)).toEqual(['shipments-tracking', 'shipments-tracking']);
  });
  it.each([
    ['DRG10012', ChallengeError], [{ error: { error: 'DRG10013' } }, ChallengeError],
    [{ statusCode: 401 }, ChallengeError], ['temporary_blocked', RateLimitedError],
    [{ error: 'max_attempts_reached' }, RateLimitedError], [{ statusCode: 429 }, RateLimitedError],
    [{ statusCode: 404, error: 'Not Found' }, SchemaError],
  ])('preserves a mobile rejection without treating it as a missing shipment', async (reply, kind) => {
    await expect(new DhlExpressTracker(environment(mobileFetcher(reply))).direct(number)).rejects.toThrow(kind);
  });
  it('preserves HTTP throttles and distinguishes a missing API route from a missing shipment', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    fetcher.mockResolvedValue(new Response('{}', { status: 404 }));
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toThrow(TransportError);
  });
  it('recognizes the mobile CAPTCHA code inside HTTP 503 and preserves its status for browser recovery', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'DRG10012' }), { status: 503 }));
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toMatchObject({ kind: 'challenge', status: 503 });
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(new DhlExpressTracker(environment(unavailable)).direct(number)).rejects.toMatchObject({ kind: 'maintenance', status: 503 });
  });
  it('reads the encryption setting once and reuses it until it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fetcher = mobileFetcher([]); const carrier = adapter(environment(fetcher));
      expect(await carrier.recognize!(number)).toEqual({ known: false });
      await expect(carrier.track({ number })).rejects.toThrow(NotFoundError);
      vi.setSystemTime(Date.now() + SETTINGS_TTL_MS - 1);
      expect(await carrier.recognize!(number)).toEqual({ known: false });
      expect(services(fetcher)).toEqual(['shipments-tracking', 'common-countrySettingsBySettingName', 'shipments-tracking', 'shipments-tracking']);
      vi.setSystemTime(Date.now() + 1);
      fetcher.mockClear();
      expect(await carrier.recognize!(number)).toEqual({ known: false });
      expect(services(fetcher)).toEqual(['shipments-tracking', 'common-countrySettingsBySettingName']);
    } finally {
      vi.useRealTimers();
    }
  });
  it('trusts an empty list under the reused setting and reads it again after a rejected or unexpected reply', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fetcher = mobileFetcher([]); const carrier = adapter(environment(fetcher));
      expect(await carrier.recognize!(number)).toEqual({ known: false });
      expect(await carrier.recognize!(number)).toEqual({ known: false });
      expect(fetcher).toHaveBeenCalledTimes(3);
      for (const [reply, kind] of [[{ statusCode: 401 }, ChallengeError], ['temporary_blocked', RateLimitedError],
        [{ statusCode: 404, error: 'Not Found' }, SchemaError]] as const) {
        // An hour on, so the hour's requests allow the setting's read and the rejection.
        vi.setSystemTime(Date.now() + 60 * 60_000);
        expect(await carrier.recognize!(number)).toEqual({ known: false });
        fetcher.mockClear().mockImplementation(async (_url, init) => new Response(JSON.stringify(JSON.parse(String(init?.body)).method === 'tracking' ? reply : settings)));
        await expect(carrier.recognize!(number)).rejects.toThrow(kind);
        fetcher.mockImplementation(async (_url, init) => new Response(JSON.stringify(JSON.parse(String(init?.body)).method === 'tracking' ? [] : settings)));
        expect(await carrier.recognize!(number)).toEqual({ known: false });
        expect(services(fetcher)).toEqual(['shipments-tracking', 'shipments-tracking', 'common-countrySettingsBySettingName']);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it('asks nothing for any waybill while a CAPTCHA may hold, and goes straight to the browser meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).method === 'tracking'
        ? new Response(JSON.stringify({ error: 'DRG10012' }), { status: 503 }) : new Response(JSON.stringify(settings)));
      const trawl = new TrawlClient('https://browser.example');
      const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {},
        capturedResponses: [captured()] });
      const recorder = { ...NOOP_RECORDER, step: vi.fn() };
      const tracker = new DhlExpressTracker({ ...environment(fetcher, trawl), recorder });
      await expect(tracker.direct(number)).rejects.toMatchObject({ kind: 'challenge', status: 503 });
      expect(services(fetcher)).toEqual(['shipments-tracking']);
      fetcher.mockClear();
      await expect(tracker.direct('1234567880')).rejects.toThrow('recently required verification');
      await expect(tracker.fetch(number)).resolves.toMatchObject({ status: 'delivered' });
      expect(recorder.step.mock.calls.map(([record]) => [record.step, record.outcome, record.fallbackFrom])).toEqual([['trawl', 'ok', null]]);
      expect(scrape).toHaveBeenCalledOnce();
      // Without a browser service the held CAPTCHA stays the lookup's answer.
      await expect(new DhlExpressTracker(environment(fetcher)).fetch(number)).rejects.toThrow('recently required verification');
      vi.setSystemTime(Date.now() + CAPTCHA_MEMORY_MS - 1);
      await expect(tracker.direct(number)).rejects.toThrow(ChallengeError);
      expect(fetcher).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + 1);
      fetcher.mockImplementation(async (_url, init) => new Response(JSON.stringify(JSON.parse(String(init?.body)).method === 'tracking' ? mobilePayload() : settings)));
      recorder.step.mockClear();
      await expect(tracker.fetch(number)).resolves.toMatchObject({ status: 'delivered' });
      expect(recorder.step.mock.calls.map(([record]) => [record.step, record.outcome])).toEqual([['direct', 'ok']]);
      expect(services(fetcher)).toEqual(['shipments-tracking']);
      expect(scrape).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('shares a CAPTCHA and a confirmed setting with every instance on its transport, and no other', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).method === 'tracking'
      ? new Response(JSON.stringify({ error: 'DRG10012' }), { status: 503 }) : new Response(JSON.stringify(settings)));
    // A host's tracking and recognition registries each build their own adapter over one fetcher.
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toMatchObject({ kind: 'challenge', status: 503 });
    await expect(adapter(environment(fetcher)).recognize!(number)).rejects.toThrow('recently required verification');
    expect(services(fetcher)).toEqual(['shipments-tracking']);
    const other = mobileFetcher([]);
    await expect(new DhlExpressTracker(environment(other)).direct(number)).rejects.toThrow(NotFoundError);
    await expect(adapter(environment(other)).recognize!(number)).resolves.toEqual({ known: false });
    expect(services(other)).toEqual(['shipments-tracking', 'common-countrySettingsBySettingName', 'shipments-tracking']);
  });
  it('remembers a CAPTCHA the settings read draws', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).method === 'tracking'
      ? new Response('[]') : new Response(JSON.stringify({ error: 'DRG10013' }), { status: 503 }));
    const tracker = new DhlExpressTracker(environment(fetcher));
    await expect(tracker.direct(number)).rejects.toMatchObject({ kind: 'challenge', status: 503 });
    await expect(tracker.direct(number)).rejects.toThrow('recently required verification');
    expect(services(fetcher)).toEqual(['shipments-tracking', 'common-countrySettingsBySettingName']);
  });
  it('pauses longer each time the first request after a pause draws the CAPTCHA, until one is answered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const captcha = async () => new Response(JSON.stringify({ error: 'DRG10012' }), { status: 503 });
      const fetcher = vi.fn<typeof fetch>().mockImplementation(captcha);
      const tracker = new DhlExpressTracker(environment(fetcher));
      const pauses = [CAPTCHA_MEMORY_MS, 2 * CAPTCHA_MEMORY_MS, 4 * CAPTCHA_MEMORY_MS, MAX_CAPTCHA_MEMORY_MS, MAX_CAPTCHA_MEMORY_MS];
      await expect(tracker.direct(number)).rejects.toMatchObject({ kind: 'challenge', status: 503 });
      for (const [index, pause] of pauses.entries()) {
        vi.setSystemTime(Date.now() + pause - 1);
        await expect(tracker.direct(number)).rejects.toThrow('recently required verification');
        vi.setSystemTime(Date.now() + 1);
        if (index < pauses.length - 1) await expect(tracker.direct(number)).rejects.toMatchObject({ status: 503 });
      }
      expect(fetcher).toHaveBeenCalledTimes(pauses.length);
      fetcher.mockImplementation(async () => new Response(JSON.stringify(mobilePayload())));
      await expect(tracker.direct(number)).resolves.toMatchObject({ status: 'delivered' });
      fetcher.mockImplementation(captcha);
      await expect(tracker.direct(number)).rejects.toMatchObject({ status: 503 });
      vi.setSystemTime(Date.now() + CAPTCHA_MEMORY_MS);
      fetcher.mockImplementation(async () => new Response(JSON.stringify(mobilePayload())));
      await expect(tracker.direct(number)).resolves.toMatchObject({ status: 'delivered' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('sends a transport no more requests in an hour than DHL lets pass, and goes to the browser meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fetcher = mobileFetcher([]);
      const trawl = new TrawlClient('https://browser.example');
      const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {},
        capturedResponses: [captured()] });
      const recorder = { ...NOOP_RECORDER, step: vi.fn() };
      const tracker = new DhlExpressTracker({ ...environment(fetcher, trawl), recorder });
      const carrier = adapter(environment(fetcher, trawl));
      // The settings read counts as one of the hour's requests.
      await expect(tracker.direct(number)).rejects.toThrow(NotFoundError);
      const first = Date.now();
      vi.setSystemTime(first + 10 * 60_000);
      for (let sent = 2; sent < HOURLY_REQUESTS; sent++) await expect(tracker.direct(number)).rejects.toThrow(NotFoundError);
      expect(fetcher).toHaveBeenCalledTimes(HOURLY_REQUESTS);
      const paced = await carrier.recognize!(number).catch((error: unknown) => error);
      expect(paced).toBeInstanceOf(MobilePacedError);
      expect(paced).toMatchObject({ kind: 'rate_limited', retryAfterMs: 50 * 60_000 });
      await expect(carrier.recognizeWithBrowser!(number, {}, paced)).resolves.toMatchObject({ known: true });
      await expect(carrier.recognizeWithBrowser!(number, {}, new RateLimitedError('DHL Express'))).rejects.toThrow(RateLimitedError);
      await expect(tracker.fetch(number)).resolves.toMatchObject({ status: 'delivered' });
      expect(recorder.step.mock.calls.map(([record]) => record.step)).toEqual(['trawl']);
      expect(scrape).toHaveBeenCalledTimes(2);
      await expect(new DhlExpressTracker(environment(fetcher)).fetch(number)).rejects.toThrow(MobilePacedError);
      expect(fetcher).toHaveBeenCalledTimes(HOURLY_REQUESTS);
      // An hour after the first two requests, two more may be sent: tracking and the expired setting's read.
      vi.setSystemTime(first + 60 * 60_000);
      await expect(tracker.direct(number)).rejects.toThrow(NotFoundError);
      expect(fetcher).toHaveBeenCalledTimes(HOURLY_REQUESTS + 2);
      await expect(tracker.direct(number)).rejects.toThrow(MobilePacedError);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not remember another verification requirement', async () => {
    const fetcher = mobileFetcher({ statusCode: 401 }); const tracker = new DhlExpressTracker(environment(fetcher));
    await expect(tracker.direct(number)).rejects.toThrow(ChallengeError);
    await expect(tracker.direct(number)).rejects.toThrow(ChallengeError);
    expect(services(fetcher)).toEqual(['shipments-tracking', 'shipments-tracking']);
  });
  it('does not keep a refused setting or a failed settings read', async () => {
    const fetcher = mobileFetcher([], [{ name: 'api_awb_encryption', value: 'Y' }]); const tracker = new DhlExpressTracker(environment(fetcher));
    await expect(tracker.direct(number)).rejects.toThrow(ChallengeError);
    fetcher.mockResolvedValueOnce(new Response('[]')).mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(tracker.direct(number)).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(tracker.direct(number)).rejects.toThrow(ChallengeError);
    expect(services(fetcher)).toEqual(Array(3).fill(['shipments-tracking', 'common-countrySettingsBySettingName']).flat());
  });
  it('keeps the setting when a tracking request gets no reply, the lookup is cancelled or its time runs out', async () => {
    const fetcher = mobileFetcher([]); const tracker = new DhlExpressTracker(environment(fetcher));
    await expect(tracker.direct(number)).rejects.toThrow(NotFoundError);
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(tracker.direct(number)).rejects.toThrow(UpstreamNetworkError);
    const controller = new AbortController();
    fetcher.mockImplementationOnce(async () => { controller.abort(); throw controller.signal.reason; });
    await expect(tracker.direct(number, { signal: controller.signal })).rejects.toThrow();
    fetcher.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))));
    await expect(tracker.direct(number, { budgetMs: 20 })).rejects.toThrow();
    await expect(tracker.direct(number)).rejects.toThrow(NotFoundError);
    expect(services(fetcher)).toEqual(['shipments-tracking', 'common-countrySettingsBySettingName', ...Array(4).fill('shipments-tracking')]);
  });
  it('does not read the setting when the caller cancels during tracking', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); return new Response('[]'); });
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});


describe('DHL public browser API', () => {
  it('preserves offsets, binds Express and excludes recipient and piece details', () => {
    const result = parseUnified(unifiedPayload(), number);
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-10-05T15:06:00-04:00', destination_country: 'CA',
      events: [{ time: '2026-10-05T15:06:00-04:00', provider_code: 'OK', stage: 'delivered', location: 'EXAMPLE CITY' },
        { stage: 'out_for_delivery' }, { stage: 'accepted', time: '2026-10-02T17:18:00-07:00' }] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|proofOfDelivery|consignee|pieceIds|streetAddress/);
  });
  it('rejects other identities, divisions, duplicate waybills and empty or malformed events', () => {
    expect(() => parseUnified(unifiedPayload(), '1234567880')).toThrow(SchemaError);
    for (const service of ['parcel-de', '']) {
      const data = unifiedPayload(); data.shipments[0]!.service = service;
      expect(() => parseUnified(data, number)).toThrow(IndeterminateError);
    }
    const data = unifiedPayload(); data.shipments.push(data.shipments[0]!);
    expect(() => parseUnified(data, number)).toThrow(IndeterminateError);
    const empty = unifiedPayload(); empty.shipments[0]!.events = [];
    expect(() => parseUnified(empty, number)).toThrow(IndeterminateError);
    expect(() => parseUnified({ shipments: [null] }, number)).toThrow(SchemaError);
  });
  it('does not invent UTC offsets or retain a delivery signatory', () => {
    const data = unifiedPayload(); data.shipments[0]!.events[0]!.description = 'Delivered to PRIVATE';
    for (const value of ['2026-10-05T15:06:00', '2026-10-05T15:06:00+99:00', '2026-02-30T15:06:00Z']) {
      data.shipments[0]!.events[0]!.timestamp = value;
      expect(parseUnified(data, number).events?.[0]).toMatchObject({ description: 'Delivered' });
      expect(parseUnified(data, number).events?.[0]?.time).toBeUndefined();
    }
  });
  it('gives a record the feeds date on different clocks one wall clock, place and wording, which its identity policy matches', () => {
    const description = 'Customs clearance status updated. Note - The Customs clearance process is under way.';
    const location = 'EXAMPLE CITY - ITALY';
    const mobile = mobilePayload();
    mobile[0]!.checkpoints = [{ description, date: 'localized date', date_en: 'Monday, October 05, 2026', time: '11:00', location, counter: 1, pIds: [] }];
    const unified = unifiedPayload();
    unified.shipments[0]!.events = [{ description, statusCode: 'transit', status: 'RR', timestamp: '2026-10-05T11:00:00+01:00',
      location: { address: { addressLocality: location, streetAddress: 'PRIVATE' } } }];
    const [fromMobile] = parseMobile(mobile, number).events!;
    const [fromPortal] = parseUnified(unified, number).events!;
    expect(fromMobile).toMatchObject({ time: '2026-10-05T11:00:00+02:00', location, description });
    expect(fromPortal).toMatchObject({ time: '2026-10-05T11:00:00+01:00', location, description, provider_code: 'RR' });
    const evidence = (event: typeof fromMobile) => ({ stage: event!.stage ?? '', description: event!.description ?? '',
      location: event!.location ?? '', providerCode: event!.provider_code ?? '' });
    const policy = sameInstantIdentityPolicy('dhl-express', { supportsScanMatching: true });
    expect(policy?.matchWallClock).toBe(true);
    expect(policy?.matches?.(evidence(fromMobile), evidence(fromPortal))).toBe(true);
    expect(policy?.matches?.(evidence(fromPortal), evidence(fromMobile))).toBe(true);
  });
  function browser(responses: ReturnType<typeof captured>[]) {
    const trawl = new TrawlClient('https://browser.example');
    vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {}, capturedResponses: responses });
    return environment(vi.fn<typeof fetch>(), trawl);
  }
  it('uses the final tracking reply after an intermediate challenge and recognizes its dated history', async () => {
    const env = browser([captured({}, 428), captured()]);
    expect(await adapter(env).recognizeWithBrowser!(number)).toMatchObject({ known: true, lastActivityAt: '2026-10-05T19:06:00.000Z', result: { events: expect.any(Array) } });
  });
  it('does not hide a later rejection behind an earlier success', async () => {
    await expect(new DhlExpressTracker(browser([captured(), captured({}, 428)])).browser(number)).rejects.toThrow(ChallengeError);
    await expect(new DhlExpressTracker(browser([{ ...captured(), body: '<html>blocked</html>' }])).browser(number)).rejects.toThrow(ChallengeError);
  });
  it('recognizes only the observed not-found envelope on the matching query', async () => {
    const missing = { status: 404, title: 'No result found', detail: 'No shipment with given tracking number found.' };
    expect(await adapter(browser([captured(missing, 404)])).recognizeWithBrowser!(number)).toEqual({ known: false, lastActivityAt: null });
    await expect(new DhlExpressTracker(browser([captured({}, 404)])).browser(number)).rejects.not.toThrow(NotFoundError);
    await expect(new DhlExpressTracker(browser([captured(missing, 404, `https://www.dhl.com/utapi?trackingNumber=${number}&trackingNumber=1234567880`)])).browser(number)).rejects.toThrow('no complete matching');
  });
});

describe('DHL Express piece identifiers', () => {
  const piece = 'JD014600000000000001';
  const piecePayload = () => {
    const data = unifiedPayload();
    data.shipments[0]!.details.pieceIds = [piece, 'JD014600000000000002'];
    return data;
  };
  const pieceCapture = (body: unknown = piecePayload(), status = 200) => captured(body, status, `https://www.dhl.com/utapi?trackingNumber=${piece}&language=en`);
  const browserEnvironment = (responses: ReturnType<typeof captured>[]) => {
    const trawl = new TrawlClient('https://browser.example');
    const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {}, capturedResponses: responses });
    const fetcher = vi.fn<typeof fetch>();
    return { env: environment(fetcher, trawl), scrape, fetcher };
  };

  it('reads the piece as DHL lists it, with or without the label\'s data identifier on either side', () => {
    expect(normalizePieceId(piece)).toBe(piece);
    expect(normalizePieceId('jjd0146 0000 0000 0000 01')).toBe(piece);
    expect(normalizePieceId('jd0146 0000 0000 0000 01 j')).toBe(piece);
    for (const other of ['JD024600000000000001', 'JD149000000000000001', 'JD01460000000000001', `J${piece}J`, `${piece}JJ`, number]) {
      expect(() => normalizePieceId(other)).toThrow(InvalidInputError);
    }
  });
  it('tracks the shipment that lists the piece and reports its waybill as the canonical number', () => {
    const result = parseUnifiedPiece(piecePayload(), piece);
    expect(result).toMatchObject({ status: 'delivered', canonical_tracking_number: number, destination_country: 'CA',
      events: [{ time: '2026-10-05T15:06:00-04:00', stage: 'delivered' }, { stage: 'out_for_delivery' }, { stage: 'accepted' }] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|pieceIds|JD0146/);
  });
  it('rejects a reply without the piece, another division, a missing waybill and a reused piece', () => {
    expect(() => parseUnifiedPiece(unifiedPayload(), piece)).toThrow('does not list the piece');
    const parcel = piecePayload(); parcel.shipments[0]!.id = piece; parcel.shipments[0]!.service = 'parcel-de';
    expect(() => parseUnifiedPiece(parcel, piece)).toThrow(IndeterminateError);
    const noWaybill = piecePayload(); noWaybill.shipments[0]!.id = '1234567890';
    expect(() => parseUnifiedPiece(noWaybill, piece)).toThrow(SchemaError);
    const reused = piecePayload(); reused.shipments.push({ ...reused.shipments[0]!, id: '1234567902' });
    expect(() => parseUnifiedPiece(reused, piece)).toThrow(new IndeterminateError('DHL Express', 'DHL returned several shipments that list the piece'));
  });
  it('tracks the Express shipment when DHL Paket adds its own record of the piece', () => {
    const mixed = piecePayload();
    mixed.shipments.push({ ...mixed.shipments[0]!, id: piece, service: 'parcel-de' });
    expect(parseUnifiedPiece(mixed, piece)).toMatchObject({ status: 'delivered', canonical_tracking_number: number });
    mixed.shipments.reverse();
    expect(parseUnifiedPiece(mixed, piece)).toMatchObject({ canonical_tracking_number: number });
  });
  it('resolves a piece on the global page only, never through the mobile API', async () => {
    const { env, scrape, fetcher } = browserEnvironment([pieceCapture({}, 428), pieceCapture()]);
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    expect(await new DhlExpressTracker({ ...env, recorder }).fetch('JJD014600000000000001')).toMatchObject({ canonical_tracking_number: number, status: 'delivered' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(scrape).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      url: `https://www.dhl.com/global-en/home/tracking/tracking-parcel.html?submit=1&tracking-id=${piece}`, captureResponses: ['https://www.dhl.com/utapi'] }), expect.anything());
    expect(recorder.step).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ step: 'trawl', outcome: 'ok', fallbackFrom: null }));
    const missing = { status: 404, title: 'No result found', detail: 'No shipment with given tracking number found.' };
    await expect(new DhlExpressTracker(browserEnvironment([pieceCapture(missing, 404)]).env).fetch(piece)).rejects.toThrow(NotFoundError);
    await expect(new DhlExpressTracker(browserEnvironment([captured()]).env).fetch(piece)).rejects.toThrow('no complete matching');
  });
  it('needs the browser service for a piece and keeps HTTP recognition inconclusive', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(adapter(environment(fetcher)).track({ number: piece })).rejects.toThrow(ChallengeError);
    await expect(adapter(environment(fetcher)).recognize!(piece, { budgetMs: 1000 })).rejects.toThrow(IndeterminateError);
    expect(fetcher).not.toHaveBeenCalled();
    const { env } = browserEnvironment([pieceCapture()]);
    expect(await adapter(env).recognizeWithBrowser!(piece, { budgetMs: 20_000 }, new IndeterminateError('DHL Express', 'HTTP')))
      .toMatchObject({ known: true, result: { canonical_tracking_number: number } });
  });
});

describe('DHL tracking API', () => {
  const missing = { status: 404, title: 'No result found', detail: 'No shipment with given tracking number found.' };
  // The mobile API's CAPTCHA code, which leaves the lookup to the next step.
  const captchaFetcher = () => vi.fn<typeof fetch>().mockImplementation(async (_url, init) => JSON.parse(String(init?.body)).method === 'tracking'
    ? new Response(JSON.stringify({ error: 'DRG10012' }), { status: 503 }) : new Response(JSON.stringify(settings)));
  const apiFetcher = (reply: () => Response = () => new Response(JSON.stringify(unifiedPayload())), mobile: typeof fetch = captchaFetcher()) =>
    vi.fn<typeof fetch>().mockImplementation(async (url, init) => String(url).startsWith(API) ? reply() : mobile(url, init));
  const keyed = (fetcher: typeof fetch, trawl: TrawlClient | null = null, key = 'synthetic-key') => ({ ...environment(fetcher, trawl), env: { DHL_API_KEY: key } });
  const apiCalls = (fetcher: ReturnType<typeof apiFetcher>) => fetcher.mock.calls.filter(([url]) => String(url).startsWith(API));
  const mobileCalls = (fetcher: ReturnType<typeof apiFetcher>) => fetcher.mock.calls.length - apiCalls(fetcher).length;
  const recorded = () => ({ ...NOOP_RECORDER, step: vi.fn() });
  const steps = (recorder: ReturnType<typeof recorded>) => recorder.step.mock.calls.map(([record]) => [record.step, record.outcome]);
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const browser = () => {
    const trawl = new TrawlClient('https://browser.example');
    const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {},
      capturedResponses: [captured()] });
    return { trawl, scrape };
  };

  it('asks the API only when the mobile API cannot answer, and only under a key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect(adapter(keyed(apiFetcher())).steps).toEqual(['direct', 'api', 'trawl']);
      expect(adapter(environment(apiFetcher())).steps).toEqual(['direct', 'trawl']);
      // An answer from the mobile API spends none of the key's calls.
      const answered = apiFetcher(undefined, mobileFetcher());
      expect(await new DhlExpressTracker(keyed(answered)).fetch(number)).toMatchObject({ status: 'delivered', last_update_local: '2026-10-05T15:06:00' });
      expect(apiCalls(answered)).toHaveLength(0);
      const fetcher = apiFetcher();
      const recorder = recorded();
      const tracker = new DhlExpressTracker({ ...keyed(fetcher), recorder });
      expect(await tracker.fetch(number)).toMatchObject({ status: 'delivered',
        events: [{ time: '2026-10-05T15:06:00-04:00', stage: 'delivered' }, { stage: 'out_for_delivery' }, { stage: 'accepted' }] });
      expect(apiCalls(fetcher)).toHaveLength(1);
      const [url, init] = apiCalls(fetcher)[0]!;
      expect(String(url)).toBe(`${API}?trackingNumber=${number}&language=en`);
      expect(new Headers(init!.headers).get('dhl-api-key')).toBe('synthetic-key');
      // While the CAPTCHA holds, the key is asked without the mobile API.
      const mobile = mobileCalls(fetcher);
      later(SPACING_MS);
      await tracker.fetch(number);
      expect(mobileCalls(fetcher)).toBe(mobile);
      expect(steps(recorder)).toEqual([['direct', 'challenge'], ['api', 'ok'], ['api', 'ok']]);
      // Recognition stays on the mobile API.
      await expect(adapter(keyed(fetcher)).recognize!(number, { budgetMs: 1000 })).rejects.toThrow();
      expect(apiCalls(fetcher)).toHaveLength(2);
      const unkeyed = apiFetcher();
      await expect(new DhlExpressTracker(environment(unkeyed)).fetch(number)).rejects.toMatchObject({ kind: 'challenge' });
      expect(apiCalls(unkeyed)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('ends the lookup at DHL\'s not-found, and leaves any other failure to the browser', async () => {
    const unused = browser();
    const notFound = apiFetcher(() => new Response(JSON.stringify(missing), { status: 404 }));
    await expect(new DhlExpressTracker(keyed(notFound, unused.trawl)).fetch(number)).rejects.toThrow(NotFoundError);
    expect(apiCalls(notFound)).toHaveLength(1);
    // The mobile API's own not-found ends the lookup before the key.
    const absent = apiFetcher(undefined, mobileFetcher([]));
    await expect(new DhlExpressTracker(keyed(absent, unused.trawl)).fetch(number)).rejects.toThrow(NotFoundError);
    expect(apiCalls(absent)).toHaveLength(0);
    expect(unused.scrape).not.toHaveBeenCalled();
    for (const reply of [() => new Response('{}', { status: 404 }), () => new Response('<html></html>', { status: 404 }), () => new Response('<html></html>'),
      () => new Response('{}', { status: 500 }), () => new Response('{}', { status: 410 }), () => { throw new TypeError('fetch failed'); },
      () => new Response(JSON.stringify({ shipments: [{ ...unifiedPayload().shipments[0], id: '1234567880' }] }))]) {
      const fetcher = apiFetcher(reply);
      const recorder = recorded();
      const { trawl, scrape } = browser();
      expect(await new DhlExpressTracker({ ...keyed(fetcher, trawl), recorder }).fetch(number)).toMatchObject({ status: 'delivered', last_update: '2026-10-05T15:06:00-04:00' });
      expect(scrape).toHaveBeenCalledOnce();
      expect(steps(recorder)).toEqual([['direct', 'challenge'], ['api', expect.not.stringMatching(/^(ok|not_found)$/)], ['trawl', 'ok']]);
      // No failure carries the request that holds the key.
      const failure: unknown = recorder.step.mock.calls[1]![0].error;
      expect(failure).toBeInstanceOf(Error);
      expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain('synthetic-key');
      expect((failure as { request?: unknown }).request).toBeUndefined();
    }
  });
  it('pauses the key for DHL\'s retry window after a rate limit, and for an hour after a refusal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const [reply, pauseMs] of [[() => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }), 120_000],
        [() => new Response('{}', { status: 429 }), PAUSE_MS], [() => new Response('{}', { status: 401 }), PAUSE_MS],
        [() => new Response('{}', { status: 403 }), PAUSE_MS]] as const) {
        const fetcher = apiFetcher(reply);
        const { trawl, scrape } = browser();
        const tracker = new DhlExpressTracker(keyed(fetcher, trawl));
        await expect(tracker.fetch(number)).resolves.toMatchObject({ status: 'delivered' });
        later(pauseMs - 1);
        await expect(tracker.fetch(number)).resolves.toMatchObject({ status: 'delivered' });
        // Another instance on the transport shares the pause; another key does not.
        await new DhlExpressTracker(keyed(fetcher, trawl)).fetch(number);
        expect(apiCalls(fetcher)).toHaveLength(1);
        await new DhlExpressTracker(keyed(fetcher, trawl, 'other-key')).fetch(number);
        expect(apiCalls(fetcher)).toHaveLength(2);
        later(1);
        await tracker.fetch(number);
        expect(apiCalls(fetcher)).toHaveLength(3);
        // The browser answers every lookup the key could not.
        expect(scrape).toHaveBeenCalledTimes(5);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it('waits five seconds between calls, and leaves a lookup whose turn comes too late to the browser', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fetcher = apiFetcher();
      const recorder = recorded();
      const tracker = new DhlExpressTracker({ ...keyed(fetcher, browser().trawl), recorder });
      await tracker.fetch(number);
      await expect(tracker.unified(number, { budgetMs: 5_000 })).rejects.toMatchObject({ kind: 'rate_limited', reason: 'self_paced' });
      await expect(tracker.fetch(number, { budgetMs: 5_000 })).resolves.toMatchObject({ status: 'delivered' });
      expect(apiCalls(fetcher)).toHaveLength(1);
      later(SPACING_MS - 50);
      const started = performance.now();
      await expect(tracker.fetch(number)).resolves.toMatchObject({ last_update: '2026-10-05T15:06:00-04:00' });
      expect(performance.now() - started).toBeGreaterThanOrEqual(40);
      expect(apiCalls(fetcher)).toHaveLength(2);
      expect(steps(recorder)).toEqual([['direct', 'challenge'], ['api', 'ok'], ['api', 'rate_limited'], ['trawl', 'ok'], ['api', 'ok']]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('resolves a piece without the browser, which still answers when the API cannot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const piece = 'JD014600000000000001';
      const data = unifiedPayload(); data.shipments[0]!.details.pieceIds = [piece];
      const fetcher = apiFetcher(() => new Response(JSON.stringify(data)));
      expect(await new DhlExpressTracker(keyed(fetcher)).fetch(`J${piece}`)).toMatchObject({ canonical_tracking_number: number, status: 'delivered' });
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${API}?trackingNumber=${piece}&language=en`]);
      const refused = apiFetcher(() => new Response('{}', { status: 401 }));
      await expect(new DhlExpressTracker(keyed(refused)).fetch(piece)).rejects.toThrow('refused the key');
      await expect(new DhlExpressTracker(keyed(refused)).fetch(piece)).rejects.toThrow(ApiPacedError);
      const trawl = new TrawlClient('https://browser.example');
      const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {},
        capturedResponses: [captured(data, 200, `https://www.dhl.com/utapi?trackingNumber=${piece}`)] });
      expect(await new DhlExpressTracker(keyed(refused, trawl)).fetch(piece)).toMatchObject({ canonical_tracking_number: number });
      expect(scrape).toHaveBeenCalledOnce();
      expect(apiCalls(refused)).toHaveLength(1);
      expect(refused.mock.calls.every(([url]) => String(url).startsWith(API))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
