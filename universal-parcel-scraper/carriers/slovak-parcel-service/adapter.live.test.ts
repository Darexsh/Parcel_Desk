import { describe, expect, it } from 'vitest';
import { SlovakParcelServiceTracker } from './adapter.js';

describe('Slovak Parcel Service live direct retrieval', () => {
  it.skipIf(!process.env.SLOVAK_PARCEL_SERVICE_TRACKING_NUMBER)('retrieves the parcel history', async () => {
    const result = await new SlovakParcelServiceTracker().fetch(process.env.SLOVAK_PARCEL_SERVICE_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.time === undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))
      && event.provider_code)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.SLOVAK_PARCEL_SERVICE_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new SlovakParcelServiceTracker().fetch(process.env.SLOVAK_PARCEL_SERVICE_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
