import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/index.js';
import { adapter, dealerSendTrackingUrl, DealerSendTracker } from './adapter.js';
import { normalizeDealerSendNumber, parseDealerSend } from './parser.js';
import { dealerSendStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const USPS_PARCEL = 'DSLAF9000000001YQ';
const GOFO_PARCEL = 'DSLAF9000000002YQ';
const CANADA_PARCEL = 'DSLAF9000000003YQ';
const UNKNOWN = 'DSLAF9000000009YQ';
// Synthetic partner numbers: a USPS package barcode with its check digit, and GOFO's CR and twelve digits.
const USPS_NUMBER = '9261290000000000000007';
const GOFO_NUMBER = 'CR010000000001';
const READ_AT = Date.parse('2026-10-01T00:00:00Z');

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());

type Row = Record<string, unknown>;
type Shipment = Record<string, unknown> & { trackingEvents: Row[] | null };
const reply = (name: string) => JSON.parse(text(name)) as Record<string, Shipment>;
const edited = (name: string, number: string, change: (shipment: Shipment) => void) => {
  const payload = reply(name);
  change(payload[number]!);
  return payload;
};
const row = (localTime: string, status: string, statusDescription: string, region: string | null = null, regionName: string | null = null): Row =>
  ({ localTime, status, statusDescription, region, regionName });

describe('DealerSend numbers', () => {
  const offers = (number: string) => {
    const match = detectCarrierMatch(number);
    return [match.carrier, ...(match.candidates ?? [])];
  };

  it('names DealerSend for DSLAF, ten digits and YQ', () => {
    expect(detectCarrierMatch(USPS_PARCEL)).toMatchObject({ carrier: 'dealersend', confidence: 'high' });
    expect(detectCarrierMatch(USPS_PARCEL.toLowerCase())).toMatchObject({ carrier: 'dealersend', confidence: 'high' });
    for (const other of ['DSLAF900000001YQ', 'DSLAF90000000012YQ', 'DSLAG9000000001YQ', 'DSLA9000000001YQ', 'XDSLAF9000000001YQ',
      'DSLAF9000000001Y', 'DSLAF9000000001YX', 'DSLAF9000000001YQ1', 'DSLAF900000000AYQ']) {
      expect(offers(other), other).not.toContain('dealersend');
    }
  });

  it('takes a number without the spaces and dashes a user can type in it', () => {
    expect(normalizeDealerSendNumber(' dslaf-90000 00001yq ')).toBe(USPS_PARCEL);
    expect(() => normalizeDealerSendNumber('DS1')).toThrow('6 to 40');
    expect(() => normalizeDealerSendNumber('DSLAF/9000000001')).toThrow('6 to 40');
  });
});

describe('DealerSend HTTP adapter', () => {
  it('asks the tracking page’s lookup for the one number', async () => {
    const fetcher = replying(() => json(text('delivered-usps.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DealerSendTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${USPS_PARCEL.toLowerCase()} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://dealer-send.com/myapi/trackings/track?trackingNumbers=${USPS_PARCEL}`);
    expect(url).toBe(dealerSendTrackingUrl(USPS_PARCEL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dealersend', step: 'direct', outcome: 'ok' }));
  });

  it('keeps the rows’ wall clocks and places without postcodes, and hands a USPS parcel to USPS', () => {
    const result = parseDealerSend(reply('delivered-usps.json'), USPS_PARCEL, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Front Desk/Reception/Mail Room', last_update: null, last_update_local: '2026-04-14T18:11:00',
      expected_delivery: null, service_name: 'US Special', destination_country: 'US',
      delivery_carrier: 'usps', delivery_tracking_number: USPS_NUMBER });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map((event) => [event.local_time, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-04-14T18:11:00', 'NEW YORK, NY, US', 'delivered'],
      ['2026-04-14T06:10:00', 'NEW YORK, NY, US', 'out_for_delivery'],
      ['2026-04-13T09:04:00', 'NEW YORK NY DISTRIBUTION CENTER, US', 'in_transit'],
      ['2026-04-12T20:11:00', 'YORK, PA, US', 'in_transit'],
      ['2026-04-12T09:14:00', 'YORK, PA, US', 'in_transit'],
      ['2026-04-11T22:18:25', 'JAMAICA, NEWYORK, US', 'in_transit'],
      ['2026-04-11T19:19:02', 'JAMAICA, NEWYORK, US', 'in_transit'],
      ['2026-04-11T19:19:02', 'JAMAICA, NEWYORK, US', 'in_transit'],
      ['2026-04-11T18:19:00', null, 'in_transit'],
      ['2026-04-09T17:25:00', 'John F. Kennedy, US', 'in_transit'],
      ['2026-04-09T16:12:00', 'Hong Kong, HK', 'in_transit'],
      ['2026-04-09T02:13:00', 'Hong Kong, HK', 'in_transit'],
      ['2026-04-06T16:59:00', 'Tsuen Wan, HK', 'in_transit'],
      ['2026-04-06T15:09:19', 'Tsuen Wan, HK', 'in_transit'],
      ['2026-04-06T13:59:22', 'Hong Kong, HK', 'accepted'],
      ['2026-04-04T11:30:26', null, 'registered'],
    ]);
    // No row carries an instant or an offset of its own, and no postcode is kept.
    expect(result.events!.every((event) => event.time === undefined && event.provider_code)).toBe(true);
    expect(result.events!.filter((event) => /\d/.test(event.location ?? ''))).toEqual([]);
  });

  it('dates the kept wall clocks on Node by their places', () => {
    const events = dateLocalClocks('dealersend', parseDealerSend(reply('delivered-usps.json'), USPS_PARCEL, READ_AT)).events!;
    expect(events[0]).toMatchObject({ local_time: '2026-04-14T18:11:00', time: '2026-04-14T18:11:00-04:00',
      time_zone: 'America/New_York', time_zone_basis: 'place' });
    expect(events.at(-2)).toMatchObject({ local_time: '2026-04-06T13:59:22', time: '2026-04-06T13:59:22+08:00',
      time_zone: 'Asia/Hong_Kong', time_zone_basis: 'place' });
    expect(events.at(-1)).toMatchObject({ time_zone: 'Asia/Hong_Kong', time_zone_basis: 'neighbour' });
    // The landing is on the destination airport's clock, and the partner's pickup after it too.
    expect(events.find((event) => event.location === 'John F. Kennedy, US')).toMatchObject({ time: '2026-04-09T17:25:00-04:00',
      time_zone: 'America/New_York', time_zone_basis: 'place' });
    expect(events.find((event) => event.description === 'Picked Up By Shipping Partner, Usps Awaiting Item'))
      .toMatchObject({ time_zone: 'America/New_York', time_zone_basis: 'neighbour' });
    // GOFO's hub in Vernon is the one by Los Angeles, not a namesake in another zone.
    const gofo = dateLocalClocks('dealersend', parseDealerSend(reply('delivered-gofo.json'), GOFO_PARCEL, READ_AT)).events!;
    expect(gofo.filter((event) => event.location === 'Vernon, US').map((event) => event.time_zone)).toEqual(Array(4).fill('America/Los_Angeles'));
  });

  it('names GOFO when its rows name it and the partner number fits GOFO', () => {
    const result = parseDealerSend(reply('delivered-gofo.json'), GOFO_PARCEL, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', delivery_carrier: 'gofo', delivery_tracking_number: GOFO_NUMBER,
      last_update_local: '2026-05-12T15:03:59' });
    expect(result.events!.slice(0, 3).map((event) => event.location)).toEqual(['Los Angeles, US', 'Los Angeles, US', 'Vernon, US']);
    // The same number under rows that do not name GOFO stays unattributed.
    const unnamed = parseDealerSend(edited('delivered-gofo.json', GOFO_PARCEL, (shipment) => {
      shipment.trackingEvents = shipment.trackingEvents!.filter((scan) => !/gofo/i.test(String(scan.statusDescription)));
    }), GOFO_PARCEL, READ_AT);
    expect(unnamed.delivery_carrier).toBeUndefined();
    expect(unnamed.delivery_tracking_number).toBe(GOFO_NUMBER);
  });

  it('keeps a partner number no carrier is named for, and reads relayed rows by their wording', () => {
    const result = parseDealerSend(reply('in-transit-canada.json'), CANADA_PARCEL, READ_AT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', destination_country: 'CA',
      service_name: 'Direct Line - Postal', delivery_tracking_number: 'SPRX0000000000001A' });
    expect(result.delivery_carrier).toBeUndefined();
    const staged = Object.fromEntries(result.events!.map((event) => [event.description, event.stage ?? null]));
    expect(staged).toMatchObject({
      'The Item Has Been Processed In The Country Of Destination': 'in_transit',
      'Customs Agent: Ready For Pickup': 'customs',
      'Arrived at destination country': 'in_transit',
      'The Shipping Label Has Been Created': 'registered',
    });
    expect(result.events!.find((event) => event.description === 'Arrived at destination country')!.location).toBe('Toronto Pearson, CA');
    // Two rows on one wall clock keep the reply's order.
    expect(result.events!.slice(2, 4).map((event) => event.provider_code)).toEqual(['30', '32']);
  });

  it('passes a routing barcode’s package identifier on, and nothing when it is unclear', () => {
    const routed = (partner: unknown) => parseDealerSend(edited('delivered-usps.json', USPS_PARCEL, (shipment) => {
      shipment.externalTrackingNumbers = partner;
    }), USPS_PARCEL, READ_AT);
    expect(routed({ 0: `42000000${USPS_NUMBER}` })).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: USPS_NUMBER });
    expect(routed([USPS_NUMBER])).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: USPS_NUMBER });
    const unclear = routed({ 0: `42000000${USPS_NUMBER.slice(0, -1)}0` });
    expect(unclear.delivery_carrier).toBeUndefined();
    expect(unclear.delivery_tracking_number).toBeUndefined();
    // No number, the parcel's own, or two partner numbers give no hand-off.
    for (const partner of [null, {}, { 0: USPS_PARCEL }, { 0: USPS_NUMBER, 1: GOFO_NUMBER }]) {
      const result = routed(partner);
      expect(result.delivery_carrier, JSON.stringify(partner)).toBeUndefined();
      expect(result.delivery_tracking_number, JSON.stringify(partner)).toBeUndefined();
    }
    expect(() => routed('9261290000000000000007')).toThrow('invalid partner numbers');
  });

  it('lists a row once per clock and wording, newest wall clock first, and drops rows without a clock', () => {
    const result = parseDealerSend(edited('in-transit-canada.json', CANADA_PARCEL, (shipment) => {
      const rows = shipment.trackingEvents!;
      shipment.trackingEvents = [rows.at(-1)!, ...rows, rows[0]!, row('', '32', 'The Item Is At The Local Sorting Centre'),
        row('2026-06-16T08:00:00.123', '32', 'The Item Is At The Local Sorting Centre', 'CA', '1 SAMPLE ROAD, SAMPLETOWN, ON A0A 0A0')];
    }), CANADA_PARCEL, READ_AT);
    expect(result.events!.map((event) => event.local_time)).toEqual([
      '2026-06-16T11:51:00', '2026-06-16T09:16:00', '2026-06-16T08:00:00', '2026-06-12T09:14:00', '2026-06-12T09:14:00',
      '2026-06-11T15:03:00', '2026-06-10T10:23:00', '2026-06-09T17:25:00', '2026-06-09T16:12:00', '2026-06-09T02:13:00',
      '2026-06-06T16:59:00', '2026-06-06T15:09:19', '2026-06-06T13:59:22', '2026-06-05T03:06:00', '2026-06-04T11:30:26',
    ]);
    expect(result.events![2]!.location).toBe('SAMPLETOWN, ON, CA');
  });

  it('holds back rows dated ahead of the read, and names them when nothing else is left', () => {
    // The flight's departure, read on the earliest clock on Earth, is still ahead of this read.
    const early = Date.parse('2026-06-08T20:00:00Z');
    const result = parseDealerSend(reply('in-transit-canada.json'), CANADA_PARCEL, early);
    expect(result).toMatchObject({ last_status_text: 'Item is ready for departure.', last_update_local: '2026-06-09T02:13:00' });
    expect(result.written_ahead).toContain('2026-06-16T11:51:00');
    let error: unknown;
    try {
      parseDealerSend(reply('in-transit-canada.json'), CANADA_PARCEL, Date.parse('2026-06-01T00:00:00Z'));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NoHistoryError);
    expect(error).toMatchObject({ kind: 'indeterminate', reason: 'written_ahead' });
    expect((error as NoHistoryError).writtenAhead).toContain('2026-06-16T11:51:00');
  });

  it('reads the tracker’s null answer as not found', async () => {
    const fetcher = replying(() => json(text('not-found.json')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a moved route, a refusal, a browser check, a rate limit and an outage apart from a missing parcel', async () => {
    const page = '<html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div></body></html>';
    const cases: [() => Response, string][] = [
      [() => new Response('<html><title>Track My Shipment</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } }), 'transport'],
      [() => new Response('', { status: 410 }), 'transport'],
      [() => new Response('', { status: 308, headers: { Location: 'https://dealer-send.com/en-US/' } }), 'transport'],
      [() => new Response('', { status: 403 }), 'challenge'],
      [() => new Response(page, { status: 503, headers: { 'Content-Type': 'text/html' } }), 'challenge'],
      [() => new Response('<html><body>Service Unavailable</body></html>', { status: 503 }), 'maintenance'],
      [() => new Response(page, { headers: { 'Content-Type': 'text/html' } }), 'challenge'],
      [() => new Response('<!doctype html><html><body><div id="app"></div></body></html>', { headers: { 'Content-Type': 'text/html' } }), 'schema'],
      [() => json('[]'), 'schema'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(response)).track({ number: USPS_PARCEL }), kind).rejects.toMatchObject({ kind });
    }
    await expect(carrier(replying(() => new Response('', { status: 429, headers: { 'Retry-After': '42' } })))
      .track({ number: USPS_PARCEL })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 42_000 });
  });

  it('leaves an answer for another parcel, an empty history and a changed reply open or failed, never found', () => {
    const usps = reply('delivered-usps.json');
    expect(() => parseDealerSend(usps, GOFO_PARCEL, READ_AT)).toThrow('another parcel');
    expect(() => parseDealerSend({ ...usps, [UNKNOWN]: null }, USPS_PARCEL, READ_AT)).toThrow('another parcel');
    expect(() => parseDealerSend({ [UNKNOWN]: null }, USPS_PARCEL, READ_AT)).toThrow('another parcel');
    expect(() => parseDealerSend({ [USPS_PARCEL]: usps[USPS_PARCEL] }, USPS_PARCEL.replace('1YQ', '2YQ'), READ_AT)).toThrow('another parcel');
    expect(() => parseDealerSend(edited('delivered-usps.json', USPS_PARCEL, (shipment) => { shipment.trackingNumber = GOFO_PARCEL; }), USPS_PARCEL, READ_AT))
      .toThrow('another parcel');
    expect(() => parseDealerSend(edited('delivered-usps.json', USPS_PARCEL, (shipment) => { shipment.trackingEvents = null; }), USPS_PARCEL, READ_AT))
      .toThrow(NoHistoryError);
    expect(() => parseDealerSend(edited('delivered-usps.json', USPS_PARCEL, (shipment) => { shipment.trackingEvents = []; }), USPS_PARCEL, READ_AT))
      .toThrow(NoHistoryError);
    expect(() => parseDealerSend(edited('delivered-usps.json', USPS_PARCEL, (shipment) => { shipment.trackingEvents![0]!.localTime = '2026-04-14 18:11'; }),
      USPS_PARCEL, READ_AT)).toThrow('invalid scan time');
    expect(() => parseDealerSend(edited('delivered-usps.json', USPS_PARCEL, (shipment) => { shipment.trackingEvents![0]!.localTime = '2026-04-14T24:00:00'; }),
      USPS_PARCEL, READ_AT)).toThrow('invalid scan time');
    expect(() => parseDealerSend(edited('delivered-usps.json', USPS_PARCEL, (shipment) => { shipment.trackingEvents = {} as never; }), USPS_PARCEL, READ_AT))
      .toThrow('invalid history');
    expect(() => parseDealerSend(edited('delivered-usps.json', USPS_PARCEL, (shipment) => {
      shipment.trackingEvents = Array.from({ length: 501 }, () => shipment.trackingEvents![0]!);
    }), USPS_PARCEL, READ_AT)).toThrow('oversized history');
    expect(() => parseDealerSend({ [USPS_PARCEL]: 'found' }, USPS_PARCEL, READ_AT)).toThrow('invalid shipment');
  });

  it('reads a link to the tracking page', () => {
    for (const link of [`https://dealer-send.com/en-US/track-my-shipment?trackingNumber=${USPS_PARCEL}`,
      `https://www.dealer-send.com/zh-HK/track-my-shipment?trackingNumber=${USPS_PARCEL}`,
      `https://dealer-send.com/track-my-shipment?trackingNumber=${USPS_PARCEL}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: USPS_PARCEL, carrier: 'dealersend' });
    }
  });

  it('takes the names others give the carrier', () => {
    for (const name of ['DealerSend', 'Dealer Send', 'DEALER SEND', 'Dealer Send Logistics', 'Dealer Send Logistics Limited']) {
      expect(carrierIdFromName(name), name).toBe('dealersend');
    }
  });
});

describe('DealerSend status map', () => {
  it('stages every recorded status, its own by GUID and the partners’ by wording, and the app reads it', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, entry.wording), entry.wording).toBe(entry.stage);
    expect(statusMap.gaps).toEqual([]);
    const own = statuses.entries.filter((entry) => entry.code.includes('-'));
    expect(new Set(own.map((entry) => entry.code)).size).toBe(own.length);
    expect(statusMapAnswer({ carrier: 'dealersend', providerCode: '37', description: 'The Item Has Been Delivered Successfully' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    // A partner's code says nothing alone: 30 is processing in Canada and a delivery round in the United States.
    expect(statusMapAnswer({ carrier: 'dealersend', providerCode: '30', description: 'Out For Delivery' })).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'dealersend', providerCode: '30', description: 'The Item Has Been Processed In The Country Of Destination' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });

  it('reads DealerSend’s arrival at its origin facility as the acceptance, and a partner’s as transit', () => {
    expect(dealerSendStage('303fd7c9-ff3b-4f3a-b4e3-e76654052ed5', 'Arrived at origin facility')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(dealerSendStage('22', 'Arrived At Origin Facility')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // Without its code, as a provider relays it, the later reading stands; DealerSend's other words still read as its own.
    expect(dealerSendStage(null, 'Arrived at origin facility')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(dealerSendStage(null, 'Item depart from origin.')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // A partner's acceptance wording no one recorded is the journey going on; an unknown GUID row keeps the shared rules.
    expect(dealerSendStage('21', 'Accepted By Synthetic Partner')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(dealerSendStage('00000000-0000-4000-8000-000000000000', 'Synthetic wording without a stage')).toBeNull();
  });
});
