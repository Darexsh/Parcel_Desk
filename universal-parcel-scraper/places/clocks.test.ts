import { describe, expect, it, vi } from 'vitest';
import type { CarrierEvent } from '../core/result/index.js';
import { airportTimeZone, carrierHomeZone, dateLocalClocks, locatePlace, placeTimeZone } from './index.js';

vi.setConfig({ testTimeout: 30_000 });

const zoneOf = (location: string) => placeTimeZone(locatePlace(location)!);
const dated = (event: CarrierEvent | undefined) => event && [event.time, event.time_zone, event.time_zone_basis];

describe('placeTimeZone', () => {
  it('keeps Central time in Florida west of the Apalachicola River, but Eastern in Gulf County south of the waterway', () => {
    for (const town of ['Pensacola, FL', 'Panama City, FL', 'Mexico Beach, FL', 'Marianna, FL', 'Blountstown, FL', 'Wewahitchka, FL']) {
      expect(zoneOf(town), town).toBe('America/Chicago');
    }
    for (const town of ['Port St. Joe, FL', 'Apalachicola, FL', 'Bristol, FL', 'Chattahoochee, FL', 'Tallahassee, FL', 'Orlando, FL']) {
      expect(zoneOf(town), town).toBe('America/New_York');
    }
  });

  it('reads a country of one clock, a state or province, or the nearest zone of a large country', () => {
    expect(zoneOf('Leipzig/Halle Hub')).toBe('Europe/Berlin');
    expect(zoneOf('Changsha')).toBe('Asia/Shanghai');
    expect(zoneOf('Dallas TX')).toBe('America/Chicago');
    expect(zoneOf('PERRIS, CA')).toBe('America/Los_Angeles');
    expect(zoneOf('Brisbane, AU')).toBe('Australia/Brisbane');
    expect(zoneOf('Manaus')).toBe('America/Manaus');
    expect(zoneOf('Tijuana')).toBe('America/Tijuana');
    expect(zoneOf('Las Palmas de Gran Canaria')).toBe('Atlantic/Canary');
    expect(zoneOf('Ponta Delgada')).toBe('Atlantic/Azores');
  });

  it('gives a country with several zones named alone the zone most of its people live on', () => {
    expect(zoneOf('UNITED STATES')).toBe('America/New_York');
  });

  it('reads an airport its code names, alone, with an airport word or with its country', () => {
    expect(locatePlace('AMS')).toBeNull();
    expect(airportTimeZone('AMS')).toBe('Europe/Amsterdam');
    expect(airportTimeZone('Ams')).toBeNull();
    expect(airportTimeZone('JFK Airport')).toBe('America/New_York');
    expect(airportTimeZone('BNE, AU')).toBe('Australia/Brisbane');
    expect(airportTimeZone('BNE, NZ')).toBeNull();
    expect(airportTimeZone('Example Airport')).toBeNull();
  });
});

describe('dateLocalClocks', () => {
  it('dates scans by their place, else by the leg the parcel was on', () => {
    const result = dateLocalClocks('china-post', { status: 'delivered', last_update_local: '2026-10-20T09:00:00', events: [
      { local_time: '2026-10-20T09:00:00', description: 'Delivered', stage: 'delivered' },
      { local_time: '2026-10-19T18:00:00', description: 'Out for delivery', location: 'Madrid' },
      { local_time: '2026-10-18T03:00:00', description: 'Departed' },
      { local_time: '2026-10-15T10:00:00', description: 'Posted', location: '广州' },
    ] });
    expect(result.events!.map(dated)).toEqual([
      ['2026-10-20T09:00:00+02:00', 'Europe/Madrid', 'neighbour'],
      ['2026-10-19T18:00:00+02:00', 'Europe/Madrid', 'place'],
      ['2026-10-18T03:00:00+08:00', 'Asia/Shanghai', 'neighbour'],
      ['2026-10-15T10:00:00+08:00', 'Asia/Shanghai', 'place'],
    ]);
    expect(result.events![0]!.local_time).toBe('2026-10-20T09:00:00');
    expect(result.last_update).toBe('2026-10-20T09:00:00+02:00');
  });

  it('reads scans listed oldest first the same way', () => {
    const result = dateLocalClocks('china-post', { status: 'in_transit', events: [
      { local_time: '2026-10-15T10:00:00', description: 'Posted', location: '广州' },
      { local_time: '2026-10-19T18:00:00', description: 'Arrived', location: 'Madrid' },
      { local_time: '2026-10-20T09:00:00', description: 'Sorted' },
    ] });
    expect(result.events!.map((event) => event.time_zone)).toEqual(['Asia/Shanghai', 'Europe/Madrid', 'Europe/Madrid']);
  });

  it('keeps a scan on the clock of the leg it was on, whatever scans follow', () => {
    const scans: CarrierEvent[] = [
      { local_time: '2026-10-21T09:00:00', description: 'Arrived at facility', location: 'Dallas TX' },
      { local_time: '2026-10-20T02:41:00', description: 'In Transit, Arriving On Time' },
      { local_time: '2026-10-19T08:40:00', description: 'In Transit to Next Facility' },
      { local_time: '2026-10-19T03:00:00', description: 'Departed facility', location: 'Fresno, CA' },
    ];
    const zones = (events: CarrierEvent[]) => dateLocalClocks('usps', { status: 'in_transit', events }).events!.map((event) => event.time_zone);
    expect(zones(scans)).toEqual(['America/Chicago', 'America/Los_Angeles', 'America/Los_Angeles', 'America/Los_Angeles']);
    expect(zones(scans.slice(1))).toEqual(['America/Los_Angeles', 'America/Los_Angeles', 'America/Los_Angeles']);
  });

  it('takes the next place once a scan on the leg says the parcel landed', () => {
    const result = dateLocalClocks('yunexpress', { status: 'in_transit', destination_country: 'ES', events: [
      { local_time: '2026-10-15T10:00:00', description: 'Accepted', location: 'Hanoi' },
      { local_time: '2026-10-16T09:00:00', description: 'Export customs cleared', location: 'Vietnam' },
      { local_time: '2026-10-16T13:00:00', description: 'Handed over to the airline' },
      { local_time: '2026-10-16T23:30:00', description: 'Flight departed' },
      { local_time: '2026-10-17T06:10:00', description: 'Flight landed' },
      { local_time: '2026-10-17T11:00:00', description: 'Arrived at sort facility', location: 'Zaragoza' },
    ] });
    expect(result.events!.map((event) => [event.time_zone, event.time_zone_basis])).toEqual([
      ['Asia/Ho_Chi_Minh', 'place'], ['Asia/Ho_Chi_Minh', 'place'], ['Asia/Ho_Chi_Minh', 'neighbour'],
      ['Asia/Ho_Chi_Minh', 'neighbour'], ['Europe/Madrid', 'neighbour'], ['Europe/Madrid', 'place'],
    ]);
    // With no place before, a scan the parcel lands after is not on the next place's clock.
    const unplaced = dateLocalClocks('yunexpress', { status: 'in_transit', destination_country: 'ES', events: [
      { local_time: '2026-10-16T13:00:00', description: 'Handed over to the airline' },
      { local_time: '2026-10-17T06:10:00', description: 'Flight landed' },
      { local_time: '2026-10-17T11:00:00', description: 'Arrived at sort facility', location: 'Zaragoza' },
    ] });
    expect(unplaced.events!.map((event) => [event.time_zone, event.time_zone_basis])).toEqual([
      ['Asia/Shanghai', 'carrier'], ['Europe/Madrid', 'neighbour'], ['Europe/Madrid', 'place'],
    ]);
  });

  it('dates a scan filed where the parcel was not on the clock of the office that filed it, and lends that clock to no other', () => {
    // The label registered in the United States before the parcel leaves China, newest first.
    const result = dateLocalClocks('jcex', { status: 'in_transit', destination_country: 'US', events: [
      { local_time: '2026-10-20T05:19:21', description: 'Arrived at destination hub', location: 'New York NY', stage: 'in_transit' },
      { local_time: '2026-10-18T06:31:21', description: 'Departed from sort facility', location: 'Shenzhen', stage: 'in_transit' },
      { local_time: '2026-10-17T09:59:03', description: 'Shipment information received', stage: 'registered' },
      { local_time: '2026-10-16T21:59:04', description: 'Shipping label created', location: 'Linden, NJ', stage: 'registered' },
    ] });
    expect(result.events!.map(dated)).toEqual([
      ['2026-10-20T05:19:21-04:00', 'America/New_York', 'place'],
      ['2026-10-18T06:31:21+08:00', 'Asia/Shanghai', 'place'],
      ['2026-10-17T09:59:03+08:00', 'Asia/Shanghai', 'neighbour'],
      ['2026-10-16T21:59:04-04:00', 'America/New_York', 'place'],
    ]);
  });

  it('borrows the clock of an airport its code alone names', () => {
    const result = dateLocalClocks('yunexpress', { status: 'in_transit', events: [
      { local_time: '2026-10-15T10:00:00', description: 'Accepted', location: 'Hanoi' },
      { local_time: '2026-10-16T07:00:00', description: 'Arrived at the airport', location: 'LHR' },
      { local_time: '2026-10-16T09:00:00', description: 'Cargo tally in progress' },
    ] });
    expect(dated(result.events![2])).toEqual(['2026-10-16T09:00:00+01:00', 'Europe/London', 'neighbour']);
  });

  it('dates a scan at an airport its code and an airport word name on that airport’s clock, not its neighbour’s', () => {
    const result = dateLocalClocks('evri', { status: 'in_transit', destination_country: 'US', events: [
      { local_time: '2026-10-21T08:00:00', description: 'Arrived at the destination airport', location: 'JFK Airport' },
      { local_time: '2026-10-20T15:00:00', description: 'Left the hub', location: 'Birmingham' },
    ] });
    expect(result.events!.map(dated)).toEqual([
      ['2026-10-21T08:00:00-04:00', 'America/New_York', 'place'],
      ['2026-10-20T15:00:00+01:00', 'Europe/London', 'place'],
    ]);
  });

  it('dates a scan that names a state alone on the state’s clock', () => {
    const result = dateLocalClocks('couriersplease', { status: 'in_transit', destination_country: 'AU', events: [
      { local_time: '2026-10-21T08:00:00', description: 'Delivered', location: 'WA' },
      { local_time: '2026-10-20T15:00:00', description: 'Arrived at depot', location: 'SA' },
    ] });
    expect(result.events!.map(dated)).toEqual([
      ['2026-10-21T08:00:00+08:00', 'Australia/Perth', 'place'],
      ['2026-10-20T15:00:00+10:30', 'Australia/Adelaide', 'place'],
    ]);
  });

  it('takes a town of the same country around a scan that names only a country with several zones', () => {
    const result = dateLocalClocks('gofo', { status: 'in_transit', events: [
      { local_time: '2026-10-20T09:00:00', description: 'Arrived', location: 'UNITED STATES' },
      { local_time: '2026-10-19T18:00:00', description: 'Sorted', location: 'PERRIS, CA' },
    ] });
    expect(dated(result.events![0])).toEqual(['2026-10-20T09:00:00-07:00', 'America/Los_Angeles', 'neighbour']);
  });

  it('falls back to the destination the carrier delivers in, then to its home clock', () => {
    const scan = { local_time: '2026-03-02T11:00:00', description: 'In transit' };
    expect(dated(dateLocalClocks('mailamericas', { destination_country: 'EC', events: [scan] }).events![0]))
      .toEqual(['2026-03-02T11:00:00-05:00', 'America/Guayaquil', 'destination']);
    expect(dated(dateLocalClocks('mailamericas', { destination_country: 'DO', events: [scan] }).events![0]))
      .toEqual(['2026-03-02T11:00:00-04:00', 'America/Santo_Domingo', 'destination']);
    expect(dated(dateLocalClocks('seur', { events: [scan] }).events![0]))
      .toEqual(['2026-03-02T11:00:00+01:00', 'Europe/Madrid', 'carrier']);
    // A catalog zone of UTC says the feed mixes clocks: the home is the carrier's first country.
    expect(dated(dateLocalClocks('china-post', { events: [scan] }).events![0]))
      .toEqual(['2026-03-02T11:00:00+08:00', 'Asia/Shanghai', 'carrier']);
  });

  it('gives a carrier’s home clock: the zone its result declares, its catalog zone, or with UTC there its first country’s', () => {
    expect(carrierHomeZone('seur')).toBe('Europe/Madrid');
    expect(carrierHomeZone('usps')).toBe('America/New_York');
    expect(carrierHomeZone('china-post')).toBe('Asia/Shanghai');
    expect(carrierHomeZone('usps', { timezone: 'America/Chicago' })).toBe('America/Chicago');
    expect(carrierHomeZone('usps', { timezone: 'Not/AZone' })).toBe('America/New_York');
    expect(carrierHomeZone('unknown')).toBeNull();
  });

  it('reads a wall clock the clocks repeat as its first occurrence', () => {
    const result = dateLocalClocks('seur', { events: [{ local_time: '2026-10-25T02:30:00', description: 'Sorted' }] });
    expect(result.events![0]!.time).toBe('2026-10-25T02:30:00+02:00');
  });

  it('leaves instants, offset-less times and scans dated by their day alone as they are', () => {
    const events: CarrierEvent[] = [
      { time: '2026-03-02T11:00:00+01:00', description: 'Delivered', location: 'Madrid' },
      { time: '2026-03-02T09:00:00', description: 'Out for delivery' },
      { local_time: '2026-03-01', description: 'Sorted' },
    ];
    const result = { status: 'delivered' as const, last_update: '2026-03-02T11:00:00+01:00', events };
    expect(dateLocalClocks('seur', result)).toBe(result);
  });
});
