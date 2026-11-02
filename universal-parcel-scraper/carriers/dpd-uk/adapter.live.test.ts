import { describe, expect, it } from 'vitest';
import { DpdUkTracker } from './adapter.js';

describe('DPD UK live direct retrieval', () => {
  it.skipIf(!process.env.DPD_UK_TRACKING_NUMBER)('retrieves public history without a postcode', async () => {
    const result = await new DpdUkTracker().fetch(process.env.DPD_UK_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.DPD_UK_UNKNOWN_NUMBER)('distinguishes an explicit unknown reference', async () => {
    await expect(new DpdUkTracker().fetch(process.env.DPD_UK_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
