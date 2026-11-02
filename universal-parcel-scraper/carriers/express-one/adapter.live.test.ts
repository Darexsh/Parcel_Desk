import { describe, expect, it } from 'vitest';
import { ExpressOneTracker } from './adapter.js';

describe('Express One live direct retrieval', () => {
  it.skipIf(!process.env.EXPRESS_ONE_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new ExpressOneTracker().fetch(process.env.EXPRESS_ONE_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.provider_code)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.EXPRESS_ONE_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new ExpressOneTracker().fetch(process.env.EXPRESS_ONE_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
