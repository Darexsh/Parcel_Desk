import { describe, expect, it } from 'vitest';
import { PinAgTracker } from './adapter.js';

describe('PIN AG live direct retrieval', () => {
  it.skipIf(!process.env.PIN_AG_TRACKING_NUMBER)('retrieves the item history', async () => {
    const result = await new PinAgTracker().fetch(process.env.PIN_AG_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(event.local_time ?? '') && event.provider_code)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.PIN_AG_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new PinAgTracker().fetch(process.env.PIN_AG_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
