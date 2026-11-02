import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';
import { fetchWanbInBrowser } from './browser.js';
import { API, COURIER_API, normalizeWanbNumber, parseWanb } from './parser.js';
import { statusMap, wanbStage } from './status.js';

vi.mock('./browser.js', () => ({ fetchWanbInBrowser: vi.fn() }));

const number = 'WNBZZ9990000001YQ';
const unknown = 'WNBZZ9999999999YQ';
const found = () => ({ Succeeded: true, Data: { TrackingNumber: number, Match: 'ParcelId', Status: 'Delivered',
  Metadata: { OriginCountryCode: 'CN', DestinationCountryCode: 'US', ShippingAddress: 'PRIVATE' },
  TrackPoints: [
    { Time: '2031-04-16T10:00:00Z', TimeZone: 8, Content: 'Parcel Data Received', Status: 'DataReceived', Location: '' },
    { Time: '2031-04-18T19:30:00Z', TimeZone: -4, Content: 'Parcel has been delivered.', Status: 'LastMileDelivered', Location: 'Example City' },
  ] } });
const challenge = { Succeeded: false, Error: { Code: '0x110012', Message: 'Verification failed' } };
const missing = { Succeeded: true, Data: { TrackingNumber: unknown, Match: 'Unknown', Status: null, Metadata: null, TrackPoints: [] } };
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const capture = (value: unknown, status = 200, id = number) => ({ url: `${API}?TrackingNumber=${id}`, status,
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), truncated: false, base64Encoded: false, error: null });

describe('WanbExpress', () => {
  it('tracks in the optional private browser without the plain request it refuses, and recognizes over HTTP first', async () => {
    vi.mocked(fetchWanbInBrowser).mockClear().mockResolvedValue(found());
    const recorded: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => reply(challenge));
    const carrier = adapter({ env: { WANBEXPRESS_BROWSER_WS_ENDPOINT: 'ws://browser.test/synthetic' },
      fetcher, trawl: null, browserExecutablePath: null,
      recorder: { ...NOOP_RECORDER, step: event => { recorded.push(event); } } });
    await expect(carrier.recognize!(number)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetchWanbInBrowser).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(carrier.track({ number }, { budgetMs: 8000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(recorded).toMatchObject([{ step: 'browser', outcome: 'ok' }]);
    expect(fetchWanbInBrowser).toHaveBeenCalledWith(number, 'ws://browser.test/synthetic', expect.any(AbortSignal), expect.any(Number));
    expect(vi.mocked(fetchWanbInBrowser).mock.calls[0]![3]).toBeLessThanOrEqual(6000);
    await expect(carrier.recognizeWithBrowser!(number, {})).resolves.toMatchObject({ known: true });
  });

  it('can recover through TRAWL after the private browser is refused', async () => {
    vi.mocked(fetchWanbInBrowser).mockRejectedValueOnce(new ChallengeError('WanbExpress'));
    const carrier = adapter({ env: { WANBEXPRESS_BROWSER_WS_ENDPOINT: 'ws://browser.test/synthetic' }, fetcher: async () => reply(challenge),
      trawl: new TrawlClient('http://browser.test', async () => reply({ tier: 3, statusCode: 200, html: '', capturedResponses: [capture(found())] })),
      browserExecutablePath: null, recorder: NOOP_RECORDER });
    await expect(carrier.track({ number }, { budgetMs: 8000 })).resolves.toMatchObject({ current_stage: 'delivered' });
  });

  it('names a language, since the tracker fails on fetch\'s default wildcard', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply(challenge));
    const carrier = adapter({ env: {}, fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });
    await expect(carrier.recognize!(number)).rejects.toMatchObject({ kind: 'challenge' });
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('accept-language')).toBe('en');
  });

  it('retains a verification failure when neither browser service is configured', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply(challenge));
    const carrier = adapter({ env: {}, fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });
    await expect(carrier.recognizeWithBrowser!(number, {})).rejects.toMatchObject({ kind: 'challenge' });
    // Without a browser, a lookup still makes the plain request.
    await expect(carrier.track({ number }, { budgetMs: 8000 })).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('binds the complete parcel id and trusts UTC instead of applying the display offset again', () => {
    const result = parseWanb(found(), number);
    expect(result).toMatchObject({ current_stage: 'delivered', status: 'delivered', origin_country: 'CN', destination_country: 'US',
      last_update: '2031-04-18T19:30:00Z', events: [{ time: '2031-04-18T19:30:00Z', stage: 'delivered' }, { stage: 'registered' }] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(normalizeWanbNumber(number.toLowerCase())).toBe(number);
    for (const input of ['1234567890', 'WNBZZ999000000YQ', number + '0', 'WNB/ZZ9990000001YQ']) {
      expect(() => normalizeWanbNumber(input)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const other = found(); other.Data.TrackingNumber = unknown;
    expect(() => parseWanb(other, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const reference = found(); reference.Data.Match = 'TrackingNumber';
    expect(() => parseWanb(reference, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('stages the last-mile partner\'s scans by iMile\'s sentences, a run that did not deliver as a failed attempt', () => {
    const point = (Time: string, Content: string, Status: string | null = null) => ({ Time, TimeZone: 2, Content, Status, Location: '' });
    const result = parseWanb({ Succeeded: true, Data: { TrackingNumber: number, Match: 'ParcelId', Status: null, Metadata: null, TrackPoints: [
      point('2031-04-20T09:00:00Z', '【Sample DC】Received.'),
      point('2031-04-20T17:00:00Z', '【Sample DS】Arrived.'),
      point('2031-04-21T03:30:00Z', '【Sample DS】Dispatch task assigned to DA.'),
      point('2031-04-21T12:59:00Z', '【Sample DS】Shipment out for delivery.', 'LastMileDeliveryReady'),
      point('2031-04-21T18:48:00Z', '<Route not completed>'),
      point('2031-04-21T19:36:00Z', '【Sample DS】 Back To DS.'),
      point('2031-04-21T19:46:00Z', 'Scheduled to <2031-04-23> .'),
    ] } }, number);
    // The day booked for the next run moves nothing: the failed attempt stands.
    expect(result.current_stage).toBe('failed_attempt');
    expect(result.events?.map((event) => [event.stage, event.stage_source])).toEqual([
      [undefined, undefined], ['failed_attempt', 'carrier'], ['failed_attempt', 'carrier'], ['out_for_delivery', 'carrier'],
      ['in_transit', 'carrier'], ['in_transit', 'carrier'], ['in_transit', 'carrier'],
    ]);
    // The app reviews stored wordings by the same map.
    expect(statusMap.stage(null, '【sample ds】 back to ds.')).toBe('failed_attempt');
    expect(statusMap.stage('LastMileDeliveryReady', '【sample ds】shipment out for delivery.')).toBe('out_for_delivery');
    expect(wanbStage(null, 'scheduled to <2031-04-23> .')).toBeNull();
    // And closes it as a gap that keeps the stage before it, whatever day it names.
    expect(statusMapAnswer({ carrier: 'wanbexpress', providerCode: null, description: 'Scheduled to <2031-04-23> .' }))
      .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage it had/) });
    expect(statusMapAnswer({ carrier: 'wanbexpress', providerCode: null, description: 'Sample wording' }).kind).toBe('unknown');
    // A US partner's codeless scans between its receipt and the run.
    expect(wanbStage(null, 'In Processing at Transit Facility.')).toBe('in_transit');
    expect(statusMap.stage(null, 'in transit to next facility.')).toBe('in_transit');
    expect(wanbStage('LastMileNew', 'In Transit to Next Facility.')).toBeUndefined();
  });

  it('keeps the courier\'s number and names the courier the last-mile panel gives for the shipping service', async () => {
    const courierNumber = '0082800082801234567890';
    const relabelled = () => { const value = found(); Object.assign(value.Data.Metadata, { TrackingNumber: courierNumber, ShippingServiceId: 'SAMPLE_ES_48H' }); return value; };
    const courier = (Name: string, OfficialWebSite = '') => ({ Succeeded: true, Data: { Id: 'SAMPLE', Name, Tel: '0000', OfficialWebSite }, Error: null });
    const track = async (panel: () => Promise<Response>, payload: unknown = relabelled()) => {
      const fetcher = vi.fn<typeof fetch>(panel);
      const trawl = new TrawlClient('http://browser.test', async () => reply({ tier: 3, statusCode: 200, html: '', capturedResponses: [capture(payload)] }));
      const result = await adapter({ env: {}, fetcher, trawl, browserExecutablePath: null, recorder: NOOP_RECORDER }).track({ number }, { budgetMs: 8000 });
      return { result, fetcher };
    };
    const named = await track(async () => reply(courier('CTT Express', 'https://www.cttexpress.com/')));
    expect(named.result).toMatchObject({ delivery_carrier: 'ctt-express', delivery_tracking_number: courierNumber });
    expect(String(named.fetcher.mock.calls[0]![0])).toBe(`${COURIER_API}?shippingServiceId=SAMPLE_ES_48H&trackingNumber=${courierNumber}`);
    // A courier the catalog does not know, or whose rules refuse the number, stays unnamed.
    for (const name of ['Sample Courier', 'Royal Mail']) {
      const { result } = await track(async () => reply(courier(name)));
      expect(result.delivery_tracking_number).toBe(courierNumber);
      expect(result).not.toHaveProperty('delivery_carrier');
    }
    // The panel only adds the courier: its failure or an empty answer leaves the tracking.
    for (const panel of [async () => new Response('', { status: 500 }), async () => reply({ Succeeded: true, Data: null }), async () => { throw new TypeError('offline'); }]) {
      const { result } = await track(panel);
      expect(result).toMatchObject({ current_stage: 'delivered', delivery_tracking_number: courierNumber });
      expect(result).not.toHaveProperty('delivery_carrier');
    }
    // Without a service, or with the parcel's own number shown, there is no panel to ask.
    const own = found(); Object.assign(own.Data.Metadata, { TrackingNumber: number, ShippingServiceId: 'SAMPLE_ES_48H' });
    expect(parseWanb(own, number)).not.toHaveProperty('delivery_tracking_number');
    const unnamed = relabelled(); delete (unnamed.Data.Metadata as Record<string, unknown>).ShippingServiceId;
    const { result, fetcher } = await track(async () => reply(courier('CTT Express')), unnamed);
    expect(result.delivery_tracking_number).toBe(courierNumber);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('numbers scans at one instant in the order the tracker lists them, oldest first', () => {
    const value = found();
    value.Data.TrackPoints.splice(1, 0, { Time: '2031-04-17T08:00:00Z', TimeZone: 8, Content: 'Departed origin facility', Status: 'Departed', Location: '' },
      { Time: '2031-04-17T08:00:00Z', TimeZone: 8, Content: 'Flight departed', Status: 'FlightDeparted', Location: '' });
    expect(parseWanb(value, number).events?.map(event => event.description)).toEqual(['Parcel has been delivered.', 'Flight departed', 'Departed origin facility', 'Parcel Data Received']);
  });

  it('keeps verification, missing parcels and changed schemas distinct', () => {
    expect(() => parseWanb(challenge, number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseWanb(missing, unknown)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const falseMissing = { ...missing, Data: { ...missing.Data, Metadata: {} } };
    expect(() => parseWanb(falseMissing, unknown)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const value of [null, [], {}, { Succeeded: true, Data: {} }]) expect(() => parseWanb(value, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const invalid = found(); invalid.Data.TrackPoints[0]!.Time = '2031-04-16T10:00:00';
    expect(() => parseWanb(invalid, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('recovers in TRAWL while retaining the initial challenge and using the final bound response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply(challenge));
    const browserFetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ skipHttp: true, maxTier: 3, captureResponses: [API] });
      expect(request.maxTimeout).toBeLessThan(8000);
      expect(init?.signal).toBeDefined();
      return reply({ tier: 3, statusCode: 200, html: '', capturedResponses: [capture(challenge), capture(found())] });
    });
    const recorded: unknown[] = [];
    const carrier = adapter({ env: {}, fetcher, trawl: new TrawlClient('http://browser.test', browserFetcher), browserExecutablePath: null,
      recorder: { ...NOOP_RECORDER, step: event => { recorded.push(event); } } });
    await expect(carrier.track({ number }, { budgetMs: 8000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(recorded).toMatchObject([{ step: 'trawl', outcome: 'ok' }]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(browserFetcher).toHaveBeenCalledTimes(1);
  });

  it('never launches a browser during HTTP recognition and refuses unmatched, truncated and finally challenged captures', async () => {
    const trawl = new TrawlClient('http://browser.test', vi.fn<typeof fetch>());
    const environment = { env: {}, fetcher: vi.fn<typeof fetch>(async () => reply(challenge)), trawl, browserExecutablePath: null, recorder: NOOP_RECORDER };
    await expect(adapter(environment).recognize!(number)).rejects.toMatchObject({ kind: 'challenge' });
    for (const [captures, kind] of [
      [[capture(found(), 200, unknown)], 'challenge'],
      [[capture(found()), capture(challenge)], 'challenge'],
      [[{ ...capture(found()), truncated: true }], 'transport'],
      [[capture(found(), 429)], 'rate_limited'],
      [[capture(found(), 403)], 'challenge'],
    ] as const) {
      const browser = new TrawlClient('http://browser.test', async () => reply({ tier: 3, statusCode: 200, html: '', capturedResponses: captures }));
      await expect(adapter({ ...environment, trawl: browser }).track({ number }, { budgetMs: 8000 })).rejects.toMatchObject({ kind });
    }
    await expect(adapter(environment).track({ number }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
  });
});
