import { describe, expect, it } from 'vitest';
import { TccTracker } from './adapter.js';

describe('TCC native secondary history', () => {
  it.skipIf(!process.env.TCC_CO_TRACKING_NUMBER)('reads the same dated milestones in successive lookups', async () => {
    const tracker = new TccTracker();
    const first = await tracker.fetch(process.env.TCC_CO_TRACKING_NUMBER!);
    const second = await tracker.fetch(process.env.TCC_CO_TRACKING_NUMBER!);
    expect(first.history_truncated).toBe(true);
    expect(first.events!.length).toBeGreaterThan(0);
    expect(first.events!.every(event => event.time && event.description)).toBe(true);
    expect(second).toEqual(first);
  }, 45_000);

  it.skipIf(!process.env.TCC_CO_UNKNOWN_NUMBER)('does not claim a missing parcel from an empty secondary history', async () => {
    await expect(new TccTracker().fetch(process.env.TCC_CO_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 30_000);
});
