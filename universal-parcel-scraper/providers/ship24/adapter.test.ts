// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndeterminateError, NoHistoryError, UpstreamHttpError } from '../../core/errors/index.js';
import { NOOP_RECORDER, type LookupRecord, type StepRecord, type StepRecorder } from '../../core/telemetry/index.js';
import { scrapeUniversalPage } from '../../core/transport/browser.js';
import { adapter, parseShip24Response, Ship24Tracker } from './adapter.js';
import { ship24Checksum, Ship24HttpClient } from './http.js';

vi.mock('../../core/transport/browser', () => ({ scrapeUniversalPage: vi.fn() }));

const number = 'ZZ12345678900';
const delivered = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as unknown;
const history = { data: { tracking_number: number,
  events: [{ timestamp: '2026-09-10T10:00:00+02:00', status: 'Delivered', dispatch_code_id: 7 }] } };
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 201 });
const parcelId = '00000000-0000-4000-8000-000000000000';
const stale = (events: unknown[] = history.data.events) => ({ data: { _id: parcelId, tracking_number: number, to_updated: true, events } });
/** Ship24's 404, whose message names the number or a courier it keeps for subscribers. */
const missing = (message = `${number} Not Found`) => new Response(JSON.stringify({ message, error: 'Not Found', statusCode: 404 }),
  { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const body = (call: Parameters<typeof fetch> | undefined) => JSON.parse(String(call![1]!.body)) as Record<string, unknown>;

/** The instant of one offset-less noon scan at `location`, or undefined when it stays a wall time. */
function noonAt(location: string | undefined, data: Record<string, unknown> = {}, tracking = number, timezone: string | null = null) {
  const [scan] = parseShip24Response({ data: { tracking_number: tracking, ...data,
    events: [{ timestamp: '2026-09-20T12:00:00', status: 'In transit', location }] } }, tracking, timezone).events!;
  return scan!.time;
}

function fixture(executablePath: string | null = '/test/chromium') {
  const steps: StepRecord[] = [];
  const lookups: LookupRecord[] = [];
  const recorder: StepRecorder = { step: (record) => { steps.push(record); }, lookup: (record) => { lookups.push(record); } };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(history));
  const client = new Ship24HttpClient(fetcher);
  return { client, fetcher, steps, lookups,
    tracker: new Ship24Tracker({ httpClient: client, executablePath: executablePath ?? undefined, recorder }) };
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('Ship24 result parsing', () => {
  it('retains the aggregated history, scan places and courier names without recipient or courier contact details', () => {
    const parsed = parseShip24Response(delivered, number);
    expect(parsed).toMatchObject({ status: 'delivered', current_stage: 'delivered', tracking_provider: 'Ship24' });
    expect(parsed.events?.length).toBeGreaterThan(0);
    expect(parsed.events?.[0]).toMatchObject({ stage: 'delivered', description: 'Delivered' });
    // A place holding private delivery details is dropped.
    expect(parsed.events?.[0]?.location).toBeUndefined();
    expect(parsed.events?.[1]).toMatchObject({ description: 'Out for delivery', location: 'Example Town, CH' });
    expect(parsed.reported_carriers).toEqual(['Swiss Post', 'UPS']);
    // Swiss Post's numbers all have a layout of their own and this one fits none: UPS's leg is the hint.
    expect(parsed.discovered_carrier).toBe('ups');
    expect(JSON.stringify(parsed)).not.toMatch(/PRIVATE|PIN:|signed by/i);
  });

  it('reads offset-less scans named "Correos de España" on Correos\'s Madrid clock', () => {
    const result = parseShip24Response({ data: { tracking_number: number,
      couriers: [{ translation: { name: 'Correos de España' } }],
      events: [{ timestamp: '2026-07-02T18:30:00', status: 'Delivered', dispatch_code_id: 7 },
        { timestamp: '2026-01-14T09:15:00', status: 'Admitted' }] } }, number);
    expect(result.events?.map((scan) => scan.time)).toEqual(['2026-07-02T16:30:00.000Z', '2026-01-14T08:15:00.000Z']);
    expect(result).toMatchObject({ reported_carriers: ['Correos de España'], discovered_carrier: 'correos-spain' });
  });

  it('reads Correos\'s copies of an origin post\'s scans on that post\'s clock', () => {
    const correos = { translation: { name: 'Correos de España' } };
    const times = (item: string, data: Record<string, unknown> = {}) => parseShip24Response({ data: { tracking_number: item,
      couriers: [{ translation: { name: 'India Post' } }, correos], ...data, events: [
        { timestamp: '2026-09-29T17:01:00', status: 'En aduana de origen', courier: correos },
        { timestamp: '2026-09-29T16:56:00', status: 'In the exchange office', courier: correos },
      ] } }, item, 'Europe/Madrid').events?.map((scan) => scan.time ?? `local ${scan.local_time}`);
    // Without a destination named, routing's Madrid would date them.
    expect(times('RR123456785IN')).toEqual(['2026-09-29T11:31:00.000Z', '2026-09-29T11:26:00.000Z']);
    expect(times('RR123456785IN', { origin_country_code: 'IN', destination_country_code: 'ES' }))
      .toEqual(['2026-09-29T11:31:00.000Z', '2026-09-29T11:26:00.000Z']);
    // An origin on several clocks leaves the wall clock.
    expect(times('RR123456785US')).toEqual(['local 2026-09-29T17:01:00', 'local 2026-09-29T16:56:00']);
  });

  it('reads SDA\'s offset-less scans beside Poste Italiane\'s instants on Rome\'s clock', () => {
    const result = parseShip24Response({ data: { tracking_number: number,
      couriers: [{ translation: { name: 'Italy SDA' } }, { translation: { name: 'Poste Italiane' } }],
      events: [{ timestamp: '2026-10-16T16:49:00', status: 'LA SPEDIZIONE E\' STATA CONSEGNATA', location: 'CD EXAMPLE' },
        { timestamp: '2026-10-16T14:49:30Z', status: 'la spedizione è stata consegnata', location: 'EXAMPLE (CO)' }] } }, number);
    expect(result.events?.map((scan) => scan.time)).toEqual(['2026-10-16T14:49:30.000Z', '2026-10-16T14:49:00.000Z']);
  });

  it('gives a Posti scan abroad no location rather than Posti\'s "abroad" label', () => {
    const result = parseShip24Response({ data: { tracking_number: number, couriers: [{ translation: { name: 'Posti' } }],
      events: [{ timestamp: '2026-01-13T18:00:00+02:00', status: 'Item has arrived to destination country', location: 'ULKOMAILLA' },
        { timestamp: '2026-01-11T22:00:00+02:00', status: 'The item is on its way to the destination country.', location: 'EXAMPLE AIRPORT' }] } }, number);
    expect(result.events?.[0]?.location).toBeUndefined();
    expect(result.events?.[1]?.location).toBe('EXAMPLE AIRPORT');
  });

  it('gives a scan no location when the provider names no place there', () => {
    const result = parseShip24Response({ data: { tracking_number: number, couriers: [{ translation: { name: 'GLS Italy' } }],
      events: [{ timestamp: '2026-01-13T18:00:00+01:00', status: 'Shipment in transit.', location: 'Centro Di Smistamento - Hub' },
        { timestamp: '2026-01-11T22:00:00+01:00', status: 'Shipment in transit.', location: 'Example Town' }] } }, number);
    expect(result.events?.[0]?.location).toBeUndefined();
    expect(result.events?.[1]?.location).toBe('Example Town');
  });

  it('keeps "DHL Express" a reported name for a waybill whose check digit DHL Express refuses', () => {
    const named = (waybill: string) => parseShip24Response({ data: { tracking_number: waybill,
      couriers: [{ translation: { name: 'DHL Express' } }], events: history.data.events } }, waybill);
    expect(named('1234567890')).toMatchObject({ reported_carriers: ['DHL Express'] });
    expect(named('1234567890').discovered_carrier).toBeUndefined();
    expect(named('1234567891').discovered_carrier).toBe('dhl-express');
  });

  it('leaves out a scan dated without a time instead of failing the history', () => {
    const parsed = parseShip24Response({ data: { tracking_number: number, events: [...history.data.events,
      { timestamp: '2026-09-08', status: 'The shipment has been created by the sender' }] } }, number);
    expect(parsed.events?.map((scan) => scan.description)).toEqual(['Delivered']);
  });

  it('rejects history that belongs to another shipment', () => {
    expect(() => parseShip24Response({ data: { tracking_number: 'OTHER123', events: [] } }, number))
      .toThrow('no matching shipment history');
  });

  it('reports a matching reply with only a notice as inconclusive, never as a reply of the wrong shape', () => {
    const parse = () => parseShip24Response({ data: { tracking_number: number,
      events: [{ timestamp: '2026-09-10T10:00:00+02:00', status: 'Tracking number not found' }] } }, number);
    expect(parse).toThrow(IndeterminateError);
    expect(parse).toThrow(expect.objectContaining({ kind: 'indeterminate', provider: 'Ship24', message: 'No usable tracking events' }));
  });

  it('reports a known parcel without scans as having no history, unless Ship24 has yet to ask the carriers', () => {
    for (const events of [[], undefined]) {
      expect(() => parseShip24Response({ data: { tracking_number: number, events } }, number)).toThrow(NoHistoryError);
    }
    const pending = () => parseShip24Response(stale([]), number);
    expect(pending).toThrow(IndeterminateError);
    expect(pending).not.toThrow(NoHistoryError);
  });

  it.each([
    ['Kuwait', '2026-09-20T09:00:00.000Z'], ['Example Hub, Saudi Arabia', '2026-09-20T09:00:00.000Z'],
    ['КИТАЙ', '2026-09-20T04:00:00.000Z'], ['Example (CZ)', '2026-09-20T10:00:00.000Z'],
    ['EXAMPLE - CHINA', '2026-09-20T04:00:00.000Z'], ['Example Town, ON, Canada', '2026-09-20T16:00:00.000Z'],
  ])('reads an offset-less scan at %s on that place\'s clock, whichever courier relayed it', (location, time) => {
    expect(noonAt(location, { couriers: [{ translation: { name: 'Correos de España' } }] })).toBe(time);
  });

  it('reads a US state or Canadian province only for a parcel in North America or a town that lies there', () => {
    expect(noonAt('Example Town, TX', { origin_country_code: 'CN', destination_country_code: 'US' })).toBe('2026-09-20T17:00:00.000Z');
    expect(noonAt('Example Town, ON', { origin_country_code: 'CN', destination_country_code: 'CA' })).toBe('2026-09-20T16:00:00.000Z');
    // An Italian province is no state.
    expect(noonAt('MILANO MI', { origin_country_code: 'CN', destination_country_code: 'IT' })).toBeUndefined();
  });

  it('places an unlocated scan of a parcel that stays in one country there', () => {
    expect(noonAt(undefined, { origin_country_code: 'PL', destination_country_code: 'PL' })).toBe('2026-09-20T10:00:00.000Z');
    // An S10 item's suffix is its origin; Ship24 can still write the UK as "UK".
    expect(noonAt(undefined, { destination_country_code: 'PL' }, 'ZZ123456785PL')).toBe('2026-09-20T10:00:00.000Z');
    expect(noonAt(undefined, { origin_country_code: 'UK', destination_country_code: 'GB' })).toBe('2026-09-20T11:00:00.000Z');
  });

  it('places a cross-border item\'s UPU events on the side of the border their words name, until it is sent back', () => {
    const upu = { translation: { name: 'UPU' } };
    const walls = (origin: string) => parseShip24Response({ data: { tracking_number: 'ZZ123456785CH',
      origin_country_code: origin, destination_country_code: 'CN', events: [
        { timestamp: '2026-09-12T10:00:00', status: 'Departure from outward office of exchange', location: 'EXAMPLE 2', courier: upu },
        { timestamp: '2026-09-10T10:00:00', status: 'Unsuccessful delivery, Incorrect Address/Item returned to sender', courier: upu },
        { timestamp: '2026-09-08T10:00:00', status: 'Arrival at inward office of exchange', location: 'EXAMPLE', courier: upu },
        { timestamp: '2026-09-06T10:00:00', status: 'In transit', courier: upu },
        { timestamp: '2026-09-04T10:00:00', status: 'Posting/Collection', location: 'EXAMPLE 1', courier: upu },
      ] } }, 'ZZ123456785CH').events!.map((scan) => scan.time ?? scan.local_time);
    expect(walls('CH')).toEqual(['2026-09-12T10:00:00', '2026-09-10T02:00:00.000Z', '2026-09-08T02:00:00.000Z',
      '2026-09-06T10:00:00', '2026-09-04T08:00:00.000Z']);
    // A Swiss number posted in Germany was posted at an office of exchange abroad.
    expect(walls('DE').at(-1)).toBe('2026-09-04T10:00:00');
  });

  it('places EMS\'s origin leg in the origin post\'s country, at a place written as a code', () => {
    // China Post's scans in China share these digits; read as UTC, export customs would follow the release.
    const ems = { crawler_code: 'ems-tracking', translation: { name: 'EMS' } };
    expect(parseShip24Response({ data: { tracking_number: 'ZZ123456785CN', origin_country_code: 'CN', destination_country_code: 'GB',
      events: [
        { timestamp: '2026-10-11T02:42:00', status: 'Released from export customs and security', location: 'GZSGJHHJ', courier: ems },
        { timestamp: '2026-10-10T21:58:00', status: 'Presented to export customs and security', location: 'GZSGJHHJ', courier: ems },
        { timestamp: '2026-10-10T15:55:00', status: 'Posted', location: '510000', courier: ems },
      ] } }, 'ZZ123456785CN').events!.map((scan) => scan.time)).toEqual([
      '2026-10-10T18:42:00.000Z', '2026-10-10T13:58:00.000Z', '2026-10-10T07:55:00.000Z',
    ]);
  });

  it('leaves an unlocated scan of a cross-border parcel a wall time, not on its relay\'s or carrier\'s clock', () => {
    const correos = { couriers: [{ translation: { name: 'Correos de España' } }] };
    expect(noonAt(undefined, correos)).toBe('2026-09-20T10:00:00.000Z');
    expect(noonAt(undefined, { ...correos, origin_country_code: 'ES', destination_country_code: 'CN' })).toBeUndefined();
    expect(noonAt(undefined, { destination_country_code: 'SV' }, 'ZZ123456785CH', 'Europe/Zurich')).toBeUndefined();
    expect(noonAt(undefined, {}, number, 'Europe/Zurich')).toBe('2026-09-20T10:00:00.000Z');
  });

  it('reads a town and bracketed code on a cross-border parcel by the country of the scan\'s courier, when it keeps one clock', () => {
    const noon = (location: string, country?: string) => parseShip24Response({ data: { tracking_number: number,
      origin_country_code: 'CN', destination_country_code: 'DE', events: [{ timestamp: '2026-09-20T12:00:00', status: 'In transit',
        location, courier: { crawler_code: 'example-tracking', country_code: country, translation: { name: 'Example Courier' } } }] } },
    number).events![0]!.time;
    // "(DE)" alone could be Delaware.
    expect(noonAt('Example Town (DE)', { origin_country_code: 'CN', destination_country_code: 'DE' })).toBeUndefined();
    expect(noon('Example Town (DE)', 'DE')).toBe('2026-09-20T10:00:00.000Z');
    expect(noon('Example Town (DE)', 'AT')).toBeUndefined();
    expect(noon('Example Town (DE)')).toBeUndefined();
    expect(noon('Example data centre', 'DE')).toBeUndefined();
    // The United States keep several clocks.
    expect(noon('Example Town (US)', 'US')).toBeUndefined();
  });
});

describe('Ship24 feeds that relabel the carrier\'s wall clock', () => {
  /** The clocks Ship24's `crawler` feed gives for scans `[timestamp, location, status]`, as the result keeps them. */
  function feed(crawler: string, name: string, scans: [string, string | undefined, string?][], data: Record<string, unknown> = {}, tracking = number) {
    const courier = { crawler_code: crawler, translation: { name } };
    return parseShip24Response({ data: { tracking_number: tracking, couriers: [{ translation: { name } }], ...data,
      events: scans.map(([timestamp, location, status], index) => ({ timestamp, location, status: status ?? `Scan ${index}`, courier })) } }, tracking)
      .events!.map((scan) => scan.time ?? `local ${String(scan.local_time)}`);
  }

  it('reads Canada Post\'s constant -05:00 as a label on the province\'s clock, which an unlocated scan borrows', () => {
    expect(feed('canada-post-tracking', 'Canada Post', [['2026-10-10T12:43:21-05:00', 'EXAMPLE TOWN ON'],
      ['2026-10-03T11:28:48-05:00', undefined]])).toEqual(['2026-10-10T16:43:21.000Z', '2026-10-03T15:28:48.000Z']);
    // With no scan of the feed to borrow from, and no clock for the carrier, it stays a wall time.
    expect(feed('canada-post-tracking', 'Canada Post', [['2026-10-03T11:28:48-05:00', undefined]])).toEqual(['local 2026-10-03T11:28:48']);
  });

  it('reads UniUni\'s Z as the depot\'s clock, in the states and provinces its catalog entry serves', () => {
    expect(feed('uniuni-tracking', 'UniUni', [['2026-10-09T10:20:54Z', 'Example Town MI'], ['2026-10-01T08:21:40Z', 'Example Town ON'],
      ['2026-09-30T13:02:00Z', 'EXAMPLE DATA CENTER']]))
      .toEqual(['2026-10-09T14:20:54.000Z', '2026-10-01T12:21:40.000Z', '2026-09-30T17:02:00.000Z']);
  });

  it('reads GOFO\'s -07:00 as a label on its station\'s clock, which a delivery round and an unlocated scan borrow', () => {
    // Ocala keeps New York's clock and Melrose Park Chicago's; GOFO dates a label on Pacific time.
    expect(feed('gofo-express-tracking', 'GOFO Express', [['2026-10-03T16:01:13-07:00', 'Example Town'],
      ['2026-10-03T08:44:20-07:00', 'Ocala'], ['2026-09-25T16:46:27-07:00', undefined], ['2026-09-24T21:46:19-07:00', 'melrose park'],
      ['2026-09-18T19:47:37-07:00', undefined, 'Shipping Label Created']])).toEqual(['2026-10-03T20:01:13.000Z',
      '2026-10-03T12:44:20.000Z', '2026-09-25T21:46:27.000Z', '2026-09-25T02:46:19.000Z', '2026-09-19T02:47:37.000Z']);
    // A town the stations do not list, with no station to borrow from, keeps Ship24's Pacific label, the last guess.
    // A state still places it, and a town named like a country ("Holland") is in the US.
    const alone = (location: string) => feed('gofo-express-tracking', 'GOFO Express', [['2026-10-03T16:01:13-07:00', location]]);
    expect([alone('Example Town'), alone('Holland'), alone('Example Town, FL')])
      .toEqual([['2026-10-03T23:01:13.000Z'], ['2026-10-03T23:01:13.000Z'], ['2026-10-03T20:01:13.000Z']]);
  });

  it('reads PostNL\'s and Amazon UK\'s Z as the clock of the scan\'s country or of the marketplace', () => {
    expect(feed('postnl-tracking', 'PostNL', [['2026-08-12T11:19:00Z', 'SWEDEN'], ['2026-08-06T16:56:00Z', 'THE NETHERLANDS']],
      { destination_country_code: 'SE' })).toEqual(['2026-08-12T09:19:00.000Z', '2026-08-06T14:56:00.000Z']);
    expect(feed('amazon-uk-tracking', 'Amazon UK', [['2026-09-28T17:35:52Z', undefined]])).toEqual(['2026-09-28T16:35:52.000Z']);
  });

  it('keeps the UTC of PostNL\'s label creation and processing record, which name no country', () => {
    expect(feed('postnl-tracking', 'PostNL', [['2026-10-19T13:09:00Z', 'THE NETHERLANDS'],
      ['2026-10-14T20:11:00Z', undefined, 'The item is pre-advised to PostNL'], ['2026-10-12T01:07:00Z', undefined, 'The item is being processed'],
      ['2026-10-08T08:27:00Z', undefined, 'The shipping label has been created']]))
      .toEqual(['2026-10-19T11:09:00.000Z', '2026-10-14T18:11:00.000Z', '2026-10-12T01:07:00.000Z', '2026-10-08T08:27:00.000Z']);
  });

  it('reads CTT\'s Z as the clock of its Portuguese sites, which an unlocated scan abroad borrows', () => {
    expect(feed('portugal-ctt-tracking', 'Portugal CTT', [['2026-08-31T20:53:13Z', 'PTEXAA - (OUTRO) EXAMPLE'],
      ['2026-08-29T11:46:23Z', 'Centro operacional Example'], ['2026-08-28T10:13:58Z', undefined]],
    { origin_country_code: 'PT', destination_country_code: 'MX' }, 'ZZ123456785PT'))
      .toEqual(['2026-08-31T19:53:13.000Z', '2026-08-29T10:46:23.000Z', '2026-08-28T09:13:58.000Z']);
    expect(feed('portugal-ctt-tracking', 'Portugal CTT', [['2026-05-11T10:42:39Z', 'Centro operacional 9580 Example'],
      ['2026-05-11T08:54:09Z', undefined]])).toEqual(['2026-05-11T10:42:39.000Z', '2026-05-11T07:54:09.000Z']);
  });

  it('reads CTT\'s Z at a CTT Express agency in Spain as Madrid\'s clock, as CTT\'s own adapter does', () => {
    expect(feed('portugal-ctt-tracking', 'Portugal CTT', [['2026-10-28T03:17:09Z', '9999999 - (CO) C.O. EXAMPLE'],
      ['2026-10-27T11:00:05Z', '009999 - (PL) CENTRO DE TRATAMIENTO ADUANERO']],
    { origin_country_code: 'ES', destination_country_code: 'PT' }))
      .toEqual(['2026-10-28T03:17:09.000Z', '2026-10-27T10:00:05.000Z']);
  });

  it('reads InPost UK\'s offset-less clocks as UTC, the instants of Collect+\'s London offsets', () => {
    // Live shape (2026-10-16): one parcel's scans from both feeds, an hour apart on the digits.
    const scan = (timestamp: string, status: string, crawler: string) => ({ timestamp, status, courier: { crawler_code: crawler } });
    const reply = parseShip24Response({ data: { tracking_number: number,
      couriers: [{ translation: { name: 'Collect+' } }, { translation: { name: 'Inpost (UK)' } }],
      events: [scan('2026-10-14T19:18:43+01:00', 'Received at EXAMPLE LOCAL', 'collect-plus-tracking'),
        scan('2026-10-14T18:18:43', 'Parcel Stored by Customer', 'inpost-uk-tracking')] } }, number);
    expect(reply.events?.map((event) => event.time)).toEqual(['2026-10-14T18:18:43.000Z', '2026-10-14T18:18:43.000Z']);
  });

  it('leaves out a milestone Mainfreight\'s feed relays before its clock has come anywhere', () => {
    // Live shape: an air job's arrival a day ahead, without the tracker's "(Estimated)".
    const scan = (timestamp: string, status: string) => ({ timestamp, status, courier: { crawler_code: 'mainfreight-tracking' } });
    const reply = parseShip24Response({ data: { tracking_number: number, couriers: [{ translation: { name: 'Mainfreight' } }],
      events: [scan('2026-10-22T05:40:00', 'Arrival at Final Discharge Port'), scan('2026-10-21T19:00:00', 'Arrival at Transshipment Port'),
        scan('2026-10-20T16:55:00', 'Departed')] } }, number, 'Pacific/Auckland', Date.parse('2026-10-21T06:00:00Z'));
    // 19:00 has come at UTC+14, so it may have happened.
    expect(reply.events?.map((event) => event.description)).toEqual(['Arrival at Transshipment Port', 'Departed']);
  });

  it('keeps the wall clocks of a Mainfreight air or ocean job, whose ports can be anywhere', () => {
    const scan = (timestamp: string, status: string, location?: string) => ({ timestamp, status, courier: { crawler_code: 'mainfreight-tracking' },
      ...(location ? { location } : {}) });
    const read = (events: unknown[]) => parseShip24Response({ data: { tracking_number: number, couriers: [{ translation: { name: 'Mainfreight' } }],
      events } }, number, 'Pacific/Auckland', Date.parse('2026-10-21T06:00:00Z')).events?.map((event) => event.time ?? event.local_time);
    expect(read([scan('2026-10-20T16:55:00', 'Departed'), scan('2026-10-17T14:50:00', 'Departure from First Load Port')]))
      .toEqual(['2026-10-20T16:55:00', '2026-10-17T14:50:00']);
    // A placed scan still takes its place's clock, and a transport consignment New Zealand's.
    expect(read([scan('2026-10-20T16:55:00', 'Departed', 'Example Port, Singapore'), scan('2026-10-17T14:50:00', 'Departure from First Load Port')])?.[0])
      .toBe('2026-10-20T08:55:00.000Z');
    expect(read([scan('2026-10-20T16:55:00', 'In Transit'), scan('2026-10-17T14:50:00', 'Picked Up')]))
      .toEqual(['2026-10-20T03:55:00.000Z', '2026-10-17T01:50:00.000Z']);
  });

  it('turns 4PX\'s instant back into the wall clock it read on China\'s, then places it', () => {
    expect(feed('4px-tracking', '4PX', [['2026-05-26T06:30:03+00:00', 'US  NY  EXAMPLE TOWN 12345'], ['2026-05-24T23:39:05+00:00', 'US     '],
      ['2026-05-21T12:35:30+00:00', 'CN'], ['2026-05-21T09:08:01+00:00', 'US  NY  EXAMPLE TOWN 12345'], ['2026-05-21T09:04:13+00:00', undefined]],
    { origin_country_code: 'CN', destination_country_code: 'US' })).toEqual(['2026-05-26T18:30:03.000Z', '2026-05-25T11:39:05.000Z',
      // USPS's label comes before the pickup in China, so the first scan borrows the pickup's clock, not the label's.
      '2026-05-21T21:08:01.000Z', '2026-05-21T12:35:30.000Z', '2026-05-21T09:04:13.000Z']);
  });

  it('reads 17FEIA\'s rows as its adapter does: the warehouse on Beijing, a relayed scan on its country\'s clock, the flight on its wall clock', () => {
    expect(feed('feia-tracking', 'FEIA', [['2026-10-23T11:43:00', 'Example Town (NL)', 'Delivered., 成功签收'],
      ['2026-10-22T01:30:00', 'Example Town (DE)', 'In transit., 运输途中'],
      ['2026-10-18T11:45:00', undefined, 'Broker picked up Shipment and delivered to warehouse., OTHER'],
      ['2026-10-16T20:05:00', undefined, 'Flight has departed., 航班已起飞'],
      ['2026-10-14T18:00:00', undefined, 'Order dispatched from warehouse., OTHER'],
      ['2026-10-12T16:33:42', 'Example Town', 'Warehouse receipt., 仓库收货'],
      ['2026-09-21T21:16:14', undefined, 'Item information received., OTHER']])).toEqual([
      '2026-10-23T09:43:00.000Z', '2026-10-21T23:30:00.000Z', 'local 2026-10-18T11:45:00', 'local 2026-10-16T20:05:00',
      '2026-10-14T10:00:00.000Z', '2026-10-12T08:33:42.000Z', '2026-09-21T13:16:14.000Z']);
  });

  it('takes the offset of any other feed as sent', () => {
    expect(feed('example-tracking', 'Example Courier', [['2026-10-10T12:43:21-05:00', 'EXAMPLE TOWN ON']])).toEqual(['2026-10-10T17:43:21.000Z']);
  });

  it('reads the destination post\'s scans Swiss Post\'s feed relays on that office\'s clock, under Swiss Post\'s offset', () => {
    // UPU has China's arrival at 08:15 in Beijing; Swiss Post's own scans keep their offset.
    const scans: [string, string | undefined, string][] = [['2026-09-04T06:21:49+02:00', undefined, 'Enquiry initiated'],
      ['2026-08-07T08:15:00+02:00', undefined, 'Arrival in destination country'],
      ['2026-08-04T02:30:11+02:00', 'Example, CH', 'Forwarding abroad']];
    expect(feed('swiss-post-tracking', 'Swiss Post', scans, { origin_country_code: 'CH', destination_country_code: 'CN' }, 'ZZ123456785CH'))
      .toEqual(['2026-09-04T04:21:49.000Z', '2026-08-07T00:15:00.000Z', '2026-08-04T00:30:11.000Z']);
    // A destination on several clocks keeps Swiss Post's offset, the last guess.
    expect(feed('swiss-post-tracking', 'Swiss Post', scans, { origin_country_code: 'CH', destination_country_code: 'US' }, 'ZZ123456785CH')[1])
      .toBe('2026-08-07T06:15:00.000Z');
  });
});

describe('Ship24 anonymous HTTP tracking', () => {
  it('makes one signed JSON POST per lookup with no browser, bootstrap, cookie or login', async () => {
    const { tracker, fetcher, steps, lookups } = fixture();
    for (let index = 0; index < 2; index++) {
      await expect(tracker.fetch(number)).resolves.toMatchObject({ current_stage: 'delivered', tracking_source: 'structured-web-response' });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
    expect(steps.map(({ step, outcome }) => [step, outcome])).toEqual([['direct', 'ok'], ['direct', 'ok']]);
    expect(lookups.map(({ carrier, finalStep, outcome }) => [carrier, finalStep, outcome]))
      .toEqual([['Ship24', 'direct', 'ok'], ['Ship24', 'direct', 'ok']]);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.ship24.com/api/parcels/${number}?lang=en`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    const headers = init!.headers as Record<string, string>;
    const [encoded, signature] = headers['x-ship24-token']!.split('.') as [string, string];
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString())).toMatchObject({ a: expect.any(Number), b: expect.any(Number), c: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(headers).not.toHaveProperty('Cookie');
    expect(headers).not.toHaveProperty('Authorization');
  });

  it('uses standard unsigned MurmurHash3 checksums and binds tokens to the requested number', async () => {
    expect(ship24Checksum('')).toBe(0);
    expect(ship24Checksum('hello')).toBe(613153351);
    expect(ship24Checksum('foo')).toBe(4138058784);
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { client, fetcher } = fixture();
    await client.fetch(number, 1000);
    await client.fetch('ZZ12345678901', 1000);
    const tokens = fetcher.mock.calls.map(([, init]) => (init!.headers as Record<string, string>)['x-ship24-token']);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('records the rejected HTTP path before browser recovery starts', async () => {
    const { tracker, fetcher, steps } = fixture();
    fetcher.mockResolvedValueOnce(new Response('rejected', { status: 403 }));
    vi.mocked(scrapeUniversalPage).mockImplementationOnce(async () => {
      expect(steps).toMatchObject([{ carrier: 'Ship24', step: 'direct', outcome: 'challenge', errorType: 'UpstreamHttpError' }]);
      return { events: [], status: 'delivered' };
    });
    await expect(tracker.fetch(number)).resolves.toMatchObject({ tracking_source: 'browser-session-response' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(steps[1]).toMatchObject({ step: 'browser', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'challenge' });
  });

  it('reports the rejected HTTP path itself when no Chromium is configured', async () => {
    const { tracker, fetcher, steps, lookups } = fixture(null);
    fetcher.mockResolvedValueOnce(new Response('rejected', { status: 403 }));
    await expect(tracker.fetch(number)).rejects.toMatchObject({ status: 403, kind: 'challenge' });
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
    expect(steps.map(({ step, outcome }) => [step, outcome])).toEqual([['direct', 'challenge']]);
    expect(lookups).toMatchObject([{ finalStep: 'direct', outcome: 'challenge', stepsAvailable: 1 }]);
  });

  it.each([429, 503])('preserves HTTP %i and Retry-After without browser amplification', async (status) => {
    const { tracker, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(new Response('', { status, headers: { 'Retry-After': '120' } }));
    await expect(tracker.fetch(number)).rejects.toMatchObject({ status, retryAfterMs: 120_000 });
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([404, 410])('reports HTTP %i as not found without waiting for the browser', async (status) => {
    const { tracker, fetcher, steps } = fixture();
    fetcher.mockResolvedValueOnce(new Response('', { status }));
    await expect(tracker.fetch(number)).rejects.toMatchObject({ status, kind: 'not_found' });
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step: 'direct', outcome: 'not_found' });
  });

  it('asks once more naming the courier of the carrier the parcel is filed under after a 404, as the page\'s details dialog does', async () => {
    const { tracker, fetcher, steps } = fixture();
    fetcher.mockResolvedValueOnce(missing());
    await expect(tracker.fetch(number, undefined, null, undefined, 'dpd-pl'))
      .resolves.toMatchObject({ current_stage: 'delivered', tracking_source: 'structured-web-response' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(body(fetcher.mock.calls[0])).not.toHaveProperty('to_check');
    expect(String(fetcher.mock.calls[1]![0])).toBe(`https://api.ship24.com/api/parcels/${number}?lang=en`);
    expect(body(fetcher.mock.calls[1])).toMatchObject({ postCode: '', destinationCountryCode: '', to_check: ['dpd-pl'], uL: 'en-US' });
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
    expect(steps.map(({ step, outcome }) => [step, outcome])).toEqual([['direct', 'ok']]);
  });

  it('keeps the first 404 when the courier named is not found either, and reports any other failure of that request', async () => {
    const { tracker, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(missing()).mockResolvedValueOnce(new Response('', { status: 404 }));
    const first = await tracker.fetch(number, undefined, null, undefined, 'dpd-pl').catch((error: unknown) => error);
    expect(first).toMatchObject({ status: 404, kind: 'not_found', diagnostics: { body_read: 'complete' } });
    fetcher.mockResolvedValueOnce(missing()).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(tracker.fetch(number, undefined, null, undefined, 'dpd-pl')).rejects.toMatchObject({ status: 429, retryAfterMs: 120_000 });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });

  it('asks once for a carrier without a Ship24 code, or with too little time left', async () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const { client, tracker, fetcher } = fixture(null);
    fetcher.mockResolvedValueOnce(missing());
    await expect(tracker.fetch(number, undefined, null, undefined, 'usps')).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledOnce();
    vi.spyOn(client, 'fetch').mockImplementationOnce(async () => { clock += 44_000; throw new UpstreamHttpError('Ship24 HTTP', 404); });
    await expect(tracker.fetch(number, 45_000, null, undefined, 'dpd-pl')).rejects.toMatchObject({ status: 404 });
    expect(client.fetch).toHaveBeenCalledOnce();
  });

  it('reports a courier Ship24 shows its subscribers only as not found, without its name or the browser', async () => {
    const { tracker, fetcher, steps } = fixture();
    fetcher.mockResolvedValueOnce(missing('Example Courier (Example) is not available for website.'));
    const error = await tracker.fetch(number, undefined, null, undefined, 'dpd-pl').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'NotFoundError', kind: 'not_found', status: 404, reason: 'subscriber_only' });
    expect(String((error as Error).message)).not.toContain('Example');
    expect((error as Error).cause).toBeInstanceOf(UpstreamHttpError);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
    expect(steps).toMatchObject([{ step: 'direct', outcome: 'not_found', errorType: 'NotFoundError' }]);
  });

  it('passes the carrier the parcel is filed under from the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(missing()).mockResolvedValueOnce(reply(history));
    const provider = adapter({ fetcher, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null, env: {} });
    await expect(provider.track({ number, carrier: 'four-px' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(body(fetcher.mock.calls[1])).toMatchObject({ to_check: ['4px'] });
  });

  it('reports a history without usable scans as inconclusive when no Chromium is configured', async () => {
    const { tracker, fetcher, steps } = fixture(null);
    fetcher.mockResolvedValueOnce(reply({ data: { tracking_number: number,
      events: [{ timestamp: '2026-09-10T10:00:00+02:00', status: 'Tracking number not found' }] } }));
    await expect(tracker.fetch(number)).rejects.toMatchObject({ kind: 'indeterminate', message: 'No usable tracking events' });
    expect(steps.map(({ step, outcome, errorType }) => [step, outcome, errorType])).toEqual([['direct', 'indeterminate', 'IndeterminateError']]);
  });

  it('asks Ship24 to query the carriers again when the stored parcel says so, as the web app does', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { tracker, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(reply(stale([])));
    await expect(tracker.fetch(number)).resolves.toMatchObject({ current_stage: 'delivered', tracking_source: 'structured-web-response' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe(`https://api.ship24.com/api/parcels/update/${parcelId}/mainTN/${number}?lang=en`);
    expect(init).toMatchObject({ method: 'POST' });
    // Decimal UTF-8 bytes of the markers, the time and the number, two bytes changed to 150.
    const signature = (init!.headers as Record<string, string>)['x-ship24-token']!;
    expect(Buffer.from(signature.split(',').map(Number)).toString()).toBe(`\u1580,1000000,\u1782,${number},\u1581`);
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });

  it('keeps a stored history when its refresh fails or takes too long', async () => {
    const { client, tracker, fetcher } = fixture();
    const refresh = vi.spyOn(client, 'refresh');
    fetcher.mockResolvedValueOnce(reply(stale())).mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(tracker.fetch(number)).resolves.toMatchObject({ current_stage: 'delivered', tracking_source: 'structured-web-response' });
    expect(refresh).toHaveBeenCalledWith(parcelId, number, 15_000, expect.anything());
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });

  it.each([
    ['no scans', { events: [] }],
    ['an error', { error: 'Synthetic failure', events: history.data.events }],
    ['scans that are not a list', { events: {} }],
  ])('keeps a stored history when its refresh succeeds with %s', async (_, data) => {
    const { tracker, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(reply(stale())).mockResolvedValueOnce(reply({ data: { tracking_number: number, ...data } }));
    await expect(tracker.fetch(number)).resolves.toMatchObject({ current_stage: 'delivered', tracking_source: 'structured-web-response' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });

  it('reports a parcel Ship24 still has no scans for after the refresh, without the browser', async () => {
    const { tracker, fetcher, steps } = fixture();
    fetcher.mockResolvedValueOnce(reply(stale([]))).mockResolvedValueOnce(reply({ data: { tracking_number: number, events: [] } }));
    await expect(tracker.fetch(number)).rejects.toThrow(NoHistoryError);
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
    expect(steps.map(({ step, errorType }) => [step, errorType])).toEqual([['direct', 'NoHistoryError']]);
  });

  it('lets the browser try when the refresh of a parcel without scans fails', async () => {
    const { tracker, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(reply(stale([]))).mockRejectedValueOnce(new TypeError('fetch failed'));
    vi.mocked(scrapeUniversalPage).mockResolvedValueOnce({ events: [], status: 'delivered' });
    await expect(tracker.fetch(number)).resolves.toMatchObject({ tracking_source: 'browser-session-response' });
  });

  it('gives the direct request all of the budget but the browser\'s reserve', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    for (const [executablePath, budget, direct] of [['/test/chromium', 45_000, 35_000], ['/test/chromium', 12_000, 6000], [null, 45_000, 45_000]] as const) {
      const { client, tracker } = fixture(executablePath);
      const fetch = vi.spyOn(client, 'fetch');
      await tracker.fetch(number, budget);
      expect(fetch).toHaveBeenCalledWith(number, direct, expect.anything());
    }
  });

  it('rejects unrelated history before falling back and does not leak it into the result', async () => {
    const { tracker, fetcher, steps } = fixture();
    fetcher.mockResolvedValueOnce(reply({ data: { ...history.data, tracking_number: 'OTHER123' } }));
    vi.mocked(scrapeUniversalPage).mockRejectedValueOnce(new UpstreamHttpError('Ship24', 403));
    await expect(tracker.fetch(number)).rejects.toMatchObject({ status: 403 });
    expect(steps[1]).toMatchObject({ step: 'browser', fallbackFrom: 'direct', fallbackErrorType: 'SchemaError' });
  });

  it('validates inputs before network access', async () => {
    const { client, fetcher } = fixture();
    await expect(client.fetch('https://private.test', 1000)).rejects.toThrow('tracking number');
    await expect(client.fetch(number, Infinity)).rejects.toThrow('timeout');
    await expect(client.fetch(number, 1000, undefined, 'Example Courier')).rejects.toThrow('courier code');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('subtracts direct time from the browser budget', async () => {
    let clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const { client, tracker } = fixture();
    vi.spyOn(client, 'fetch').mockImplementationOnce(async () => { clock += 7500; throw new Error('timeout'); });
    vi.mocked(scrapeUniversalPage).mockResolvedValueOnce({ events: [] });
    await tracker.fetch(number);
    expect(scrapeUniversalPage).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 37_500 }), expect.anything(), expect.anything());
  });

  it('ends the browser recovery when the caller cancels', async () => {
    const { tracker, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(new Response('rejected', { status: 403 }));
    vi.mocked(scrapeUniversalPage).mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const lookup = tracker.fetch(number, undefined, null, controller.signal);
    await vi.waitFor(() => expect(scrapeUniversalPage).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));
    await expect(lookup).rejects.toThrow('caller cancelled');
  });

  it('runs the browser alone when no signed HTTP client is configured', async () => {
    vi.mocked(scrapeUniversalPage).mockResolvedValueOnce({ events: [], status: 'delivered' });
    await expect(new Ship24Tracker({ executablePath: '/test/chromium' }).fetch(number))
      .resolves.toMatchObject({ tracking_source: 'browser-session-response' });
    await expect(new Ship24Tracker({ executablePath: '/test/chromium', timeoutMs: Infinity }).fetch(number)).rejects.toThrow('timeout');
  });
});
