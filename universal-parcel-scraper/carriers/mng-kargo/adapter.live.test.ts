import { describe, expect, it } from 'vitest';
import { MngKargoTracker } from './adapter.js';

describe('DHL eCommerce Türkiye live tracking', () => {
  it.skipIf(!process.env.MNG_KARGO_TRACKING_NUMBER)('returns identity-bound history', async () => {
    const result = await new MngKargoTracker().fetch(process.env.MNG_KARGO_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => typeof event.local_time === 'string' && !('time' in event))).toBe(true);
  });

  it.skipIf(!process.env.MNG_KARGO_UNKNOWN_NUMBER)('reports an unknown number as not found', async () => {
    await expect(new MngKargoTracker().fetch(process.env.MNG_KARGO_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
