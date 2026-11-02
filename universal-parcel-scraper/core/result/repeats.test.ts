import { describe, expect, it, vi } from 'vitest';
import type { AdapterRegistry } from '../adapter/index.js';
import { trackCarrier } from '../adapter/track.js';
import { UniversalTracker } from '../../providers/universal.js';
import type { CarrierEvent, CarrierResult } from './index.js';
import { withoutRepeatedScans } from './repeats.js';

const scan = (time: string, description: string, stage = 'in_transit', more: Partial<CarrierEvent> = {}): CarrierEvent =>
  ({ time, description, stage, stage_source: 'carrier_map', ...more });
const result = (events: CarrierEvent[]): CarrierResult =>
  ({ status: 'in_transit', current_stage: 'in_transit', last_status_text: events[0]?.description ?? '', last_update: events[0]?.time ?? null,
    expected_delivery: null, events });
const kept = (answer: CarrierResult) => (answer.events ?? []).map(event => `${event.time} ${event.description}`);

describe('withoutRepeatedScans', () => {
  it('reads a step recorded again within minutes once, from its first record', () => {
    const departed = 'Departure from the international sorting center';
    const events = [
      scan('2030-01-10T04:56:22.265Z', departed, 'in_transit', { provider_code: 'GATEWAY' }),
      scan('2030-01-10T04:56:22.214Z', 'Processed at the sorting center', 'in_transit', { provider_code: 'SORTED' }),
      scan('2030-01-10T04:56:18.469Z', departed, 'in_transit', { provider_code: 'GATEWAY' }),
      scan('2030-01-10T04:55:00Z', departed, 'in_transit', { provider_code: 'GATEWAY' }),
      scan('2030-01-10T04:54:01Z', departed, 'in_transit', { provider_code: 'GATEWAY' }),
      scan('2030-01-10T04:54:00Z', departed, 'in_transit', { provider_code: 'GATEWAY' }),
      scan('2030-01-09T18:19:01Z', 'Processed at the sorting center', 'in_transit', { provider_code: 'SORTED' }),
      scan('2030-01-09T18:19:00Z', 'Processed at the sorting center', 'in_transit', { provider_code: 'DEPARTED' }),
    ];
    const once = withoutRepeatedScans(result(events));
    expect(kept(once)).toEqual([
      `2030-01-10T04:56:22.214Z Processed at the sorting center`,
      `2030-01-10T04:54:00Z ${departed}`,
      `2030-01-09T18:19:00Z Processed at the sorting center`,
    ]);
    expect(once.events![2]).toEqual(events[7]);
    expect(withoutRepeatedScans(once)).toEqual(once);
    const tied = [scan('2030-01-10T10:00:00Z', 'Arrived at the hub', 'in_transit', { tie_order: 1, provider_code: 'B' }),
      scan('2030-01-10T10:00:00Z', 'Arrived at the hub', 'in_transit', { tie_order: 0, provider_code: 'A' })];
    expect(withoutRepeatedScans(result(tied)).events).toEqual([tied[1]]);
  });

  it('keeps a repeat after a scan of another stage, or later than ten minutes, or elsewhere', () => {
    const events = [
      scan('2030-01-10T10:20:00Z', 'Out for delivery', 'out_for_delivery'),
      scan('2030-01-10T10:10:00Z', 'Delivery attempted', 'failed_attempt'),
      scan('2030-01-10T10:00:00Z', 'Out for delivery', 'out_for_delivery'),
      scan('2030-01-09T10:10:01Z', 'Arrived at the hub'),
      scan('2030-01-09T10:00:00Z', 'Arrived at the hub'),
      scan('2030-01-08T10:01:00Z', 'Arrived at the hub', 'in_transit', { location: 'Second Town' }),
      scan('2030-01-08T10:00:00Z', 'Arrived at the hub', 'in_transit', { location: 'First Town' }),
      scan('2030-01-07T10:01:00Z', ''),
      scan('2030-01-07T10:00:00Z', ''),
    ];
    const answer = result(events);
    expect(withoutRepeatedScans(answer)).toBe(answer);
  });

  it('compares wording and place as written, and reads wall clocks in a history without instants', () => {
    const events: CarrierEvent[] = [
      { local_time: '2030-01-10T09:05:00', description: 'Delivery attempted:  recipient absent', location: 'SAMPLE HUB', stage: 'failed_attempt' },
      { local_time: '2030-01-10T09:04:30', description: 'Delivery attempted: recipient absent', location: 'Sample hub', stage: 'failed_attempt' },
      { local_time: '2030-01-10T09:04:00', description: 'Delivery attempted: recipient absent', location: 'Sample hub', stage: 'failed_attempt' },
      { time: '2030-01-10', description: 'Delivery attempted: recipient absent', location: 'Sample hub', stage: 'failed_attempt' },
    ];
    expect(withoutRepeatedScans(result(events)).events).toEqual([events[2], events[3]]);
  });

  it("reads every adapter's and provider's answer so", async () => {
    const events = [scan('2030-01-10T10:02:00Z', 'Arrived at the hub'), scan('2030-01-10T10:00:00Z', 'Arrived at the hub')];
    const registry = { for: () => ({ steps: ['direct'], recordsSteps: true, track: async () => result(events) }) } as unknown as AdapterRegistry;
    const universal = {} as UniversalTracker;
    expect((await trackCarrier('dhl', { number: '00340434000000000001' }, { registry, universal })).events).toHaveLength(1);
    const browserLookup = vi.fn().mockResolvedValue(result(events));
    const tracker = new UniversalTracker({ providers: ['Ship24'], fetcher: vi.fn<typeof fetch>(), browserLookup });
    expect((await tracker.fetchSource('Ship24', 'ZZ12340678900')).events).toHaveLength(1);
  });
});
