import { describe, expect, it, vi } from 'vitest';
import type { AdapterRegistry } from '../adapter/index.js';
import { trackCarrier } from '../adapter/track.js';
import { UniversalTracker } from '../../providers/universal.js';
import type { CarrierEvent, CarrierResult } from './index.js';
import { readLateRegistrations } from './registration.js';
import { resolveResult } from './resolve.js';

const scan = (time: string, description: string, stage?: string, stage_source?: string): CarrierEvent =>
  ({ time, description, ...(stage ? { stage, stage_source: stage_source ?? 'carrier_map' } : {}) });
const result = (events: CarrierEvent[], current: Partial<CarrierResult> = {}): CarrierResult =>
  ({ status: 'in_transit', current_stage: 'in_transit', last_status_text: events[0]?.description ?? '', last_update: events[0]?.time ?? null,
    expected_delivery: null, ...current, events });
const stages = (answer: CarrierResult) => answer.events!.map(event => [event.description, event.stage ?? null, event.stage_source ?? null]);

describe('late registrations', () => {
  it.each([
    { carrier: 'DHL instruction data', events: [
      scan('2030-01-11T09:12:00+01:00', 'The instruction data for this shipment have been provided by the sender to DHL electronically', 'registered'),
      scan('2030-01-10T21:40:00+01:00', 'The shipment has been processed in the parcel center of origin', 'in_transit'),
      scan('2030-01-10T17:05:00+01:00', 'The shipment has been picked up', 'accepted')], late: 'in_transit' },
    { carrier: 'iMile', events: [
      scan('2030-01-11T10:00:00+04:00', 'Order submitted, pending to receive.', 'registered'),
      scan('2030-01-11T08:30:00+04:00', 'Picked up by courier', 'accepted'),
      scan('2030-01-10T12:00:00+04:00', 'Order submitted, pending to receive.', 'registered')], late: 'in_transit' },
    { carrier: '4PX', events: [
      scan('2030-01-12T03:00:00+08:00', 'Order data transmitted', 'registered'),
      scan('2030-01-11T20:00:00+08:00', 'Departed from facility', 'in_transit'),
      scan('2030-01-11T09:00:00+08:00', 'Label creation', 'registered')], late: 'in_transit' },
    { carrier: 'La Poste', events: [
      scan('2030-01-12T11:30:00+01:00', 'Votre Colissimo va bientôt nous être confié ! Il est en cours de préparation chez l\'expéditeur.', 'registered'),
      scan('2030-01-12T11:05:00+01:00', 'Votre colis est livré.', 'delivered'),
      scan('2030-01-10T08:00:00+01:00', 'Votre Colissimo va bientôt nous être confié ! Il est en cours de préparation chez l\'expéditeur.', 'registered')],
    late: 'in_transit' },
    { carrier: 'Spring GDS on Swiss Post', events: [
      scan('2030-01-11T16:00:00+01:00', 'Consignment recorded by the foreign sender (data delivered)', 'registered'),
      scan('2030-01-11T12:00:00+01:00', 'Item received by the foreign post', 'accepted'),
      scan('2030-01-10T12:00:00+01:00', 'Consignment recorded by the foreign sender (data delivered)', 'registered')], late: 'in_transit' },
  ])('reads $carrier registration after the first movement as $late and keeps the first one', ({ events, late }) => {
    const answer = readLateRegistrations(result(events));
    expect(stages(answer)[0]).toEqual([events[0]!.description, late, 'carrier_map']);
    expect(answer.events!.slice(1)).toEqual(events.slice(1));
  });

  it("reads a provider's copy by the stage its wording gives when it declares none", () => {
    const events = [scan('2030-01-11T06:00:00Z', 'Shipment information received'), scan('2030-01-10T22:00:00Z', 'Departed from facility'),
      scan('2030-01-10T10:00:00Z', 'Shipping label created')];
    expect(stages(readLateRegistrations(result(events)))).toEqual([['Shipment information received', 'in_transit', 'carrier_map'],
      ['Departed from facility', null, null], ['Shipping label created', null, null]]);
    // Through the universal map, as a provider returns it.
    const relayed = [scan('2030-01-11T06:00:00Z', 'Shipment information received', 'registered', 'wording:provider'),
      scan('2030-01-10T22:00:00Z', 'Departed from facility', 'in_transit', 'wording:provider')];
    expect(stages(readLateRegistrations(result(relayed)))[0]).toEqual(['Shipment information received', 'in_transit', 'carrier_map']);
  });

  it('leaves a registration at the instant of the first movement, and every scan without a movement before it', () => {
    const events = [scan('2030-01-10T10:00:00Z', 'Shipping label created', 'registered'), scan('2030-01-10T10:00:00Z', 'Picked up', 'accepted'),
      scan('2030-01-09T10:00:00Z', 'Shipment information received', 'registered')];
    expect(readLateRegistrations(result(events))).toEqual(result(events));
  });

  it('takes no movement from a customs filing, a problem or a scan no rule read', () => {
    const events = [scan('2030-01-11T10:00:00Z', 'Shipping label created', 'registered'),
      scan('2030-01-10T12:00:00Z', 'Electronic customs data sent', 'customs'), scan('2030-01-10T11:00:00Z', 'Label voided', 'exception'),
      scan('2030-01-10T10:00:00Z', 'Synthetic notice', 'in_transit', 'none'), scan('2030-01-10T09:00:00Z', 'Synthetic note no rule reads')];
    expect(readLateRegistrations(result(events))).toEqual(result(events));
    // A registration no map or rule read is left too.
    const unread = [scan('2030-01-11T10:00:00Z', 'Synthetic order row', 'registered', 'none'), scan('2030-01-10T10:00:00Z', 'Picked up', 'accepted')];
    expect(readLateRegistrations(result(unread))).toEqual(result(unread));
  });

  it('orders scans by their instants, or by wall clocks in a history without one, and skips a wall clock among instants', () => {
    const walls = [{ local_time: '2030-01-11T10:00:00', description: 'Shipping label created', stage: 'registered' },
      { local_time: '2030-01-10T10:00:00', description: 'Picked up', stage: 'accepted' }];
    expect(stages(readLateRegistrations(result(walls)))[0]).toEqual(['Shipping label created', 'in_transit', 'carrier_map']);
    const mixed = [walls[0]!, scan('2030-01-10T10:00:00Z', 'Picked up', 'accepted')];
    expect(readLateRegistrations(result(mixed))).toEqual(result(mixed));
    const dated = [scan('2030-01-11', 'Shipping label created', 'registered'), scan('2030-01-10T10:00:00Z', 'Picked up', 'accepted')];
    expect(readLateRegistrations(result(dated))).toEqual(result(dated));
  });

  it('gives the current stage of a newest late registration to the result, and only that one', () => {
    const events = [scan('2030-01-11T10:00:00Z', 'Shipping label created', 'registered'), scan('2030-01-10T10:00:00Z', 'Picked up', 'accepted')];
    expect(readLateRegistrations(result(events, { status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map' })))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    const older = [scan('2030-01-12T10:00:00Z', 'Synthetic summary row', 'registered'), ...events];
    expect(readLateRegistrations(result(older, { status: 'pending', current_stage: 'registered' })))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    const first = [scan('2030-01-10T10:00:00Z', 'Shipping label created', 'registered')];
    expect(readLateRegistrations(result(first, { status: 'pending', current_stage: 'registered' }))).toMatchObject({ current_stage: 'registered' });
  });

  it('reads a result the same a second time', () => {
    const events = [scan('2030-01-12T10:00:00Z', 'Shipping label created', 'registered'), scan('2030-01-11T10:00:00Z', 'Departed', 'in_transit'),
      scan('2030-01-11T09:00:00Z', 'Shipment information received', 'registered'), scan('2030-01-10T10:00:00Z', 'Picked up', 'accepted')];
    const once = readLateRegistrations(result(events, { current_stage: 'registered', status: 'pending' }));
    expect(stages(once).map(([, stage]) => stage)).toEqual(['in_transit', 'in_transit', 'in_transit', 'accepted']);
    expect(readLateRegistrations(once)).toEqual(once);
  });

  it("reads every adapter's and provider's answer so", async () => {
    const events = [scan('2030-01-11T10:00:00Z', 'Shipping label created', 'registered'), scan('2030-01-10T10:00:00Z', 'Picked up', 'accepted')];
    const registry = { for: () => ({ steps: ['direct'], recordsSteps: true, track: async () => result(events) }) } as unknown as AdapterRegistry;
    const universal = {} as UniversalTracker;
    expect(stages(await trackCarrier('dhl', { number: '00340434000000000001' }, { registry, universal }))[0]![1]).toBe('in_transit');
    const browserLookup = vi.fn().mockResolvedValue(result(events));
    const tracker = new UniversalTracker({ providers: ['Ship24'], fetcher: vi.fn<typeof fetch>(), browserLookup });
    expect(stages(await tracker.fetchSource('Ship24', 'ZZ12340678900'))[0]![1]).toBe('in_transit');
    expect(resolveResult(result(events)).events[0]).toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
  });
});
