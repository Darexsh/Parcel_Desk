import { describe, expect, it } from 'vitest';
import { VenipakTracker } from './adapter.js';

describe('Venipak live direct retrieval', () => {
  it.skipIf(!process.env.VENIPAK_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new VenipakTracker().fetch(process.env.VENIPAK_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.VENIPAK_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new VenipakTracker().fetch(process.env.VENIPAK_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
