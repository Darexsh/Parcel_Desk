import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { IndeterminateError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { DPD_DE_APP_RAIL, DpdDeAppClient } from './app.js';
import { DPD_DE_APP_API, sharedDpdAppService, warmDpdSession, type DpdSession } from './service.js';
import { DPD_DE_APP_SCANS } from './status.js';

// All identifiers, credentials, sessions, clocks and private-field markers here are invented.
const NUMBER = '01000000000001';
const PARTNER = { name: 'Synthetic Partner', token: 'SYNTHETIC_TOKEN', password: 'SYNTHETIC_PASSWORD' };
const NOW = Date.UTC(2026, 0, 3, 10, 0);
const fixture = (name: string) => readFileSync(new URL(`./fixtures/app-${name}.xml`, import.meta.url), 'utf8');
const xml = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });
const failure = (operation: string, ...codes: string[]) => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>`
  + `<${operation}Response xmlns="https://cloud.dpd.com/"><${operation}Result><Ack>false</Ack><ErrorDataList>`
  + codes.map(code => `<ErrorData><ErrorID>1</ErrorID><ErrorCode>${code}</ErrorCode><ErrorMsg>PRIVATE_MARKER</ErrorMsg></ErrorData>`).join('')
  + `</ErrorDataList></${operation}Result></${operation}Response></soap:Body></soap:Envelope>`;

interface Call { operation: string; body: string; headers: Headers; signal?: AbortSignal | null }

/** Answers each operation from its queue, then from its fixture. */
function service(replies: Record<string, Array<() => Response | Promise<Response>>> = {}) {
  const calls: Call[] = [];
  const fetcher = ((url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(DPD_DE_APP_API);
    const headers = new Headers(init?.headers);
    const operation = /^"https:\/\/cloud\.dpd\.com\/(\w+)"$/.exec(headers.get('SOAPAction') ?? '')?.[1] ?? '';
    calls.push({ operation, body: String(init?.body), headers, signal: init?.signal });
    const queued = replies[operation]?.shift();
    if (queued) return Promise.resolve(queued());
    const name = { getSessionFullState: 'session', getTrackingData: 'tracking', getTrackingScanList: 'scans', getParcelShopByID: 'shop' }[operation];
    return name ? Promise.resolve(xml(fixture(name))) : Promise.reject(new Error('Unexpected operation'));
  }) as typeof fetch;
  const client = new DpdDeAppClient({ partner: PARTNER, fetcher, userAgent: 'Host/1.0', now: () => NOW });
  const track = (signal = new AbortController().signal) => client.track(NUMBER, { signal, timeoutMs: 1_000 });
  return { calls, client, fetcher, replies, track };
}

describe('DPD Germany app service', () => {
  it('opens a session, binds the parcel and projects scans with their established clocks', async () => {
    const { calls, track } = service();
    const result = await track();
    expect(calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getTrackingData', 'getTrackingScanList']);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Unfortunately we have not been able to deliver your parcel.', last_update: '2026-01-03T09:40:00+01:00', weight_kg: 2.5 });
    expect(result.events).toEqual([
      { time: '2026-01-03T09:40:00+01:00', location: 'Musterstadt, DE', description: 'Unfortunately we have not been able to deliver your parcel.', stage: 'failed_attempt', stage_source: 'carrier_map' },
      { time: '2026-01-03T06:10:00+01:00', location: 'Musterstadt, DE', description: 'Out for delivery.', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { time: '2026-01-03T03:55:00+01:00', location: 'Musterstadt, DE', description: 'At parcel delivery centre.', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-01-02T17:39:00', provider_time_text: '02.01.2026 17:39', location: 'Musterville, FR', description: 'In transit.', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-01-01T13:29:00', provider_time_text: '01.01.2026 13:29', description: 'Order information has been transmitted to DPD.', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(result.expected_delivery).toBe('2026-01-03');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SYNTHETIC|estimated/);
  });

  const noAnnouncement = () => fixture('scans').replace(/<TrackingScan>\s*<ScanDate>03\.01\.2026<\/ScanDate>\s*<ScanTime>06:00<\/ScanTime>[\s\S]*?<\/TrackingScan>/, '');
  const withForecast = (fields: string) => fixture('tracking').replace('</TrackingData>', `${fields}</TrackingData>`);
  const window = (from: string, to: string, specified = 'true') => `<LiveTracking><EstimatedDeliveryDateTimeSpecified>${specified}</EstimatedDeliveryDateTimeSpecified>`
    + `<EstimatedDeliveryDateTimeFrom>${from}</EstimatedDeliveryDateTimeFrom><EstimatedDeliveryDateTimeTo>${to}</EstimatedDeliveryDateTimeTo></LiveTracking>`;
  const planned = (day: string, specified = 'true', changed = 'false') => `<NewDeliveryInfo><DateChanged>${changed}</DateChanged>`
    + `<PlannedDeliveryDateSpecified>${specified}</PlannedDeliveryDateSpecified><PlannedDeliveryDate>${day}</PlannedDeliveryDate></NewDeliveryInfo>`;

  it('projects the flagged window without changing scan history or retaining driver data', async () => {
    const from = '2026-01-04T10:15:00+01:00';
    const to = '2026-01-04T12:45:00+01:00';
    const fields = window(from, to).replace('</LiveTracking>', '<DriverName>PRIVATE DRIVER</DriverName><CarGeoData><Latitude>52</Latitude></CarGeoData></LiveTracking>');
    const baseline = await service().track();
    const result = await service({ getTrackingData: [() => xml(withForecast(fields))] }).track();
    expect(result).toEqual({ ...baseline, expected_delivery: '2026-01-04 10:15–12:45' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each([
    ['naive clocks', '2026-01-04T10:15:00', '2026-01-04T12:45:00', '2026-01-04 10:15–12:45'],
    ['a window crossing midnight', '2026-01-04T23:30:00+01:00', '2026-01-05T00:30:00+01:00', '2026-01-04 23:30–2026-01-05 00:30'],
    ['source UTC clocks', '2026-01-04T09:15:00Z', '2026-01-04T11:45:00Z', '2026-01-04 10:15–12:45'],
    ['offsets crossing a calendar boundary', '2026-01-05T00:30:00+05:00', '2026-01-05T01:30:00+05:00', '2026-01-04 20:30–21:30'],
    ['the summer delivery clock', '2026-07-04T08:15:00Z', '2026-07-04T10:45:00Z', '2026-07-04 10:15–12:45'],
  ])('renders %s on the German clock only when the source establishes an instant', async (_, from, to, expected) => {
    const result = await service({ getTrackingData: [() => xml(withForecast(window(from, to)))] }).track();
    expect(result.expected_delivery).toBe(expected);
  });

  it.each([
    ['an unspecified window', '2026-01-04T10:00:00+01:00', '2026-01-04T12:00:00+01:00', 'false'],
    ['placeholder clocks', '2000-01-01T00:00:00+01:00', '2000-01-01T00:00:00+01:00', 'true'],
    ['a default minimum day', '0001-01-01T00:00:00', '0001-01-01T00:00:00', 'true'],
    ['a missing end', '2026-01-04T10:00:00+01:00', '', 'true'],
    ['a reversed window', '2026-01-04T12:00:00+01:00', '2026-01-04T10:00:00+01:00', 'true'],
    ['mixed unresolved and offset clocks', '2026-01-04T10:00:00', '2026-01-04T12:00:00+01:00', 'true'],
    ['an impossible day', '2026-02-30T10:00:00+01:00', '2026-02-30T12:00:00+01:00', 'true'],
    ['an impossible hour', '2026-01-04T24:00:00+01:00', '2026-01-05T01:00:00+01:00', 'true'],
    ['an impossible offset', '2026-01-04T10:00:00+25:00', '2026-01-04T12:00:00+25:00', 'true'],
  ])('does not turn %s into an ETA and retains a valid date fallback', async (_, from, to, specified) => {
    const { track } = service({ getTrackingData: [() => xml(withForecast(window(from, to, specified)))] });
    expect((await track()).expected_delivery).toBe('2026-01-03');
    // The same reply without a dated announcement has no estimate.
    const empty = service({ getTrackingData: [() => xml(withForecast(window(from, to, specified)))], getTrackingScanList: [() => xml(noAnnouncement())] });
    expect((await empty.track()).expected_delivery).toBeNull();
  });

  it('prefers a changed planned date over an old window, else uses the precise window', async () => {
    const fields = window('2026-01-04T10:00:00+01:00', '2026-01-04T12:00:00+01:00') + planned('2026-01-05T00:00:00+01:00', '1', '1');
    const changed = await service({ getTrackingData: [() => xml(withForecast(fields))] }).track();
    expect(changed.expected_delivery).toBe('2026-01-05');
    const unchanged = await service({ getTrackingData: [() => xml(withForecast(fields.replace('<DateChanged>1</DateChanged>', '<DateChanged>false</DateChanged>')))] }).track();
    expect(unchanged.expected_delivery).toBe('2026-01-04 10:00–12:00');
  });

  it.each([
    [planned('2026-01-05T00:00:00+01:00'), '2026-01-05'],
    [planned('2026-01-05T00:00:00+01:00', 'false'), null],
    [planned('2000-01-01T00:00:00+01:00'), null],
    ['<DeliveryDateTime>05.01.2026</DeliveryDateTime>', '2026-01-05'],
    ['<DeliveryDateTime>2026-01-05</DeliveryDateTime>', '2026-01-05'],
    ['<DeliveryDateTime>05.01.</DeliveryDateTime>', null],
    ['<DeliveryDateTime>tomorrow</DeliveryDateTime>', null],
  ])('reads only a specified or complete delivery date (%s)', async (fields, expected) => {
    const result = await service({ getTrackingData: [() => xml(withForecast(fields))], getTrackingScanList: [() => xml(noAnnouncement())] }).track();
    expect(result.expected_delivery).toBe(expected);
  });

  it('uses the latest dated announcement without requiring or projecting its scan clock', async () => {
    const notice = '<TrackingScan><StatusText>Your parcel is estimated to be delivered on: Monday, 05.01.2026</StatusText></TrackingScan>';
    const result = await service({ getTrackingScanList: [() => xml(fixture('scans').replace('</TrackingScanList>', `${notice}</TrackingScanList>`))] }).track();
    expect(result).toMatchObject({ expected_delivery: '2026-01-05', last_update: '2026-01-03T09:40:00+01:00', current_stage: 'failed_attempt' });
    expect(result.events).toHaveLength(5);
    const invalid = notice.replace('Monday, 05.01.2026', 'Monday');
    const revised = await service({ getTrackingScanList: [() => xml(fixture('scans').replace('</TrackingScanList>', `${invalid}</TrackingScanList>`))] }).track();
    expect(revised.expected_delivery).toBeNull();
  });

  it.each([
    ['the delivered flag', (body: string) => body.replace('<Delivered>false</Delivered>', '<Delivered>true</Delivered>'), (body: string) => body],
    ['the delivered rail', (body: string) => body.replace('<StatusID>AT_DELIVERY_DEPOT</StatusID>', '<StatusID>DELIVERED</StatusID>'), (body: string) => body],
    ['a delivered scan', (body: string) => body, (body: string) => body.replaceAll('Unfortunately we have not been able to deliver your parcel.', 'Delivered.')],
    ['delivery to a pickup point', (body: string) => body, (body: string) => body.replaceAll('Unfortunately we have not been able to deliver your parcel.', 'Delivered by driver to DPD Pickup parcelshop/ station.')],
    ['an exception', (body: string) => body.replace('<StatusID>AT_DELIVERY_DEPOT</StatusID>', '<StatusID>FUTURE</StatusID>'), (body: string) => body.replaceAll('Unfortunately we have not been able to deliver your parcel.', "We're sorry but your parcel couldn't be delivered as arranged.")],
  ])('clears forecasts after %s even when an old window remains', async (_, tracking, scans) => {
    const fields = window('2026-01-04T10:00:00+01:00', '2026-01-04T12:00:00+01:00');
    const result = await service({ getTrackingData: [() => xml(tracking(withForecast(fields)))], getTrackingScanList: [() => xml(scans(fixture('scans')))] }).track();
    expect(result.expected_delivery).toBeNull();
  });

  it('signs each call for its operation and minute and sends the host identity', async () => {
    const { calls, track } = service();
    await track();
    for (const call of calls) {
      const key = `4800${createHash('md5').update(`4800${PARTNER.name}0${call.operation}${PARTNER.password}`).digest('base64').slice(0, 16)}`;
      expect(call.body).toContain(`<PartnerCredentials><Name>${PARTNER.name}</Name><Token>${PARTNER.token}</Token><KeyPhase>${key}</KeyPhase></PartnerCredentials>`);
      expect(call.headers.get('user-agent')).toBe('Host/1.0');
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls[1]!.body).toContain(`<ParcelNo>${NUMBER}</ParcelNo><DeliveryZipCode></DeliveryZipCode><UpdateNewDeliveryData>false</UpdateNewDeliveryData>`
      + '<addParcelIfNoTrackingdataAvailable>false</addParcelIfNoTrackingdataAvailable>');
    expect(calls[0]!.body).not.toMatch(/PushToken|Pixel/);
  });

  it('keeps one session across lookups and shares the one being opened', async () => {
    const { calls, track } = service();
    await Promise.all([track(), track()]);
    await track();
    expect(calls.filter(call => call.operation === 'getSessionFullState')).toHaveLength(1);
    expect(calls.filter(call => call.operation === 'getTrackingData')).toHaveLength(3);
  });

  it('replaces an expired session once', async () => {
    const expired = () => xml(failure('getTrackingData', 'ERROR_SESSION_NOT_VALID'));
    const { calls, track } = service({ getTrackingData: [expired] });
    expect((await track()).events).toHaveLength(5);
    expect(calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getTrackingData', 'getSessionFullState', 'getTrackingData', 'getTrackingScanList']);
    const stuck = service({ getTrackingData: [expired, expired] });
    await expect(stuck.track()).rejects.toMatchObject({ kind: 'transport' });
    expect(stuck.calls).toHaveLength(4);
  });

  it.each([
    ['a refused partner', () => xml(failure('getSessionFullState', 'ERROR_PARTNER', 'ERROR_KEYPHASE')), 'challenge'],
    ['a refused key', () => xml(failure('getSessionFullState', 'ERROR_KEYPHASE')), 'challenge'],
    ['an unusable session', () => xml(fixture('session').replace(/<SessionToken>[^<]*/, '<SessionToken>no')), 'schema'],
    ['a document type', () => xml(`<!DOCTYPE x>${fixture('session')}`), 'schema'],
    ['a page', () => xml('<html>PRIVATE_MARKER</html>'), 'schema'],
    ['a SOAP fault', () => xml('PRIVATE_MARKER', 500), 'indeterminate'],
    ['a missing endpoint', () => xml('', 404), 'transport'],
    ['a refusal', () => xml('', 403), 'challenge'],
    ['a rate limit', () => new Response('', { status: 429, headers: { 'retry-after': '120' } }), 'rate_limited'],
  ])('reports %s without tracking and without its contents', async (_, reply, kind) => {
    const { calls, track } = service({ getSessionFullState: [reply] });
    const error = await track().catch((caught: unknown) => caught) as Error & { kind: string; retryAfterMs?: number };
    expect(error).toMatchObject({ kind, ...(kind === 'rate_limited' ? { retryAfterMs: 120_000 } : {}) });
    expect(calls).toHaveLength(1);
    expect(`${JSON.stringify(error)}${error.message}`).not.toMatch(/PRIVATE_MARKER|SYNTHETIC/);
    expect(error).not.toHaveProperty('request');
  });

  it.each([
    ['another parcel', (body: string) => body.replace(`<TrackingData>\n          <ParcelNo>${NUMBER}`, '<TrackingData>\n          <ParcelNo>01000000000002'), { kind: 'schema' }],
    ['no tracking data', () => failure('getTrackingData', 'ERROR_TRACKING_PARCELNO_NO_TRACKINGDATA'), { kind: 'indeterminate' }],
  ])('does not project %s', async (_, change, expected) => {
    const { track } = service({ getTrackingData: [() => xml(change(fixture('tracking')))] });
    await expect(track()).rejects.toMatchObject(expected);
  });

  it('places the parcel by its newest placed scan, else by the depot of its last status', async () => {
    // The recipient address reads Germany for parcels delivered elsewhere in the group too.
    const abroad = fixture('scans').replaceAll('Musterstadt (DE)', 'Musterville (CH)');
    await expect(service({ getTrackingScanList: [() => xml(abroad)] }).track()).rejects.toMatchObject({ kind: 'indeterminate', reason: 'other_country' });
    const unplaced = () => xml(fixture('scans').replace(/<Location>[^<]*<\/Location>/g, '<Location>DPD data centre</Location>'));
    const depot = (country: string) => () => xml(fixture('tracking').replace('<City>Musterstadt</City>', `<City>Musterstadt</City><Country>${country}</Country>`));
    await expect(service({ getTrackingData: [depot('AT')], getTrackingScanList: [unplaced] }).track()).rejects.toMatchObject({ reason: 'other_country' });
    // An unknown depot carries a three-letter placeholder.
    await expect(service({ getTrackingData: [depot('DEU')], getTrackingScanList: [unplaced] }).track()).resolves.toMatchObject({ status: 'in_transit' });
  });

  it('sends a postcode on both calls and reports whether DPD verified it', async () => {
    const signal = new AbortController().signal;
    const zip = (call: Call) => /<DeliveryZipCode>(\d*)<\/DeliveryZipCode>/.exec(call.body)?.[1];
    const withPostcode = (client: DpdDeAppClient, postcode = '10115') => client.track(NUMBER, { signal, timeoutMs: 1_000, postcode });
    const verifiedReply = () => xml(fixture('tracking').replace('<DataViewStatus>Anonym</DataViewStatus>', '<DataViewStatus>DeliveryZipCode_isValid</DataViewStatus>'));
    const verified = service({ getTrackingData: [verifiedReply] });
    await expect(withPostcode(verified.client)).resolves.toMatchObject({ status: 'in_transit', dpd_postcode_verified: true });
    expect(verified.calls.slice(1).map(zip)).toEqual(['10115', '10115']);
    expect(verified.calls[1]!.body).toContain('<UpdateNewDeliveryData>false</UpdateNewDeliveryData>');

    // A rejected postcode gets one lookup without it.
    const rejected = service({ getTrackingData: [() => xml(failure('getTrackingData', 'ERROR_TRACKING_DELIVERYZIPCODE_NOT_VALID'))] });
    await expect(withPostcode(rejected.client)).resolves.toMatchObject({ status: 'in_transit', dpd_postcode_verified: false });
    expect(rejected.calls.slice(1).map(call => [call.operation, zip(call)])).toEqual([
      ['getTrackingData', '10115'], ['getTrackingData', ''], ['getTrackingScanList', ''],
    ]);
    // An accepted call that keeps the anonymous view has not verified it either.
    const anonymous = service();
    await expect(withPostcode(anonymous.client)).resolves.toMatchObject({ dpd_postcode_verified: false });
    expect(zip(anonymous.calls.at(-1)!)).toBe('');
    // An unknown parcel rejects any postcode, then has no tracking data.
    const unknown = service({ getTrackingData: [() => xml(failure('getTrackingData', 'ERROR_TRACKING_DELIVERYZIPCODE_NOT_VALID')),
      () => xml(failure('getTrackingData', 'ERROR_TRACKING_PARCELNO_NO_TRACKINGDATA'))] });
    await expect(withPostcode(unknown.client)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(await service().track()).not.toHaveProperty('dpd_postcode_verified');
    await expect(withPostcode(service().client, '1011')).rejects.toThrow(TypeError);
  });

  it.each([
    ['no scans', (body: string) => body.replace(/<TrackingScan>[\s\S]*<\/TrackingScan>/, ''), 'indeterminate'],
    ['only an announced day', (body: string) => body.replace(/<TrackingScan>[\s\S]*<\/TrackingScan>/,
      '<TrackingScan><ScanDate>03.01.2026</ScanDate><ScanTime>06:00</ScanTime><StatusText>Your parcel is estimated to be delivered on: Saturday</StatusText></TrackingScan>'), 'indeterminate'],
    ['a refused list', () => failure('getTrackingScanList', 'ERROR_UNKNOWN'), 'indeterminate'],
    ['an invalid clock', (body: string) => body.replace('<ScanTime>13:29</ScanTime>', '<ScanTime>25:99</ScanTime>'), 'schema'],
    ['an invalid day', (body: string) => body.replace('<ScanDate>01.01.2026</ScanDate>', '<ScanDate>2026-01-01</ScanDate>'), 'schema'],
    ['an unworded scan', (body: string) => body.replace('<StatusText>In transit.</StatusText>', '<StatusText></StatusText>'), 'schema'],
  ])('does not turn %s into tracking success', async (_, change, kind) => {
    const { track } = service({ getTrackingScanList: [() => xml(change(fixture('scans')))] });
    await expect(track()).rejects.toMatchObject({ kind });
  });

  it('leaves unknown wording unstaged, hides delivery prose and reads the status from the rail', async () => {
    const scans = fixture('scans').replace('Unfortunately we have not been able to deliver your parcel.', 'Delivered to PRIVATE NEIGHBOUR')
      .replace('Unfortunately we have not been able to deliver your parcel.', 'A future notice')
      .replace('<Location>Musterstadt (DE)</Location>\n            <ServiceCode>101</ServiceCode>\n            <TrackingScanAdditionalList><TrackingScanAdditionalType><AdditionalCode>999', '<Location>Elsewhere</Location>\n            <ServiceCode>101</ServiceCode>\n            <TrackingScanAdditionalList><TrackingScanAdditionalType><AdditionalCode>999');
    const { track } = service({ getTrackingScanList: [() => xml(scans)] });
    const result = await track();
    expect(result.events?.[0]).toEqual({ local_time: '2026-01-03T09:40:00', provider_time_text: '03.01.2026 09:40', description: 'A future notice' });
    expect(result.events?.[1]).toEqual({ time: '2026-01-03T09:40:00+01:00', location: 'Musterstadt, DE', description: 'Delivery update' });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: null, last_update_local: '2026-01-03T09:40:00' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('ends a lookup with its signal, and the opening with the last lookup that asked for it', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const { calls, track } = service({ getSessionFullState: [() => new Promise<Response>(() => undefined)] });
    const pending = [track(first.signal), track(second.signal)];
    first.abort(new Error('Cancelled'));
    await expect(pending[0]).rejects.toThrow('Cancelled');
    expect(calls[0]!.signal?.aborted).toBe(false);
    second.abort(new Error('Cancelled too'));
    await expect(pending[1]).rejects.toThrow('Cancelled too');
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('stops waiting for an opening session after its wait, without a request', async () => {
    let open!: () => void;
    const { calls, client } = service({ getSessionFullState: [() => new Promise<Response>((resolve) => { open = () => resolve(xml(fixture('session'))); })] });
    const signal = new AbortController().signal;
    await expect(client.track(NUMBER, { signal, timeoutMs: 1_000, sessionWaitMs: 0 })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_opening' });
    expect(calls).toHaveLength(1);
    open();
    expect((await client.track(NUMBER, { signal, timeoutMs: 1_000, sessionWaitMs: 0 })).events).toHaveLength(5);
    expect(calls.filter(call => call.operation === 'getSessionFullState')).toHaveLength(1);
  });
});

describe('DPD Germany app projection', () => {
  type Row = [day: string, time: string, wording: string, location: string, additional?: [code: string, text: string]];
  const scanList = (rows: Row[]) => fixture('scans').replace(/<TrackingScanList>[\s\S]*<\/TrackingScanList>/, `<TrackingScanList>${rows.map(([day, time, wording, location, additional]) =>
    `<TrackingScan><ScanDate>${day}</ScanDate><ScanTime>${time}</ScanTime><StatusText>${wording}</StatusText><Location>${location}</Location>`
    + `<ServiceCode>101</ServiceCode><TrackingScanAdditionalList>${additional ? `<TrackingScanAdditionalType><AdditionalCode>${additional[0]}</AdditionalCode>`
    + `<Description>${additional[1]}</Description></TrackingScanAdditionalType>` : ''}</TrackingScanAdditionalList></TrackingScan>`).join('')}</TrackingScanList>`);
  const tracking = (rail: string, order = '') => fixture('tracking').replace('<StatusID>AT_DELIVERY_DEPOT</StatusID>', `<StatusID>${rail}</StatusID>`)
    .replace('<Weight>2,50</Weight>', `<Weight>2,50</Weight>${order}`);
  const lookup = (rail: string, rows: Row[], order = '', shop?: () => Response) => {
    const app = service({ getTrackingData: [() => xml(tracking(rail, order))], getTrackingScanList: [() => xml(scanList(rows))],
      ...(shop ? { getParcelShopByID: [shop] } : {}) });
    return { calls: app.calls, result: app.track() };
  };
  const track = (rail: string, rows: Row[], order = '') => lookup(rail, rows, order).result;
  const stages = (result: Awaited<ReturnType<typeof track>>) => result.events?.map(event => [event.description, event.stage]);

  it('reads a return to the sender as an exception that ends in a returned stage', async () => {
    const returning: Row[] = [
      ['05.01.2026', '10:00', 'Unfortunately we have not been able to deliver your parcel.', 'Musterstadt (DE)', ['011', 'Consignee address not correct.']],
      ['05.01.2026', '16:00', 'Back at parcel delivery centre after an unsuccessful delivery attempt.', 'Musterstadt (DE)'],
      ['08.01.2026', '03:00', 'At parcel delivery centre. (Return to sender)', 'Absenderstadt (DE)'],
    ];
    // The rail turns to the return before the return's own scans, and stays there after its delivery.
    await expect(track('RETURN_TO_SENDER', [...returning, ['08.01.2026', '05:00', 'A future notice', 'Absenderstadt (DE)']]))
      .resolves.toMatchObject({ status: 'exception', current_stage: 'exception' });
    const result = await track('RETURN_TO_SENDER', [...returning, ['09.01.2026', '12:00', 'Delivered. (Return to sender)', 'Absenderstadt (DE)']]);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null });
    expect(result.delivered_at).toBeUndefined();
    expect(stages(result)).toEqual([
      ['Delivered. (Return to sender)', 'returned'],
      ['At parcel delivery centre. (Return to sender)', 'exception'],
      ['Back at parcel delivery centre after an unsuccessful delivery attempt.', 'failed_attempt'],
      ['Unfortunately we have not been able to deliver your parcel.', 'failed_attempt'],
    ]);
    expect(JSON.stringify(result)).not.toContain('Consignee');
  });

  it('reads a sender collection, a mailbox delivery, the delivery time and the measured size', async () => {
    const result = await track('DELIVERED', [
      ['05.01.2026', '00:05', 'Pickup ordered for: 05.01.2026', 'Absenderstadt (DE)'],
      ['05.01.2026', '14:50', 'Pickup not possible No goods acceptance / goods pickup.', 'Absenderstadt (DE)'],
      ['06.01.2026', '10:00', 'Parcel handed to DPD', 'Absenderstadt (DE)'],
      ['07.01.2026', '12:31', 'Parcel has been left in: mail box', 'Musterstadt (DE)'],
      ['07.01.2026', '12:31', 'Delivered.', 'Musterstadt (DE)'],
    ], '<Length>550</Length><Width>420</Width><Height>305</Height><LengthByCustomer>0</LengthByCustomer>');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-01-07T12:31:00+01:00',
      dimensions_text: '55 × 42 × 30.5 cm', weight_kg: 2.5 });
    expect(stages(result)).toEqual([
      ['Delivered.', 'delivered'],
      ['Parcel has been left in: mail box', 'delivered'],
      ['Parcel handed to DPD', 'accepted'],
      ['Pickup not possible No goods acceptance / goods pickup.', 'registered'],
      ['Pickup ordered for: 05.01.2026', 'registered'],
    ]);
    expect(result.events?.every(event => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('skips a size with an unmeasured side', async () => {
    const result = await track('AT_DELIVERY_DEPOT', [['05.01.2026', '10:00', 'At parcel delivery centre.', 'Musterstadt (DE)']],
      '<Length>0</Length><Width>0</Width><Height>0</Height><LengthByCustomer>350</LengthByCustomer><WidthByCustomer>250</WidthByCustomer><HeightByCustomer>100</HeightByCustomer>');
    expect(result.dimensions_text).toBeUndefined();
  });

  const atShop: Row[] = [
    ['05.01.2026', '13:33', 'Transfer to DPD Pickup station by DPD driver.', 'Musterstadt (DE)', ['999', 'DE00001|Kiosk Muster']],
    ['05.01.2026', '13:34', 'Delivered by driver to DPD Pickup parcelshop/ station.', 'Musterstadt (DE)', ['999', 'DE00001|Kiosk Muster']],
  ];

  it('names the shop holding the parcel and its address only while it waits there', async () => {
    // The rail keeps its handover state after the pickup too, so the scans decide.
    const waiting = lookup('HANDOVER_TO_PARCELSHOP', atShop);
    expect(await waiting.result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      pickup_point: 'Kiosk Muster\nMusterstr. 1\n00000 Musterstadt', expected_delivery: null });
    const shop = waiting.calls.find(call => call.operation === 'getParcelShopByID')!;
    expect(shop.body).toContain('<ParcelShopID>0</ParcelShopID><PudoID>DE00001</PudoID><ParcelShopOnly>false</ParcelShopOnly>');
    expect(JSON.stringify(await waiting.result)).not.toMatch(/SHOP|07:00|8\.1/);
    // The recipient's collection, from a station or a shop, is the delivery.
    for (const wording of ['Picked up from DPD Pickup station by consignee.', 'Picked up from Pickup parcelshop by consignee.']) {
      const collected = lookup('HANDOVER_TO_PARCELSHOP', [...atShop,
        ['06.01.2026', '09:57', wording, 'Musterstadt (DE)', ['999', 'DE00001|Kiosk Muster']]]);
      expect(await collected.result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-01-06T09:57:00+01:00' });
      expect((await collected.result).events?.[0]).toMatchObject({ description: wording, stage: 'delivered', stage_source: 'carrier_map' });
      expect((await collected.result).pickup_point).toBeUndefined();
      expect(collected.calls.map(call => call.operation)).not.toContain('getParcelShopByID');
    }
  });

  it('reads a shop\'s collection by the scans before it', async () => {
    const collection: Row[] = [
      ['06.01.2026', '07:18', 'The consignee did not collect the parcel.', 'Musterstadt (DE)'],
      ['06.01.2026', '10:39', 'Pick-up from the Pickup parcelshop by DPD driver', 'Musterstadt (DE)'],
    ];
    // The sender's parcel, taken on from the shop it was dropped at.
    const dropped = await track('ON_THE_ROAD', [['05.01.2026', '12:31', 'Parcel handed to Pickup parcelshop by consignor.', 'Musterstadt (DE)'], ...collection]);
    expect(stages(dropped)).toEqual([
      ['Pick-up from the Pickup parcelshop by DPD driver', 'in_transit'],
      ['The consignee did not collect the parcel.', undefined],
      ['Parcel handed to Pickup parcelshop by consignor.', 'accepted'],
    ]);
    // A parcel its recipient left at the shop starts its way back.
    expect(stages(await track('ON_THE_ROAD', [...atShop, ...collection]))?.slice(0, 2)).toEqual([
      ['Pick-up from the Pickup parcelshop by DPD driver', 'exception'],
      ['The consignee did not collect the parcel.', 'exception'],
    ]);
    for (const wording of ['the consignee did not collect the parcel.', 'pick-up from the pickup parcelshop by dpd driver']) {
      expect(statusMapAnswer({ carrier: 'dpd-de', description: wording })).toMatchObject({ kind: 'intentional_gap' });
    }
    // DPD Portugal's notices, relayed on a parcel it delivers, keep their code and wording.
    expect(statusMapAnswer({ carrier: 'dpd-de', providerCode: '714', description: 'DATA PREVISTA DE ENTREGA' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'dpd-de', providerCode: '714', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });

  it.each([
    ['its tracking data', 'getTrackingData', ['getSessionFullState', 'getTrackingData']],
    ['its scans', 'getTrackingScanList', ['getSessionFullState', 'getTrackingData', 'getTrackingScanList']],
  ])('reads nothing more once stopped while it waits for %s', async (_, operation, expected) => {
    let answer!: () => void;
    const held = (reply: () => Response) => () => new Promise<Response>((resolve) => { answer = () => resolve(reply()); });
    const data = () => xml(tracking('HANDOVER_TO_PARCELSHOP'));
    const scans = () => xml(scanList(atShop));
    const app = service({
      getTrackingData: [operation === 'getTrackingData' ? held(data) : data],
      getTrackingScanList: [operation === 'getTrackingScanList' ? held(scans) : scans],
    });
    const stop = new AbortController();
    const pending = app.client.track(NUMBER, { signal: new AbortController().signal, timeoutMs: 1_000, stop: stop.signal });
    await vi.waitFor(() => expect(app.calls.at(-1)?.operation).toBe(operation));
    stop.abort(new IndeterminateError('DPD Germany', 'Answered without the app service', { reason: 'session_opening' }));
    answer();
    await expect(pending).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_opening' });
    expect(app.calls.map(call => call.operation)).toEqual(expected);
  });

  it.each([
    ['another shop', () => xml(fixture('shop').replace('DE00001', 'DE00002'))],
    ['a shop without a street', () => xml(fixture('shop').replace('<Street>Musterstr.</Street>', '<Street />'))],
    ['a refusal', () => xml(failure('getParcelShopByID', 'ERROR_NO_PARCELSHOP'))],
    ['a malformed reply', () => xml('<html>PRIVATE</html>')],
    ['an outage', () => xml('', 503)],
  ])('keeps the shop name alone after %s', async (_, reply) => {
    const result = await lookup('HANDOVER_TO_PARCELSHOP', atShop, '', reply).result;
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'Kiosk Muster' });
  });

  it('ends a lookup cancelled during the address request', async () => {
    const controller = new AbortController();
    const app = service({ getTrackingData: [() => xml(tracking('HANDOVER_TO_PARCELSHOP'))], getTrackingScanList: [() => xml(scanList(atShop))],
      getParcelShopByID: [() => { controller.abort(new Error('Cancelled')); return xml('', 503); }] });
    await expect(app.track(controller.signal)).rejects.toThrow('Cancelled');
  });
});

describe('DPD Germany app vocabulary', () => {
  const recorded = (JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as {
    entries: Array<{ code?: string; wording: string; stage?: string; note?: string }>;
  }).entries.filter(entry => entry.note?.includes('German app'));

  it('maps every recorded scan wording and rail state to its recorded stage', () => {
    const scans = recorded.filter(entry => !entry.code);
    const rail = recorded.filter(entry => entry.code);
    expect(Object.fromEntries(scans.map(entry => [entry.wording, entry.stage]))).toEqual(DPD_DE_APP_SCANS);
    expect(Object.fromEntries(rail.map(entry => [entry.code, entry.stage]))).toEqual(
      Object.fromEntries(Object.entries(DPD_DE_APP_RAIL).map(([code, mapped]) => [code, mapped.stage])));
  });
});

describe('DPD Germany tiers', () => {
  const delivered = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as unknown;
  const guest = (reply: Response) => [
    Response.json({ fid: 'synthetic-fid', authToken: { token: 'synthetic-installation', expiresIn: '604800s' } }),
    Response.json({ entries: { basic_dpd_token: 'c3ludGhldGljOnRva2Vu' } }),
    Response.json({ access_token: 'synthetic-access', expires_in: 3600 }),
    reply,
  ];
  /** The guest protocol's typed refusal for a number it has no parcel for. */
  const unknownParcel = () => Response.json({ error: 'ParcelException', exceptionType: 'PARCEL_NOT_FOUND' }, { status: 400 });
  /** The app service, the guest protocol's replies in turn, and the pages of other hosts. */
  function tiers(replies: Response[], pages: Record<string, string> = {}, trawl: TrawlClient | null = null) {
    const app = service();
    const steps: Array<[string, string]> = [];
    const guestCalls: string[] = [];
    const fetcher = ((url: string | URL, init?: RequestInit) => {
      if (String(url) === DPD_DE_APP_API) return app.fetcher(url, init);
      const page = pages[new URL(String(url)).host];
      if (page !== undefined) return Promise.resolve(new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
      guestCalls.push(String(url));
      return Promise.resolve(replies.shift() ?? new Response('', { status: 500 }));
    }) as typeof fetch;
    const tracking = adapter({ fetcher, trawl, browserExecutablePath: null, env: {},
      recorder: { ...NOOP_RECORDER, step: event => { steps.push([event.step, event.outcome]); } } });
    /** Opens the session the adapter reads with, as an earlier lookup would have. */
    const opened = () => sharedDpdAppService({ fetcher }).session(new AbortController().signal, 1_000);
    return { app, fetcher, guestCalls, opened, steps, tracking };
  }

  it('declares the app service before the guest protocol', () => {
    expect(tiers([]).tracking.steps).toEqual(['app', 'direct', 'abroad']);
  });

  it('reads with the session the host warmed for its transport', async () => {
    vi.useFakeTimers();
    try {
      const replies = guest(Response.json({}));
      const { app, fetcher, steps, tracking } = tiers(replies);
      warmDpdSession({ fetcher });
      await vi.advanceTimersByTimeAsync(0);
      expect(app.calls.map(call => call.operation)).toEqual(['getSessionFullState']);
      expect((await tracking.track({ number: NUMBER })).events).toHaveLength(5);
      expect(app.calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getTrackingData', 'getTrackingScanList']);
      expect(steps).toEqual([['app', 'ok']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads with the session the host warmed for the fetcher it gives a tracker', async () => {
    const { app, fetcher, guestCalls } = tiers(guest(Response.json({})));
    warmDpdSession({ fetcher });
    await vi.waitFor(() => expect(sharedDpdAppService({ fetcher }).opening).toBe(false));
    const answer = await createTracker({ fetcher, providers: [] }).track({ number: NUMBER, carrier: 'dpd-de' });
    expect(answer.result.events).toHaveLength(5);
    expect(app.calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getTrackingData', 'getTrackingScanList']);
    expect(guestCalls).toHaveLength(0);
  });

  it('answers from the app service without a postcode, without asking the guest protocol', async () => {
    const replies = guest(Response.json({}));
    const { guestCalls, opened, steps, tracking } = tiers(replies);
    await opened();
    const result = await tracking.track({ number: NUMBER });
    expect(result).toMatchObject({ status: 'in_transit', tracking_url: `https://tracking.dpd.de/status/en_US/parcel/${NUMBER}` });
    expect(result.events).toHaveLength(5);
    expect(steps).toEqual([['app', 'ok']]);
    expect(guestCalls).toHaveLength(0);
  });

  it('asks the guest protocol while the session opens and ends on a parcel it does not know', async () => {
    const { app, guestCalls, steps, tracking } = tiers(guest(unknownParcel()));
    app.replies.getSessionFullState = [() => new Promise<Response>(() => undefined)];
    await expect(tracking.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'not_found']]);
    expect(guestCalls).toHaveLength(4);
    expect(app.calls.map(call => call.operation)).toEqual(['getSessionFullState']);
  });

  it('stops waiting for the session once the guest protocol ends the lookup, and still holds the opening', async () => {
    vi.useFakeTimers();
    try {
      const { app, tracking } = tiers(guest(unknownParcel()));
      app.replies.getSessionFullState = [() => new Promise<Response>(() => undefined)];
      await expect(tracking.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
      expect(vi.getTimerCount()).toBe(0);
      expect(app.calls[0]!.signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the session opening for the next lookup without reading the parcel the guest protocol ended', async () => {
    let open!: () => void;
    const { app, fetcher, tracking } = tiers(guest(unknownParcel()));
    app.replies.getSessionFullState = [() => new Promise<Response>((resolve) => { open = () => resolve(xml(fixture('session'))); })];
    await expect(tracking.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    open();
    await vi.waitFor(() => expect(sharedDpdAppService({ fetcher }).opening).toBe(false));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(app.calls.map(call => call.operation)).toEqual(['getSessionFullState']);
  });

  it('keeps waiting for the session while the guest protocol knows the parcel, then answers with its reply', async () => {
    const { app, guestCalls, steps, tracking } = tiers(guest(Response.json(delivered)));
    app.replies.getSessionFullState = [() => new Promise<Response>(() => undefined)];
    // The app service waits for its session all but 20 seconds of the budget.
    expect((await tracking.track({ number: NUMBER }, { budgetMs: 20_200 })).status).toBe('delivered');
    expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'ok']]);
    expect(guestCalls).toHaveLength(4);
  });

  it('reads the app service once its session opens, after asking the guest protocol beside it', async () => {
    let open!: () => void;
    const { app, guestCalls, steps, tracking } = tiers(guest(Response.json(delivered)));
    app.replies.getSessionFullState = [() => new Promise<Response>((resolve) => { open = () => resolve(xml(fixture('session'))); })];
    const pending = tracking.track({ number: NUMBER });
    await vi.waitFor(() => expect(guestCalls).toHaveLength(4));
    open();
    expect((await pending).events).toHaveLength(5);
    expect(steps).toEqual([['app', 'ok']]);
  });

  it('asks the guest protocol again in its own step when it failed beside the opening session', async () => {
    const { app, guestCalls, steps, tracking } = tiers([...guest(new Response('', { status: 500 })), Response.json(delivered)]);
    app.replies.getSessionFullState = [() => new Promise<Response>(() => undefined)];
    expect((await tracking.track({ number: NUMBER }, { budgetMs: 20_200 })).status).toBe('delivered');
    expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'ok']]);
    expect(guestCalls).toHaveLength(5);
  });

  it('stops waiting on a parcel the guest protocol places in another country while the session opens, and asks DPD\'s group', async () => {
    // A country without a unit of its own: the group service answers alone.
    const elsewhere = { parcelNumber: NUMBER, status: { description: 'DELIVERED', countryCode: 'CZ' },
      parcelHistory: [{ description: 'DELIVERED', eventDateAndTime: '2026-01-03T10:00:00+01:00' }] };
    const { app, guestCalls, steps, tracking } = tiers([...guest(Response.json(elsewhere)), ...guest(Response.json(elsewhere))]);
    app.replies.getSessionFullState = [() => new Promise<Response>(() => undefined)];
    expect(await tracking.track({ number: NUMBER })).toMatchObject({ status: 'delivered', history_truncated: true,
      tracking_url: `https://www.dpdgroup.com/be/mydpd/my-parcels/track?parcelNumber=${NUMBER}` });
    expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'indeterminate'], ['abroad', 'ok']]);
    expect(guestCalls.map(url => new URL(url).searchParams.get('businessUnit')).filter(Boolean)).toEqual(['DPD-DE', 'DPD-BE']);
  });

  it('asks the guest protocol beside the next session when the service refuses the open one', async () => {
    const { app, guestCalls, opened, steps, tracking } = tiers(guest(unknownParcel()));
    await opened();
    app.replies.getTrackingData = [() => xml(failure('getTrackingData', 'ERROR_SESSION_NOT_VALID'))];
    app.replies.getSessionFullState = [() => new Promise<Response>(() => undefined)];
    await expect(tracking.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'not_found']]);
    expect(guestCalls).toHaveLength(4);
    expect(app.calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getTrackingData', 'getSessionFullState']);
  });

  it('waits for the session replacing a refused one only as long as is left of its wait', async () => {
    vi.useFakeTimers();
    try {
      const { app, guestCalls, steps, tracking } = tiers(guest(Response.json(delivered)));
      app.replies.getSessionFullState = [
        () => new Promise<Response>((resolve) => { setTimeout(() => resolve(xml(fixture('session'))), 30_000); }),
        () => new Promise<Response>(() => undefined),
      ];
      app.replies.getTrackingData = [() => xml(failure('getTrackingData', 'ERROR_SESSION_NOT_VALID'))];
      const pending = tracking.track({ number: NUMBER }, { budgetMs: 60_000 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(app.calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getTrackingData', 'getSessionFullState']);
      // The wait ends 40 seconds after the lookup began, not 40 seconds after the second opening.
      await vi.advanceTimersByTimeAsync(10_000 - 1);
      expect(steps).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).status).toBe('delivered');
      expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'ok']]);
      expect(guestCalls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers with the guest reply when a kept session opens too late, and keeps it opening for the next lookup', async () => {
    vi.useFakeTimers();
    try {
      let open!: () => void;
      const { app, fetcher, guestCalls, steps, tracking } = tiers(guest(Response.json(delivered)));
      app.replies.getSessionFullState = [() => new Promise<Response>((resolve) => { open = () => resolve(xml(fixture('session'))); })];
      warmDpdSession({ fetcher });
      const pending = tracking.track({ number: NUMBER }, { budgetMs: 21_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(guestCalls).toHaveLength(4);
      // The guest reply waits for the session all but 20 seconds of the budget.
      await vi.advanceTimersByTimeAsync(999);
      expect(steps).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).status).toBe('delivered');
      expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'ok']]);
      await vi.advanceTimersByTimeAsync(60_000);
      open();
      await vi.advanceTimersByTimeAsync(0);
      // Nothing waits on a timer.
      expect(vi.getTimerCount()).toBe(0);
      expect((await tracking.track({ number: NUMBER })).events).toHaveLength(5);
      expect(steps.at(-1)).toEqual(['app', 'ok']);
      expect(guestCalls).toHaveLength(4);
      expect(app.calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getTrackingData', 'getTrackingScanList']);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('with a host\'s store', () => {
    const SAVED = 'U0FWRURfU0VTU0lPTl9UT0tFTg==';
    const HOUR = 3_600_000;
    /** A store that gives back its sessions when the test says so. */
    function store() {
      let give!: (sessions: DpdSession[]) => void;
      return { give: (sessions: DpdSession[]) => give(sessions),
        store: { load: () => new Promise<DpdSession[]>((resolve) => { give = resolve; }), save: async () => {} } };
    }

    it('waits for the store rather than asking the guest protocol, and reads with the session it gives back', async () => {
      vi.useFakeTimers();
      try {
        const { app, fetcher, guestCalls, steps, tracking } = tiers(guest(Response.json(delivered)));
        const saved = store();
        warmDpdSession({ fetcher }, { store: saved.store });
        const pending = tracking.track({ number: NUMBER });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(guestCalls).toHaveLength(0);
        saved.give([{ token: SAVED, openedAt: Date.now() - HOUR }]);
        expect((await pending).events).toHaveLength(5);
        expect(steps).toEqual([['app', 'ok']]);
        expect(guestCalls).toHaveLength(0);
        expect(app.calls.map(call => call.operation)).toEqual(['getTrackingData', 'getTrackingScanList']);
        expect(app.calls[0]!.body).toContain(`<SessionToken>${SAVED}</SessionToken>`);
      } finally {
        vi.useRealTimers();
      }
    });

    it('holds lookups for a store that does not answer, then asks the guest protocol beside the opening', async () => {
      vi.useFakeTimers();
      try {
        const { app, fetcher, guestCalls, steps, tracking } = tiers(guest(unknownParcel()));
        app.replies.getSessionFullState = [() => new Promise<Response>(() => undefined)];
        warmDpdSession({ fetcher }, { store: { load: () => new Promise<never>(() => {}), save: async () => {} } });
        const pending = tracking.track({ number: NUMBER });
        const ended = expect(pending).rejects.toMatchObject({ kind: 'not_found' });
        await vi.advanceTimersByTimeAsync(5_000 - 1);
        expect(guestCalls).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        await ended;
        expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'not_found']]);
        expect(app.calls.map(call => call.operation)).toEqual(['getSessionFullState']);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ['none', () => []],
      ['only one the service refused', () => [{ token: SAVED, openedAt: Date.now() - 9 * HOUR, checkedAt: Date.now() - 2 * HOUR, refusedAt: Date.now() - HOUR }]],
    ])('asks the guest protocol beside the opening once the store gives back %s', async (_, sessions) => {
      vi.useFakeTimers();
      try {
        const { app, fetcher, guestCalls, steps, tracking } = tiers(guest(unknownParcel()));
        app.replies.getSessionFullState = [() => new Promise<Response>(() => undefined)];
        const saved = store();
        warmDpdSession({ fetcher }, { store: saved.store });
        const pending = tracking.track({ number: NUMBER });
        const ended = expect(pending).rejects.toMatchObject({ kind: 'not_found' });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(guestCalls).toHaveLength(0);
        saved.give(sessions());
        await vi.advanceTimersByTimeAsync(0);
        await ended;
        expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'not_found']]);
        expect(guestCalls).toHaveLength(4);
        expect(app.calls.map(call => call.operation)).toEqual(['getSessionFullState']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it.each([
    ['is down', () => xml('', 503), 'maintenance'],
    ['refuses its credential', () => xml(failure('getSessionFullState', 'ERROR_PARTNER')), 'challenge'],
    ['limits the rate', () => new Response('', { status: 429 }), 'rate_limited'],
  ])('answers from the guest protocol when the app service %s', async (_, reply, outcome) => {
    const { app, steps, tracking } = tiers(guest(Response.json(delivered)));
    app.replies.getSessionFullState = [reply];
    expect((await tracking.track({ number: NUMBER })).status).toBe('delivered');
    expect(steps).toEqual([['app', outcome], ['direct', 'ok']]);
  });

  it('lets the guest protocol answer while the session opens, then reads the app service', async () => {
    let open!: () => void;
    const { app, steps, tracking } = tiers(guest(Response.json(delivered)));
    app.replies.getSessionFullState = [() => new Promise<Response>((resolve) => { open = () => resolve(xml(fixture('session'))); })];
    expect((await tracking.track({ number: NUMBER }, { budgetMs: 15_000 })).status).toBe('delivered');
    expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'ok']]);
    open();
    expect((await tracking.track({ number: NUMBER }, { budgetMs: 15_000 })).events).toHaveLength(5);
    expect(steps.at(-1)).toEqual(['app', 'ok']);
  });

  it('ends on a parcel the guest protocol names unknown once the app service has no tracking data', async () => {
    const { app, steps, tracking } = tiers(guest(unknownParcel()));
    app.replies.getTrackingData = [() => xml(failure('getTrackingData', 'ERROR_TRACKING_PARCELNO_NO_TRACKINGDATA'))];
    await expect(tracking.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'not_found']]);
  });

  it('asks DPD\'s group rather than the German guest protocol about a delivery the app service places in another country', async () => {
    const { app, guestCalls, opened, steps, tracking } = tiers(guest(Response.json(delivered)));
    await opened();
    app.replies.getTrackingScanList = [() => xml(fixture('scans').replaceAll('Musterstadt (DE)', 'Musterville (CZ)'))];
    expect(await tracking.track({ number: NUMBER })).toMatchObject({ status: 'delivered' });
    expect(steps).toEqual([['app', 'indeterminate'], ['abroad', 'ok']]);
    expect(guestCalls.map(url => new URL(url).searchParams.get('businessUnit')).filter(Boolean)).toEqual(['DPD-BE']);
  });

  it("dates the scans of a unit abroad on that unit's clock", async () => {
    const portugal = readFileSync(new URL('../dpd-pt/fixtures/delivered.html', import.meta.url), 'utf8').replaceAll('09990000000101', NUMBER);
    const { app, opened, steps, tracking } = tiers([new Response('', { status: 500 })], { 'tracking.dpd.pt': portugal });
    await opened();
    app.replies.getTrackingScanList = [() => xml(fixture('scans').replaceAll('Musterstadt (DE)', 'Musterville (PT)'))];
    const result = await tracking.track({ number: NUMBER });
    expect(steps).toEqual([['app', 'indeterminate'], ['abroad', 'ok']]);
    // DPD Portugal's delivery, on Lisbon's clock, an hour behind Berlin's in March.
    expect(result.events?.[0]).toMatchObject({ provider_code: 'POD', local_time: '2026-03-05T11:30:00', time: '2026-03-05T11:30:00+00:00',
      time_zone: 'Europe/Lisbon' });
  });

  it('keeps the Portuguese handoff HTTP-only when a browser service is configured', async () => {
    const blocked = '<html><title>Just a moment...</title></html>';
    const { app, opened, guestCalls, tracking } = tiers([new Response('', { status: 500 })],
      { 'tracking.dpd.pt': blocked }, new TrawlClient('https://browser.test'));
    await opened();
    app.replies.getTrackingScanList = [() => xml(fixture('scans').replaceAll('Musterstadt (DE)', 'Musterville (PT)'))];
    await expect(tracking.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(guestCalls.some(url => new URL(url).host === 'browser.test')).toBe(false);
  });

  it.each([
    ['fails', () => [new Response('', { status: 500 })], 'indeterminate'],
    ['has no history yet', () => guest(Response.json({ parcelNumber: NUMBER, status: { description: 'PARCEL_HANDED' }, parcelHistory: [] })), 'indeterminate'],
    ['changes shape', () => guest(Response.json({ parcelNumber: NUMBER })), 'schema'],
  ])('with a postcode, answers from the app service when the guest protocol %s', async (_, replies, outcome) => {
    const { app, steps, tracking } = tiers(replies());
    const result = await tracking.track({ number: NUMBER, postcode: '10115' });
    expect(result).toMatchObject({ status: 'in_transit', tracking_url: `https://tracking.dpd.de/status/en_US/parcel/${NUMBER}`, dpd_postcode_verified: false });
    expect(app.calls.find(call => call.operation === 'getTrackingData')!.body).toContain('<DeliveryZipCode>10115</DeliveryZipCode>');
    expect(result.events).toHaveLength(5);
    expect(steps).toEqual([['direct', outcome], ['app', 'ok']]);
  });

  it.each([
    ['a missing parcel', () => guest(new Response('', { status: 404 })), 'not_found'],
    ['a parcel it names unknown without the postcode', () => [...guest(unknownParcel()), unknownParcel()], 'not_found'],
  ])('with a postcode, does not ask the app service about %s', async (_, replies, kind) => {
    const { app, steps, tracking } = tiers(replies());
    await expect(tracking.track({ number: NUMBER, postcode: '10115' })).rejects.toMatchObject({ kind });
    expect(app.calls).toHaveLength(0);
    expect(steps.map(([step]) => step)).toEqual(['direct']);
  });

  it('with a postcode, asks DPD\'s group rather than the app service about another country', async () => {
    const elsewhere = { parcelNumber: NUMBER, status: { description: 'DELIVERED', countryCode: 'CZ' },
      parcelHistory: [{ description: 'DELIVERED', eventDateAndTime: '2026-01-03T10:00:00+01:00' }] };
    const { app, steps, tracking } = tiers([...guest(Response.json(elsewhere)), ...guest(Response.json(elsewhere))]);
    expect(await tracking.track({ number: NUMBER, postcode: '10115' })).toMatchObject({ status: 'delivered' });
    expect(app.calls).toHaveLength(0);
    expect(steps).toEqual([['direct', 'indeterminate'], ['abroad', 'ok']]);
  });
});
