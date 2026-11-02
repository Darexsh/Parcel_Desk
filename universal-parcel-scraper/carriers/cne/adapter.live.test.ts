import { describe, expect, it } from 'vitest';
import { CneTracker } from './adapter.js';

describe('CNE live direct retrieval', () => {
  it.skipIf(!process.env.CNE_TRACKING_NUMBER)('retrieves shipment movements from the public website API', async () => {
    const result = await new CneTracker().fetch(process.env.CNE_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.last_status_text).toBeTruthy();
  });
});
