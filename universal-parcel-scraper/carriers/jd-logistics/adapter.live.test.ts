import { describe, expect, it } from 'vitest';
import { JdLogisticsTracker } from './adapter.js';

describe('JD Logistics international live compatibility', () => {
  it.skipIf(!process.env.JD_LOGISTICS_TRACKING_NUMBER)('returns identity-bound international history', async () => {
    const result = await new JdLogisticsTracker().fetch(process.env.JD_LOGISTICS_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.description && (event.time || event.local_time))).toBe(true);
  });
});
