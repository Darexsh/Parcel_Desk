import { describe, expect, it } from 'vitest';
import { ArasKargoTracker } from './adapter.js';

describe('Aras Kargo live tracking', () => {
  it.skipIf(!process.env.ARAS_KARGO_TRACKING_NUMBER)('returns the parcel history as wall clocks', async () => {
    const result = await new ArasKargoTracker().fetch(process.env.ARAS_KARGO_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });

  it.skipIf(!process.env.ARAS_KARGO_UNKNOWN_NUMBER)('reports an unknown number as not found', async () => {
    await expect(new ArasKargoTracker().fetch(process.env.ARAS_KARGO_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
