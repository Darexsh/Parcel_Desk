import { describe, expect, it } from 'vitest';
import { FanCourierTracker } from './adapter.js';

describe('FAN Courier live tracking', () => {
  it.skipIf(!process.env.FAN_COURIER_TRACKING_NUMBER)('returns identity-bound history', async () => {
    const result = await new FanCourierTracker().fetch(process.env.FAN_COURIER_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => typeof event.provider_code === 'string')).toBe(true);
  });

  it.skipIf(!process.env.FAN_COURIER_UNKNOWN_NUMBER)('reports an unknown AWB as not found', async () => {
    await expect(new FanCourierTracker().fetch(process.env.FAN_COURIER_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
