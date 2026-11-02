// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrapeUniversalPage } from '../../core/transport/browser.js';
import { TrawlClient } from '../../core/transport/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, parsePostalNinjaResponse, PostalNinjaTracker } from './adapter.js';

vi.mock('../../core/transport/browser', () => ({ scrapeUniversalPage: vi.fn() }));

const number = 'ZZ12345678900';
interface Found { status: string; hid: string; track: { hid: string; tc: string; state: string; events: unknown[] } }
const found = JSON.parse(readFileSync(new URL('./fixtures/found.json', import.meta.url), 'utf8')) as Found;
const withEvents = (events: unknown[]): Found => ({ ...found, track: { ...found.track, events } });

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('Postal Ninja result parsing', () => {
  it('preserves chronology without inventing time zones or exposing recipient details', () => {
    const parsed = parsePostalNinjaResponse(found, number);
    expect(parsed).toMatchObject({ status: 'delivered', current_stage: 'delivered', tracking_provider: 'Postal Ninja' });
    // Wall-clock scans never fabricate a UTC instant, so the summary has no last_update.
    expect(parsed.last_update).toBeNull();
    expect(parsed.events?.[0]).toEqual({ local_time: '2026-08-17T11:17:00', description: 'Delivered', stage: 'delivered', stage_source: 'wording:provider' });
    expect(parsed.events?.[1]).toEqual({ local_time: '2026-08-17T07:22:00', description: 'Out for delivery', stage: 'out_for_delivery', stage_source: 'wording:provider' });
    // An explicit offset can be persisted as a real instant.
    expect(parsed.events?.[2]).toMatchObject({ time: '2026-08-16T04:00:00.000Z', stage: 'in_transit' });
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
  });

  it('reads a CIS feed\'s warehouse steps and leaves out its data updates', () => {
    const parsed = parsePostalNinjaResponse(withEvents([
      { ds: 'Example', dt: '2026-08-12T08:00:00', dsc: 'Registered in the system' },
      { ds: 'Example', dt: '2026-08-12T10:00:00', dsc: 'Shipment parameters updated' },
      { ds: 'Example', dt: '2026-08-14T09:00:00', dsc: 'Inventory in a warehouse' },
    ]), number);
    expect(parsed.events?.map(({ description, stage }) => [description, stage])).toEqual([
      ['Inventory in a warehouse', 'in_transit'], ['Registered in the system', 'registered'],
    ]);
  });

  it('names the services that reported the scans as carrier hints', () => {
    // A catalog carrier no detection rule claims the number for is still the hint (Raben's fifteen digits).
    const freight = '990000000000001';
    expect(parsePostalNinjaResponse({ ...found, track: { ...found.track, tc: freight, events: [
      { ds: 'Raben', dt: '2026-08-12T08:00:00', dsc: 'Registered in the system' },
      { ds: 'Raben', dt: '2026-08-14T09:00:00', dsc: 'Inventory in a warehouse' },
    ] } }, freight)).toMatchObject({ reported_carriers: ['Raben'], discovered_carrier: 'raben' });
    expect(parsePostalNinjaResponse(found, number)).toMatchObject({ reported_carriers: ['DPD'] });
    // A name outside the catalog may be the number's owner, so it leaves no hint.
    const other = parsePostalNinjaResponse(withEvents([{ ds: 'Example Unlisted Courier', dt: '2026-08-12T08:00:00', dsc: 'Collected' }]), number);
    expect(other.reported_carriers).toEqual(['Example Unlisted Courier']);
    expect(other.discovered_carrier).toBeUndefined();
  });

  const times = (parsed: { events?: { time?: string | null; local_time?: string | null }[] }) =>
    parsed.events?.map((scan) => scan.time ?? `local ${scan.local_time}`);
  const postal = (tc: string, destCn: string | undefined, events: unknown[]) =>
    ({ ...found, track: { ...found.track, tc, ...(destCn ? { destCn } : {}), events } });

  it('reads a service that Postal Ninja keeps on one clock in that clock, whatever the carrier\'s zone', () => {
    // Austrian Post's, Poste Italiane's and Raben's scans are UTC, not Vienna, Rome or Warsaw time.
    for (const [ds, zone] of [['Austrian Post', 'Europe/Vienna'], ['Poste Italiane', 'Europe/Rome'], ['Raben', 'Europe/Warsaw']]) {
      const scans = [{ ds, dt: '2026-08-17T07:22:00', dsc: 'Out for delivery' }, { ds, dt: '2026-08-17T11:17:00', dsc: 'Delivered' }];
      expect(times(parsePostalNinjaResponse(withEvents(scans), number, zone))).toEqual(['2026-08-17T11:17:00.000Z', '2026-08-17T07:22:00.000Z']);
    }
    // GOFO's clock follows its network, named by the destination.
    const gofo = (destCn?: string) => postal(number, destCn, [{ ds: 'GOFO Express', dt: '2026-08-17T11:17:00', dsc: 'Delivered' }]);
    expect(parsePostalNinjaResponse(gofo('US'), number).last_update).toBe('2026-08-17T18:17:00.000Z');
    expect(parsePostalNinjaResponse(gofo('FR'), number).last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(gofo(), number).last_update).toBeNull();
  });

  it('reads the UTC suffix Postal Ninja writes on Russian Post\'s scans as no zone', () => {
    const domestic = '10000000000001';
    const scans = [
      { ds: 'Russian Post', dt: '2026-10-16T11:30:40Z', dsc: 'Done. Accepted at the post office' },
      { ds: 'Russian Post', dt: '2026-10-17T15:02:10Z', dsc: 'Arrived at the sorting center' },
    ];
    // The office's wall clock: a history Russian Post reports alone is read on its clock, Moscow's.
    expect(times(parsePostalNinjaResponse(postal(domestic, 'RU', scans), domestic)))
      .toEqual(['2026-10-17T12:02:10.000Z', '2026-10-16T08:30:40.000Z']);
    // Beside another service, with no carrier zone to borrow, it keeps its wall clock.
    const relayed = [{ ds: 'Example', dt: '2026-10-15T10:00:00Z', dsc: 'Order received' }, ...scans];
    expect(times(parsePostalNinjaResponse(postal(domestic, 'RU', relayed), domestic)))
      .toEqual(['local 2026-10-17T15:02:10', 'local 2026-10-16T11:30:40', '2026-10-15T10:00:00.000Z']);
  });

  it('places a fixed clock\'s scans beside other services\', which borrow the carrier\'s zone or keep their wall times', () => {
    // Swiss Post keeps Zurich time for its own scans, and the destination post's
    // clock for those it relays from it; the other services relay the same scans
    // at clocks of their own, unknown here.
    const item = 'RR123456785CH';
    const reply = postal(item, 'SV', [
      { ds: 'DHL Germany', dt: '2026-08-12T08:05:00', dsc: 'Posting/Collection' },
      { ds: 'Swiss Post', dt: '2026-08-12T10:05:00', dsc: 'Time at which your consignment was mailed' },
      { ds: 'Swiss Post', dt: '2026-08-16T15:30:00', dsc: 'Arrival in destination country' },
      { ds: 'Example Post', dt: '2026-08-16T21:30:00', dsc: 'Receive shipment at exchange office' },
    ]);
    const unplaced = parsePostalNinjaResponse(reply, item);
    expect(times(unplaced)).toEqual(['local 2026-08-16T21:30:00', '2026-08-16T21:30:00.000Z',
      '2026-08-12T08:05:00.000Z', 'local 2026-08-12T08:05:00']);
    // The newest scan has no instant, so an older one does not stand in for it.
    expect(unplaced.last_update).toBeNull();
    // With the carrier's zone, the others' scans borrow it: a guess, two hours
    // early for DHL Germany's here.
    expect(times(parsePostalNinjaResponse(reply, item, 'Europe/Zurich'))).toEqual(['2026-08-16T21:30:00.000Z', '2026-08-16T19:30:00.000Z',
      '2026-08-12T08:05:00.000Z', '2026-08-12T06:05:00.000Z']);
    // A destination on several clocks leaves Swiss Post's relays on Zurich time, the last guess.
    const delivered = (destCn: string) => parsePostalNinjaResponse(postal(item, destCn, [{ ds: 'Swiss Post', dt: '2026-08-17T11:17:00', dsc: 'Delivered' }]),
      item).last_update;
    expect([delivered('SV'), delivered('US')]).toEqual(['2026-08-17T17:17:00.000Z', '2026-08-17T09:17:00.000Z']);
  });

  it('reads Correos de El Salvador\'s scans in UTC, and its copies of the origin post\'s on that office\'s clock', () => {
    // As its own tracker dates them: UPU has the delivery round at 12:26 in El Salvador, -06:00,
    // and Swiss Post the departure from Geneva at 12:20 Zurich time.
    const item = 'RR123456785CH';
    const reply = postal(item, 'SV', [
      { ds: 'Correos de El Salvador', dt: '2026-09-03T12:20:00', dsc: 'Receive shipment at exchange office (departure)', loc: 'CHGVAC' },
      { ds: 'Swiss Post', dt: '2026-09-03T12:20:28', dsc: 'Forwarding abroad', loc: 'Example, 000000, Switzerland' },
      { ds: 'Swiss Post', dt: '2026-10-06T06:45:39', dsc: 'Enquiry initiated', loc: 'Switzerland' },
      { ds: 'Swiss Post', dt: '2026-10-08T12:26:00', dsc: 'Sorting - forwarding' },
      { ds: 'Correos de El Salvador', dt: '2026-10-08T18:26:18', dsc: 'Transfer shipment to delivery agent (inbound)', loc: 'SAN BENEDICT' },
    ]);
    expect(times(parsePostalNinjaResponse(reply, item, 'Europe/Zurich'))).toEqual(['2026-10-08T18:26:18.000Z',
      '2026-10-08T18:26:00.000Z', '2026-10-06T04:45:39.000Z', '2026-09-03T10:20:28.000Z', '2026-09-03T10:20:00.000Z']);
    // From an origin on several clocks a copy borrows the carrier's zone, a guess, not the post's UTC.
    const us = 'RR123456785US';
    expect(times(parsePostalNinjaResponse(postal(us, 'SV', [
      { ds: 'Correos de El Salvador', dt: '2026-09-03T12:20:00', dsc: 'Insert shipment into bag (output)', loc: 'USJFKA' },
      { ds: 'Correos de El Salvador', dt: '2026-09-24T21:30:17', dsc: 'Receive shipment at exchange office (entrance)' },
    ]), us, 'America/New_York'))).toEqual(['2026-09-24T21:30:17.000Z', '2026-09-03T16:20:00.000Z']);
  });

  it('reads DHL Germany\'s copies at a European office as its wall clock written in UTC on Berlin\'s clock', () => {
    // Royal Mail's own scans: leaving Belfast at 00:11 summer time, with customs in Milan at 00:01 and 23:06.
    const item = 'RR123456785GB';
    const reply = postal(item, 'IT', [
      { ds: 'DHL Germany', dt: '2026-10-05T22:11:00', dsc: 'Departure from outward office of exchange', loc: 'GBBELC' },
      { ds: 'DHL Germany', dt: '2026-10-12T22:01:00', dsc: 'Held by customs', loc: 'ITMILR' },
      { ds: 'DHL Germany', dt: '2026-10-14T21:06:00', dsc: 'Held by customs', loc: 'ITMILR' },
    ]);
    // Neither the carrier's zone nor its absence moves them.
    for (const zone of ['Europe/London', null]) {
      expect(times(parsePostalNinjaResponse(reply, item, zone))).toEqual(['2026-10-14T21:06:00.000Z',
        '2026-10-12T22:01:00.000Z', '2026-10-05T23:11:00.000Z']);
    }
    // An office outside Europe, or a copy that names none, is not placed this way.
    const abroad = postal(item, 'IT', [{ ds: 'DHL Germany', dt: '2026-10-05T22:11:00', dsc: 'Departure from outward office of exchange', loc: 'CNBJSA' }]);
    expect(times(parsePostalNinjaResponse(abroad, item))).toEqual(['local 2026-10-05T22:11:00']);
  });

  it('reads Cainiao\'s steps in China on China\'s clock, and lends it to none of its later scans', () => {
    // Cainiao's own feed dates these steps +08:00 at the same digits. On the Zurich
    // clock routing passes for a Swiss Post item they came six hours late.
    const item = 'LW123456785CH';
    const reply = postal(item, 'CH', [
      { ds: 'Cainiao', dt: '2026-08-05T16:46:11', dsc: 'Shipment information received electronically by the warehouse. Example text' },
      { ds: 'Cainiao', dt: '2026-08-05T23:37:10', dsc: 'Inbound processing in sorting center', loc: 'Example Town' },
      { ds: 'Cainiao', dt: '2026-08-06T16:39:00', dsc: 'Export customs clearance complete successfully' },
      { ds: 'Cainiao', dt: '2026-08-07T22:30:00', dsc: 'Leaving the origin country or region' },
      { ds: 'Cainiao', dt: '2026-08-08T05:07:00', dsc: 'Departed from the departure country or region' },
      // On either side's clock, as Cainiao's feed dates it: it borrows routing's zone, not China's.
      { ds: 'Cainiao', dt: '2026-08-08T15:09:00', dsc: 'Arrived at the linehaul office' },
      { ds: 'Swiss Post', dt: '2026-08-10T09:00:00', dsc: 'Sorting', loc: 'Example, 0000, Switzerland' },
    ]);
    expect(times(parsePostalNinjaResponse(reply, item, 'Europe/Zurich', 'swiss-post'))).toEqual([
      '2026-08-10T07:00:00.000Z', '2026-08-08T13:09:00.000Z', '2026-08-07T21:07:00.000Z', '2026-08-07T14:30:00.000Z',
      '2026-08-06T08:39:00.000Z', '2026-08-05T15:37:10.000Z', '2026-08-05T08:46:11.000Z',
    ]);
    // Without a zone from routing, the step in China keeps its clock and the later scan its wall time.
    expect(times(parsePostalNinjaResponse(postal(item, 'CH', reply.track.events.slice(4, 6)), item))).toEqual([
      'local 2026-08-08T15:09:00', '2026-08-07T21:07:00.000Z',
    ]);
  });

  it('orders scans by instant once every one has one', () => {
    // Postal Ninja orders wall times: 10:30 UTC sorts after 11:00 Zurich time.
    const parsed = parsePostalNinjaResponse(withEvents([
      { ds: 'Poste Italiane', dt: '2026-08-17T08:30:00', dsc: 'In transit' },
      { ds: 'Swiss Post', dt: '2026-08-17T11:00:00', dsc: 'Sorting' },
      { ds: 'Poste Italiane', dt: '2026-08-17T10:30:00', dsc: 'Delivered' },
    ]), number);
    expect(times(parsed)).toEqual(['2026-08-17T10:30:00.000Z', '2026-08-17T09:00:00.000Z', '2026-08-17T08:30:00.000Z']);
    expect(parsed).toMatchObject({ current_stage: 'delivered', last_update: '2026-08-17T10:30:00.000Z' });
  });

  it('reads a local clock only in a history its service reports alone within one country', () => {
    const scans = (ds: string) => [{ ds, dt: '2026-08-17T07:22:00', dsc: 'Out for delivery' }, { ds, dt: '2026-08-17T11:17:00', dsc: 'Delivered' }];
    // The service's own zone, else the destination's, else the carrier's.
    expect(times(parsePostalNinjaResponse(withEvents(scans('An Post Ireland')), number, 'Europe/Rome')))
      .toEqual(['2026-08-17T10:17:00.000Z', '2026-08-17T06:22:00.000Z']);
    expect(parsePostalNinjaResponse(postal(number, 'SE', scans('PostNord')), number).last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(withEvents(scans('DPD')), number, 'Europe/London').last_update).toBe('2026-08-17T10:17:00.000Z');
    // A carrier whose catalog zone is the UTC placeholder lends the clock of the
    // one country it serves to a local clock, never to a fixed one.
    expect(parsePostalNinjaResponse(withEvents(scans('DPD')), number, null, 'brt').last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(withEvents(scans('Poste Italiane')), number, null, 'brt').last_update).toBe('2026-08-17T11:17:00.000Z');
    expect(parsePostalNinjaResponse(withEvents(scans('DPD')), number, null, 'packeta').last_update).toBeNull();
    // A destination on another clock than the service's may be a parcel that
    // crossed a border, and a service whose clock is unknown has none: their
    // scans borrow the carrier's zone, else the one the service's name gives.
    expect(parsePostalNinjaResponse(postal(number, 'FR', scans('DPD UK')), number, 'Europe/Paris').last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(postal(number, 'FR', scans('DPD UK')), number).last_update).toBe('2026-08-17T10:17:00.000Z');
    expect(parsePostalNinjaResponse(withEvents(scans('Example Express')), number, 'Europe/Rome').last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(withEvents(scans('Example Express')), number).last_update).toBeNull();
  });

  it('reads a carrier on the clock of each scan\'s office by the state or province its location names', () => {
    const parsed = parsePostalNinjaResponse(withEvents([
      // No state, or no country to say IL is one: the office's clock is unknown,
      // and the scan borrows the zone of the nearest earlier one, else later one.
      { ds: 'UPS', dt: '2026-08-15T09:00:00', dsc: 'Shipper created a label', loc: 'United States' },
      { ds: 'UPS', dt: '2026-08-15T21:40:00', dsc: 'Arrived at Facility', loc: 'Mississauga, ON, L5T 2N7, Canada' },
      { ds: 'UPS', dt: '2026-08-16T08:05:00', dsc: 'Departed from Facility', loc: 'Atlanta, GA, United States' },
      { ds: 'UPS', dt: '2026-08-16T18:00:00', dsc: 'Departed from Facility', loc: 'Chicago, IL' },
      { ds: 'UPS', dt: '2026-08-17T11:17:00', dsc: 'Delivered', loc: 'TACOMA, WA, 12345, United States' },
    ]), number);
    expect(times(parsed)).toEqual(['2026-08-17T18:17:00.000Z', '2026-08-16T22:00:00.000Z', '2026-08-16T12:05:00.000Z',
      '2026-08-16T01:40:00.000Z', '2026-08-15T13:00:00.000Z']);
    expect(parsed.last_update).toBe('2026-08-17T18:17:00.000Z');
    // A pickup dated without a time is written as midnight, and UPS dates a scan
    // between midnight and 1 a.m. at 12:xx: no zone places either. A delivery
    // at 12:xx is read as afternoon.
    const memphis = (ds: string, dt: string, dsc: string) => ({ ds, dt, dsc, loc: 'MEMPHIS, TN, United States' });
    expect(times(parsePostalNinjaResponse(withEvents([
      memphis('FedEx', '2026-08-16T00:00:00', 'Picked up'),
      memphis('FedEx', '2026-08-16T12:25:00', 'Arrived at FedEx location'),
    ]), number, 'America/Chicago'))).toEqual(['2026-08-16T17:25:00.000Z', 'local 2026-08-16T00:00:00']);
    expect(times(parsePostalNinjaResponse(withEvents([
      memphis('UPS', '2026-08-16T12:25:00', 'Arrived at Facility'),
      memphis('UPS', '2026-08-16T13:25:00', 'Departed from Facility'),
      memphis('UPS', '2026-08-17T12:40:00', 'Delivered'),
    ]), number, 'America/Chicago'))).toEqual(['2026-08-17T17:40:00.000Z', '2026-08-16T18:25:00.000Z', 'local 2026-08-16T12:25:00']);
    // Beside another service, the office's clock is not read.
    expect(parsePostalNinjaResponse(withEvents([
      { ds: 'USPS', dt: '2026-08-17T10:00:00', dsc: 'Out for delivery', loc: 'ATLANTA, GA 30301' },
      { ds: 'UPS', dt: '2026-08-17T11:17:00', dsc: 'Delivered', loc: 'Atlanta, GA, United States' },
    ]), number).last_update).toBeNull();
  });

  it('reads local clocks beside other services, or for a postal item that crosses a border, only in the carrier\'s zone', () => {
    // DHL Germany repeats the origin post's scans at the origin's clock.
    const relayed = withEvents([
      { ds: 'Example Post', dt: '2026-08-12T20:05:00', dsc: 'Posting/Collection' },
      { ds: 'DHL Germany', dt: '2026-08-12T20:05:00', dsc: 'Posting/Collection' },
      { ds: 'An Post Ireland', dt: '2026-08-17T11:17:00', dsc: 'Delivered' },
    ]);
    const unplaced = parsePostalNinjaResponse(relayed, number);
    expect(unplaced.last_update).toBeNull();
    expect(unplaced.events?.every((scan) => scan.local_time && !scan.time)).toBe(true);
    expect(times(parsePostalNinjaResponse(relayed, number, 'Europe/Dublin'))).toEqual(['2026-08-17T10:17:00.000Z', '2026-08-12T19:05:00.000Z']);
    const item = 'RR123456785SE';
    const delivered = [{ ds: 'PostNord', dt: '2026-08-17T11:17:00', dsc: 'Delivered' }];
    expect(parsePostalNinjaResponse(postal(item, 'NO', delivered), item).last_update).toBeNull();
    expect(parsePostalNinjaResponse(postal(item, 'SE', delivered), item).last_update).toBe('2026-08-17T09:17:00.000Z');
  });

  it('leaves out pickup deadlines', () => {
    const reply = (deadline: string, lastFetch?: string) => ({ ...found, track: { ...found.track, destCn: 'NO', ...(lastFetch ? { lastFetch } : {}), events: [
      { ds: 'Posten Norge', dt: '2026-08-17T11:17:00', dsc: 'The parcel has arrived at the pickup point' },
      { ds: 'Posten Norge', dt: '2026-08-24T10:00:00', dsc: deadline },
    ] } });
    const descriptions = (parsed: ReturnType<typeof parsePostalNinjaResponse>) => parsed.events?.map((scan) => scan.description);
    const arrived = ['The parcel has arrived at the pickup point'];
    expect(descriptions(parsePostalNinjaResponse(reply('Last day for retrieval'), number))).toEqual(arrived);
    // Any row dated after Postal Ninja last read the carrier is one too.
    const parsed = parsePostalNinjaResponse(reply('Will be returned to the sender', '2026-08-17T12:00:00Z'), number);
    expect(descriptions(parsed)).toEqual(arrived);
    expect(parsed.last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(reply('Will be returned to the sender'), number).events).toHaveLength(2);
  });

  it('accepts the widget compact response without inventing missing history', () => {
    const track = { ...found.track, events: undefined };
    const parsed = parsePostalNinjaResponse({ ...found, track: {
      ...track,
      firstEv: { dt: '2026-08-01T10:00:00', dsc: 'Shipment information received' },
      lastEv: { dt: '2026-08-17T11:17:00', dsc: 'Delivered by Mailbox, PIN: PRIVATE' },
      toAddress: 'PRIVATE RECIPIENT',
    } }, number);
    expect(parsed).toMatchObject({ current_stage: 'delivered', last_update: null });
    expect(parsed.events).toEqual([
      { local_time: '2026-08-17T11:17:00', description: 'Delivered', stage: 'delivered', stage_source: 'wording:provider' },
      { local_time: '2026-08-01T10:00:00', description: 'Shipment information received', stage: 'registered', stage_source: 'wording:provider' },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
    // Two scans cannot show that one service reports the whole history: a local
    // clock's borrow the carrier's zone.
    const compact = (ds: string, zone: string | null) => parsePostalNinjaResponse({ ...found, track: { ...track,
      firstEv: { ds, dt: '2026-08-01T10:00:00', dsc: 'Accepted' }, lastEv: { ds, dt: '2026-08-17T11:17:00', dsc: 'Delivered' } } }, number, zone).last_update;
    expect(compact('DPD', null)).toBeNull();
    expect(compact('DPD', 'Europe/Rome')).toBe('2026-08-17T09:17:00.000Z');
    expect(compact('Swiss Post', null)).toBe('2026-08-17T09:17:00.000Z');
  });

  it('deduplicates a compact single scan and rejects malformed compact data', () => {
    const track = { ...found.track, events: undefined };
    const scan = { dt: '2026-08-17T11:17:00', dsc: 'In transit' };
    expect(parsePostalNinjaResponse({ ...found, track: { ...track, firstEv: scan, lastEv: scan } }, number).events).toHaveLength(1);
    for (const fields of [
      {}, { lastEv: 'invalid' }, { firstEv: scan, lastEv: { dt: 'invalid', dsc: 'Delivered' } },
      { events: null, firstEv: scan }, { events: [], lastEv: scan },
    ]) expect(() => parsePostalNinjaResponse({ ...found, track: { ...track, ...fields } }, number)).toThrow();
  });

  it('rejects challenges, wrong identities, empty history and malformed dates', () => {
    for (const payload of [
      { ...found, status: 'CHLNG_REQ' }, { ...found, hid: 'different' },
      { ...found, track: { ...found.track, tc: 'OTHER123' } },
      { ...found, track: { ...found.track, state: 'PRIVATE' } },
      withEvents([]), withEvents([null]),
      withEvents([{ dt: '2026-02-31T12:00:00', dsc: 'Delivered' }]),
      withEvents([{ dt: 'tomorrow', dsc: 'Delivered' }]),
      withEvents(Array(1001).fill({ dt: '2026-08-17T11:17:00', dsc: 'Delivered' })),
    ]) expect(() => parsePostalNinjaResponse(payload, number)).toThrow();
  });

  it('does not mark forecasts or carrier handoffs as final delivery', () => {
    for (const [description, stage] of [
      ['The package is being prepared by the sender and will be delivered to us soon', 'registered'],
      ['En route to DHL eCommerce distribution center or awaiting processing', 'registered'],
      ['En route', 'in_transit'], ['Delivered to local carrier', 'in_transit'],
    ]) expect(parsePostalNinjaResponse(withEvents([{ dt: '2026-08-17T11:17:00', dsc: description }]), number).current_stage).toBe(stage);
  });
});

describe('Postal Ninja TRAWL capture', () => {
  const get = 'https://postal.ninja/track/get';
  const check = 'https://postal.ninja/track/check';
  const url = `https://postal.ninja/en/tools#trawl-number=${number}`;
  const entry = (payload: unknown, endpoint = get, status = 200) => ({
    url: endpoint, status, body: JSON.stringify(payload), headers: { 'retry-after': '60' },
  });
  const captured = (entries: unknown[], overrides = {}) => new Response(JSON.stringify({
    url, html: '<html></html>', statusCode: 200, tier: 3, capturedResponses: entries, ...overrides,
  }));
  const setup = (response: Response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const trawl = new TrawlClient('http://browser.test', fetcher);
    return {fetcher, trawl, tracker: new PostalNinjaTracker({trawl})};
  };

  it('wires the shared browser service through the factory and requests both protocol endpoints', async () => {
    const {fetcher, trawl} = setup(captured([entry({status: 'PROCESSING', tc: number, hid: found.hid}, check), entry(found)]));
    const provider = adapter({trawl, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null});
    expect(provider.steps).toEqual(['trawl']);
    await expect(provider.track({number, postcode: null, timezone: 'Europe/Rome'}, {budgetMs: 30_000}))
      .resolves.toMatchObject({tracking_provider: 'Postal Ninja', current_stage: 'delivered', last_update: '2026-08-17T09:17:00.000Z'});
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({url, skipHttp: true, maxTier: 3, captureResponses: [get, check]});
    // The parcel's carrier reaches the parser too: BRT serves Italy alone.
    const brt = adapter({trawl: setup(captured([entry(found)])).trawl, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null});
    await expect(brt.track({number, postcode: null, timezone: null, carrier: 'brt'}, {budgetMs: 30_000}))
      .resolves.toMatchObject({last_update: '2026-08-17T09:17:00.000Z'});
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });

  it('skips unrelated and intermediate captures but preserves a matching challenge or no-info outcome', async () => {
    const noInfo = { ...found, track: { ...found.track, state: 'NO_INFO', events: [] } };
    for (const [entries, expected] of [
      [[entry({status: 'CHLNG_REQ', tc: number}, check)], {kind: 'challenge'}],
      [[entry({status: 'UNTRACEABLE', tc: number}, check)], {kind: 'indeterminate', name: 'NoHistoryError'}],
      [[entry({status: 'PROCESSING', tc: number, hid: found.hid}, check), entry({status: 'CHLNG_REQ', hid: found.hid})], {kind: 'challenge'}],
      [[entry({...noInfo, inProgress: true}), entry(noInfo)], {kind: 'indeterminate', name: 'NoHistoryError'}],
      [[entry(null, check, 429)], {status: 429, retryAfterMs: 60_000}],
    ] as const) {
      await expect(setup(captured([...entries])).tracker.fetch(number)).rejects.toMatchObject(expected);
    }
    const {tracker} = setup(captured([entry({status: 'CHLNG_REQ', tc: 'OTHER123'}, check), entry({...noInfo, inProgress: true}), entry(found)]));
    await expect(tracker.fetch(number)).resolves.toMatchObject({current_stage: 'delivered'});
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });

  it('rejects wrong identities, redirected pages and missing or unreadable captures', async () => {
    for (const response of [
      captured([entry({...found, track: {...found.track, tc: 'OTHER123'}})]),
      captured([entry(found)], {url: 'https://postal.ninja/en'}),
      captured([entry(found)], {url: 'https://postal.ninja/en/track#/another-handle'}),
      captured([entry(found)], {url: `https://other.test/en/track#/${found.hid}`}),
      captured([entry(found)], {tier: 1}),
      captured([], {capturedResponses: undefined}),
      captured([{...entry(found), body: null, error: 'unreadable'}]),
      captured([{...entry(found), truncated: true}]),
    ]) await expect(setup(response).tracker.fetch(number)).rejects.toThrow();
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });

  it('accepts the bound normal results page and selects full history over the widget summary', async () => {
    const compact = {...found, track: {...found.track, events: undefined, firstEv: found.track.events[0], lastEv: found.track.events.at(-1)}};
    const {tracker} = setup(captured([entry(compact), entry(found)], {url: `https://postal.ninja/en/track#/${found.hid}`}));
    const result = await tracker.fetch(number);
    expect(result.events).toEqual(parsePostalNinjaResponse(found, number).events);
    await expect(setup(captured([entry(compact)])).tracker.fetch(number)).rejects.toMatchObject({kind: 'indeterminate'});
  });
});

describe('Postal Ninja widget lookup', () => {
  it('submits the official embedded widget and reads its own tracking response', async () => {
    vi.mocked(scrapeUniversalPage).mockResolvedValueOnce({ events: [], status: 'delivered' });
    await expect(new PostalNinjaTracker({ executablePath: '/test/chromium' }).fetch(number)).resolves.toMatchObject({ status: 'delivered' });
    expect(scrapeUniversalPage).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: '/test/chromium', timeoutMs: expect.any(Number) }),
      expect.objectContaining({ name: 'Postal Ninja', url: 'https://postal.ninja/en/tools', responseUrl: 'https://postal.ninja/track/get' }),
      expect.any(Function),
    );
  });

  it('ends the widget lookup when the caller cancels', async () => {
    vi.mocked(scrapeUniversalPage).mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const lookup = new PostalNinjaTracker({ executablePath: '/test/chromium' }).fetch(number, undefined, null, controller.signal);
    await vi.waitFor(() => expect(scrapeUniversalPage).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));
    await expect(lookup).rejects.toThrow('caller cancelled');
  });

  it('validates the number and the budget before starting a browser', async () => {
    await expect(new PostalNinjaTracker().fetch('https://localhost')).rejects.toThrow('Invalid tracking number');
    await expect(new PostalNinjaTracker({ timeoutMs: Infinity }).fetch(number)).rejects.toThrow('timeout');
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });
});
