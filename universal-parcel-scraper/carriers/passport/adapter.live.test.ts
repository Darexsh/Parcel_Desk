import { describe, expect, it } from 'vitest';
import { PassportTracker } from './adapter.js';

describe('Passport live direct retrieval', () => {
  it.skipIf(!process.env.PASSPORT_TRACKING_NUMBER)('retrieves the shipment history', async () => {
    const result = await new PassportTracker().fetch(process.env.PASSPORT_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (event.time?.endsWith('Z') || event.local_time))).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.PASSPORT_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new PassportTracker().fetch(process.env.PASSPORT_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
