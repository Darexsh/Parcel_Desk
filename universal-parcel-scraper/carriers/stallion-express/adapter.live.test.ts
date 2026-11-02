import { describe, expect, it } from 'vitest';
import { StallionTracker } from './adapter.js';

describe('Stallion Express live direct retrieval', () => {
  it.skipIf(!process.env.STALLION_EXPRESS_TRACKING_NUMBER)('retrieves the shipment history', async () => {
    const result = await new StallionTracker().fetch(process.env.STALLION_EXPRESS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => /Z$/.test(event.time ?? ''))).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.STALLION_EXPRESS_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new StallionTracker().fetch(process.env.STALLION_EXPRESS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
