import { describe, expect, it } from 'vitest';
import { BrtTracker } from './adapter.js';

describe('BRT anonymous live history', () => {
  it.skipIf(!process.env.BRT_TRACKING_NUMBER)('retrieves tracking scans for the exact shipment identifier', async () => {
    const result = await new BrtTracker().fetch(process.env.BRT_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    // Scans at BRT's depots in Italy come on Italy's offsets; the newest scan's instant is the last update.
    expect(result.events!.every(event => !event.time || /T\d{2}:\d{2}:00\+0[12]:00$/.test(event.time))).toBe(true);
    expect(result.last_update).toBe(result.events![0]!.time ?? null);
  });
  it.skipIf(!process.env.BRT_UNKNOWN_NUMBER)('identifies the explicit matching no-parcel result', async () => {
    await expect(new BrtTracker().fetch(process.env.BRT_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
