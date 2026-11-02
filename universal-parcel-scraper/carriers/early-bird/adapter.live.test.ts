import { describe, expect, it } from 'vitest';
import { EarlyBirdTracker } from './adapter.js';

describe('Early Bird live direct retrieval', () => {
  it.skipIf(!process.env.EARLY_BIRD_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new EarlyBirdTracker().fetch(process.env.EARLY_BIRD_TRACKING_NUMBER!);
    expect(result.summary_only ? result.delivery_carrier : result.events!.length).toBeTruthy();
    expect(result.events!.every(event => (event.time ?? event.local_time) && event.description)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.EARLY_BIRD_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new EarlyBirdTracker().fetch(process.env.EARLY_BIRD_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
