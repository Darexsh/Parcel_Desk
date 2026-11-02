import { describe, expect, it } from 'vitest';
import { EpostGlobalTracker } from './adapter.js';

describe('ePost Global live direct retrieval', () => {
  it.skipIf(!process.env.EPOST_GLOBAL_TRACKING_NUMBER)('retrieves the shipment history', async () => {
    const result = await new EpostGlobalTracker().fetch(process.env.EPOST_GLOBAL_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.time || event.local_time)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.EPOST_GLOBAL_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new EpostGlobalTracker().fetch(process.env.EPOST_GLOBAL_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
