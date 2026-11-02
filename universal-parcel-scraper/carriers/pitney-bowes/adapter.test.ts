import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PITNEY_BOWES_API, PITNEY_BOWES_BRAND, PitneyBowesTracker } from './adapter.js';
import { normalizePitneyBowesNumber, parsePitneyBowes } from './parser.js';
import { pitneyBowesStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'UPAAZ000000000000001';
const IN_TRANSIT = 'UPBE00000000000000A1';
const UNKNOWN = 'PBXZZ000000000';

type Row = Record<string, unknown>;
type Reply = Row & { trackingEventsModule: Row & { trackingEvents: Row[] }; shippingInfoModule: Row };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const scan = (description: string, date: string, hour: string, location: string | null = null) =>
  ({ description, location, date, hour, longDate: '', shortDate: '', dayOfWeek: '', hasLongEventInfo: false });
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pitney Bowes HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number in capitals, with its brand, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PitneyBowesTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' upbe 0000-0000-0000-00a1 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PITNEY_BOWES_API}${IN_TRANSIT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'X-BRAND-ID': PITNEY_BOWES_BRAND, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pitney-bowes', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and place, and stages it by its wording', () => {
    const result = parsePitneyBowes(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Customs Clearance', last_update: null, last_update_local: '2026-06-02T12:10:00', expected_delivery: null,
      service_name: 'Pitney Bowes Expedited Parcel Service', weight_kg: 0.085 });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage ?? null, event.location ?? null])).toEqual([
      // An import declaration's country is paperwork, not the parcel's place.
      ['2026-06-02T12:10:00', 'Customs Clearance', 'customs', null],
      ['2026-05-30T16:29:00', 'Interpost handed item over to postal company', 'in_transit', null],
      ['2026-05-30T11:03:00', 'Shipped from Global Shipping Center to Destination', 'in_transit', 'Sample Hub, Sampleshire, GB'],
      ['2026-05-29T11:05:00', 'Parcel Documentation and Labeling', 'in_transit', 'Sample Hub, Sampleshire, GB'],
      ['2026-05-29T11:04:00', 'Processing at Shipping Center', 'in_transit', 'Sample Hub, Sampleshire, GB'],
      ['2026-05-29T10:04:00', 'In Transit', 'in_transit', null],
      ['2026-05-27T12:00:00', 'Tracking details uploaded', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events!.filter((event) => event.time === undefined)).toHaveLength(5);
  });

  it('reads the platform’s unplaced scans at the hub’s processing on their own clocks, each at the instant of the hub’s scan', () => {
    const at = (result: ReturnType<typeof parsePitneyBowes>, description: string) => result.events!.filter((event) => event.description === description)
      .map((event) => [event.local_time, event.time ?? null, event.time_zone ?? null, event.time_zone_basis ?? null]);
    const delivered = parsePitneyBowes(fixture('delivered'), DELIVERED);
    // The hub's processing at 08:57 in British summer time is 07:57 UTC.
    expect(at(delivered, 'In Transit')).toEqual([['2026-05-11T07:57:00', '2026-05-11T07:57:00Z', 'UTC', 'carrier']]);
    expect(at(delivered, 'Item processed at Interpost')).toEqual([['2026-05-11T07:58:00', '2026-05-11T07:58:00Z', 'UTC', 'carrier']]);
    expect(at(delivered, 'Interpost handed item over to postal company'))
      .toEqual([['2026-05-11T09:58:00', '2026-05-11T09:58:00+02:00', 'Etc/GMT-2', 'carrier']]);
    // In winter the hand-over is still two hours after Interpost's processing: on Central European time it came an hour after the hub's scan.
    const winter = parsePitneyBowes(changed('delivered', (body) => {
      body.trackingEventsModule.trackingEvents = [
        scan('Interpost handed item over to postal company', 'Jan 6, 2026', '03:14 PM'),
        scan('Processing at Shipping Center', 'Jan 6, 2026', '01:14 PM', 'Sample Hub, Sampleshire, GB'),
        scan('Item processed at Interpost', 'Jan 6, 2026', '01:14 PM'),
        scan('In Transit', 'Jan 6, 2026', '01:13 PM'),
      ];
    }), DELIVERED);
    expect(winter.events!.map((event) => [event.description, event.time && new Date(event.time).toISOString()])).toEqual([
      ['Interpost handed item over to postal company', '2026-01-06T13:14:00.000Z'],
      ['Processing at Shipping Center', undefined],
      ['Item processed at Interpost', '2026-01-06T13:14:00.000Z'],
      ['In Transit', '2026-01-06T13:13:00.000Z'],
    ]);
    // Other unplaced scans, and those wordings with a place, keep their wall clock alone.
    expect(at(delivered, 'Tracking details uploaded')).toEqual([['2026-05-06T17:53:00', null, null, null]]);
    const placed = parsePitneyBowes(changed('in-transit', (body) => {
      body.trackingEventsModule.trackingEvents.find((row) => row.description === 'In Transit')!.location = 'Sample City, ZZ';
    }), IN_TRANSIT);
    expect(at(placed, 'In Transit')).toEqual([['2026-05-29T10:04:00', null, null, null]]);
  });

  it('keeps the delivery without the partner’s links, repeated scans or placeholder regions', () => {
    const result = parsePitneyBowes(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Item has been delivered', last_update_local: '2026-05-21T14:48:00', weight_kg: 0.624 });
    expect(result.events).toHaveLength(19);
    // The partner's scan relayed with and without its place is kept once, with it.
    expect(result.events!.filter((event) => /processed at location/i.test(event.description!))).toEqual([
      { local_time: '2026-05-14T20:41:00', location: 'Sample City, ZZ', description: 'Processed at Location', stage: 'in_transit', stage_source: 'wording:language' },
    ]);
    expect(result.events!.filter((event) => event.description === 'Processing at Shipping Center')).toHaveLength(1);
    // The onward carrier opening its record moves nothing.
    expect(result.events!.find((event) => event.description === 'Package is created in the system')).not.toHaveProperty('stage');
    expect(JSON.stringify(result)).not.toMatch(/partner\.example|SMPLREF|SampleKey|PBI|XX/);
  });

  it('drops a partner’s scan relayed again in capitals on a clock whole hours away, and keeps a scan with no placed twin', () => {
    const result = parsePitneyBowes(changed('in-transit', (body) => {
      body.trackingEventsModule.trackingEvents.unshift(
        scan('DEPART FACILITY', 'Jun 3, 2026', '03:43\u00a0AM'),
        scan('Processed at Location', 'Jun 2, 2026', '08:41\u00a0PM', 'Sample City, XX, ZZ'),
        scan('On Hold', 'Jun 2, 2026', '08:23\u00a0PM', 'Sample City, XX, ZZ'),
        scan('PROCESSED AT LOCATION', 'Jun 2, 2026', '07:41\u00a0PM'),
        scan('ON HOLD', 'Jun 2, 2026', '07:23\u00a0PM'),
        // Twenty minutes away, or an hour away without capitals, is another scan.
        scan('ON HOLD', 'Jun 2, 2026', '07:43\u00a0PM'),
        scan('Arrived Facility', 'Jun 2, 2026', '06:14\u00a0PM', 'Sample City, XX, ZZ'),
        scan('Arrived Facility', 'Jun 2, 2026', '05:14\u00a0PM'),
      );
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 7).map((event) => [event.local_time, event.description, event.location ?? null])).toEqual([
      ['2026-06-03T03:43:00', 'DEPART FACILITY', null],
      ['2026-06-02T20:41:00', 'Processed at Location', 'Sample City, ZZ'],
      ['2026-06-02T20:23:00', 'On Hold', 'Sample City, ZZ'],
      ['2026-06-02T19:43:00', 'ON HOLD', null],
      ['2026-06-02T18:14:00', 'Arrived Facility', 'Sample City, ZZ'],
      ['2026-06-02T17:14:00', 'Arrived Facility', null],
      ['2026-06-02T12:10:00', 'Customs Clearance', null],
    ]);
    expect(result).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'wording:language', last_status_text: 'DEPART FACILITY' });
  });

  it('shows Interpost’s clearance status in words with its code, and keeps no place for its import declaration', () => {
    const result = parsePitneyBowes(changed('in-transit', (body) => {
      body.trackingEventsModule.trackingEvents[0]!.location = 'IT';
      body.trackingEventsModule.trackingEvents.unshift(
        scan('B2C ClearanceStatus4', 'Jun 3, 2026', '12:42\u00a0PM', 'NL'),
        scan('B2C ClearanceStatus2', 'Jun 3, 2026', '09:15\u00a0AM', 'NL'),
      );
    }), IN_TRANSIT);
    expect(result.events!.slice(0, 3)).toEqual([
      { local_time: '2026-06-03T12:42:00', location: 'NL', description: 'Customs import cleared', provider_code: 'B2C ClearanceStatus4',
        stage: 'in_transit', stage_source: 'carrier_map' },
      // A status number Interpost's tracker does not caption is a customs step.
      { local_time: '2026-06-03T09:15:00', location: 'NL', description: 'Customs clearance update', provider_code: 'B2C ClearanceStatus2',
        stage: 'customs', stage_source: 'wording:language' },
      // The declaration names the country it is lodged in, which still tells its clock.
      { local_time: '2026-06-02T12:10:00', time: '2026-06-02T12:10:00+02:00', time_zone: 'Europe/Rome', time_zone_basis: 'place',
        description: 'Customs Clearance', stage: 'customs', stage_source: 'carrier_map' },
    ]);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Customs import cleared', last_update: null });
    const declared = parsePitneyBowes(changed('in-transit', (body) => { body.trackingEventsModule.trackingEvents[0]!.location = 'IT'; }), IN_TRANSIT);
    expect(declared).toMatchObject({ last_update: '2026-06-02T12:10:00+02:00', last_update_local: '2026-06-02T12:10:00' });
    // A declaration placed in a town, and another scan naming only a country, keep their place.
    const placed = parsePitneyBowes(changed('in-transit', (body) => {
      body.trackingEventsModule.trackingEvents[0]!.location = 'Sample City, ZZ';
      body.trackingEventsModule.trackingEvents.unshift(scan('Arrived Facility', 'Jun 3, 2026', '08:00\u00a0AM', 'ZZ'));
    }), IN_TRANSIT);
    expect(placed.events!.slice(0, 2).map((event) => event.location)).toEqual(['ZZ', 'Sample City, ZZ']);
  });

  it('takes the summary’s word for a delivery, and its other statuses only for scans without a stage', () => {
    const delivered = parsePitneyBowes(changed('in-transit', (body) => { body.trackingPackageStatus = 'Delivered'; }), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Customs Clearance' });
    // A summary has called a parcel its addressee collected a delivery problem.
    const collected = parsePitneyBowes(changed('delivered', (body) => {
      body.trackingPackageStatus = 'DeliveryException';
      body.trackingEventsModule.trackingEvents[0]!.description = 'Delivered by Consignee Pickup';
    }), DELIVERED);
    expect(collected).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map' });
    const unstaged = parsePitneyBowes(changed('in-transit', (body) => {
      body.trackingEventsModule.trackingEvents = [{ ...body.trackingEventsModule.trackingEvents[0]!, description: 'Package is created in the system' }];
      body.trackingPackageStatus = 'OutForDelivery';
    }), IN_TRANSIT);
    expect(unstaged).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    const fallback = parsePitneyBowes(changed('in-transit', (body) => {
      body.trackingEventsModule.trackingEvents = [{ ...body.trackingEventsModule.trackingEvents[0]!, description: 'Package is created in the system' }];
      body.trackingPackageStatus = 'Fallback';
    }), IN_TRANSIT);
    expect(fallback).toMatchObject({ status: 'unknown', last_status_text: 'Package is created in the system' });
    expect(fallback).not.toHaveProperty('current_stage');
  });

  it('reads a history listed oldest first newest first, and the weight only as pounds and ounces', () => {
    const result = parsePitneyBowes(changed('in-transit', (body) => {
      body.trackingEventsModule.trackingEvents.reverse();
      body.shippingInfoModule.packageWeight = '16 lbs. 14 oz.';
    }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update_local: '2026-06-02T12:10:00', current_stage: 'customs', weight_kg: 7.654 });
    expect(result.events!.at(-1)).toMatchObject({ description: 'Tracking details uploaded' });
    for (const weight of ['2 kg', '0 oz.', '', null]) {
      expect(parsePitneyBowes(changed('in-transit', (body) => { body.shippingInfoModule.packageWeight = weight; }), IN_TRANSIT))
        .not.toHaveProperty('weight_kg');
    }
    expect(parsePitneyBowes(changed('in-transit', (body) => { body.shippingInfoModule.packageWeight = '2 lbs.'; }), IN_TRANSIT))
      .toMatchObject({ weight_kg: 0.907 });
  });

  it('keeps scans of one instant in the carrier’s order', () => {
    const hub = 'Sample Hub, Sampleshire, GB';
    const result = parsePitneyBowes(changed('in-transit', (body) => {
      body.trackingEventsModule.trackingEvents = [scan('Processing at Shipping Center', 'May 29, 2026', '09:00 AM', hub),
        scan('Parcel Documentation and Labeling', 'May 29, 2026', '10:00 AM', hub),
        scan('Shipped from Global Shipping Center to Destination', 'May 29, 2026', '10:00 AM', hub)];
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.description))
      .toEqual(['Shipped from Global Shipping Center to Destination', 'Parcel Documentation and Labeling', 'Processing at Shipping Center']);
  });

  it('reads the platform’s failure, which it gives for unknown numbers too, as inconclusive and only its own not-found as not found', () => {
    expect(() => parsePitneyBowes(fixture('unknown'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePitneyBowes(changed('unknown', (body) => { body.trackingPackageStatus = 'Timeout'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePitneyBowes(changed('unknown', (body) => { body.trackingPackageStatus = 'NotFound'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePitneyBowes(changed('unknown', (body) => {
      body.trackingPackageStatus = 'Unknown';
      body.trackingPackageNotFound = true;
    }), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePitneyBowes(changed('unknown', (body) => { body.trackingPackageStatus = 'Preparing'; }), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a reply only when it names the number asked', () => {
    expect(() => parsePitneyBowes(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Pitney Bowes answered for another shipment' }));
    expect(() => parsePitneyBowes(changed('in-transit', (body) => { body.shippingInfoModule.trackingNumber = DELIVERED; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parsePitneyBowes(changed('in-transit', (body) => { body.trackingNumber = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events)
      .toHaveLength(7);
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { delete body.trackingNumber; },
      (body: Reply) => { body.trackingNumber = 7; },
      (body: Reply) => { delete body.trackingPackageStatus; },
      (body: Reply) => { body.trackingPackageStatus = { status: 'InTransit' }; },
      (body: Reply) => { body.shippingInfoModule = 'shipping' as never; },
      (body: Reply) => { delete (body as Row).trackingEventsModule; },
      (body: Reply) => { body.trackingEventsModule.trackingEvents = 'scans' as never; },
      (body: Reply) => { body.trackingEventsModule.trackingEvents = Array.from({ length: 501 }, () => body.trackingEventsModule.trackingEvents[0]!); },
      (body: Reply) => { body.trackingEventsModule.trackingEvents[0] = 'scan' as never; },
      (body: Reply) => { body.trackingEventsModule.trackingEvents[0]!.description = ''; },
      (body: Reply) => { body.trackingEventsModule.trackingEvents[0]!.description = ['Customs Clearance']; },
      (body: Reply) => { body.trackingEventsModule.trackingEvents[0]!.date = '2026-06-02'; },
      (body: Reply) => { body.trackingEventsModule.trackingEvents[0]!.date = 'Feb 30, 2026'; },
      (body: Reply) => { body.trackingEventsModule.trackingEvents[0]!.hour = '13:10 PM'; },
      (body: Reply) => { body.trackingEventsModule.trackingEvents[0]!.hour = '12:10'; },
      (body: Reply) => { delete body.trackingEventsModule.trackingEvents[0]!.hour; },
      (body: Reply) => { body.trackingEventsModule.trackingEvents[0]!.location = 7; },
    ]) {
      expect(() => parsePitneyBowes(changed('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps a moved route, a refused lookup, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(fixture('unknown'))).rejects.toMatchObject({ kind: 'indeterminate' });
    // The platform no longer knowing the tracker's brand, or a moved route.
    await expect(lookup({ error: { status: 404, error: 'Unable to find customization', message: 'Can not show customized tracking page' } }, { status: 404 }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://trackpb.shipment.co/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup({ error: { status: 400, error: 'Missing required', message: 'X-BRAND-ID is missing in request header' } }, { status: 400 }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt = {}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 400, headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>PB Tracking</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s without a second request', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('tries once more when the request does not reach the tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 3000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Pitney Bowes does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['UPAA0000000000000000', 'UPBE000000000000000G', 'PBXZZ00000000', '9400100000000000000000', `UPAAZ${'0'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePitneyBowesNumber('pbx-zz 0000 0000 0')).toBe(UNKNOWN);
  });

  it('routes a number filed under Pitney Bowes, or detected as one of its numbers, to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'pitney-bowes' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pitney-bowes', source: 'pitney-bowes', result: { current_stage: 'delivered' } });
    await expect(tracker.track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pitney-bowes', source: 'pitney-bowes' });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${PITNEY_BOWES_API}${DELIVERED}`)).toBe(true);
  });
});

describe('Pitney Bowes numbers', () => {
  it('takes every public sample and the shapes its detection claims', () => {
    for (const { number } of numbers.records) {
      expect(normalizePitneyBowesNumber(number), number).toBe(number);
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'pitney-bowes', confidence: 'high' });
    }
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'pitney-bowes', confidence: 'high' });
    }
  });
});

describe('Pitney Bowes status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      if (entry.unmapped) {
        expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(pitneyBowesStage(entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'pitney-bowes', description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(pitneyBowesStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'pitney-bowes', description: 'Customs Documentation and Labeling' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'pitney-bowes', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // Interpost's import clearance: status 4 is cleared, in words or stored as its code; another status number stays customs by the shared rules.
    expect(statusMapAnswer({ carrier: 'pitney-bowes', description: 'B2C ClearanceStatus4' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'pitney-bowes', providerCode: 'B2C ClearanceStatus4', description: 'Customs import cleared' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(pitneyBowesStage('B2C ClearanceStatus1')).toEqual({ stage: 'customs', source: 'wording:language' });
    // Wording the map does not know, relayed from a partner, falls to the shared rules.
    expect(pitneyBowesStage('Depart Facility')).toEqual({ stage: 'in_transit', source: 'wording:language' });
    expect(pitneyBowesStage('Synthetic note')).toBeNull();
  });
});
