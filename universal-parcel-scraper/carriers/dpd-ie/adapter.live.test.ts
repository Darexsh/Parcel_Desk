import { describe, expect, it } from 'vitest';
import { DpdIeTracker } from './adapter.js';

describe('DPD Ireland live direct retrieval', () => {
  it.skipIf(!process.env.DPD_IE_TRACKING_NUMBER)('retrieves the consignment history', async () => {
    const result = await new DpdIeTracker().fetch(process.env.DPD_IE_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time || (event.local_time && event.provider_time_text))).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.DPD_IE_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new DpdIeTracker().fetch(process.env.DPD_IE_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
