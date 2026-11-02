import { describe, expect, it } from 'vitest';
import { FoxpostTracker } from './adapter.js';

describe('Foxpost live direct retrieval', () => {
  it.skipIf(!process.env.FOXPOST_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new FoxpostTracker().fetch(process.env.FOXPOST_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.FOXPOST_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new FoxpostTracker().fetch(process.env.FOXPOST_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
