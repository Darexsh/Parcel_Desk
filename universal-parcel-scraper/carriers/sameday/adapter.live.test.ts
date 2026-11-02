import { describe, expect, it } from 'vitest';
import { SamedayTracker } from './adapter.js';

describe('Sameday live tracking', () => {
  it.skipIf(!process.env.SAMEDAY_TRACKING_NUMBER)('returns identity-bound history', async () => {
    const result = await new SamedayTracker().fetch(process.env.SAMEDAY_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every((event) => typeof event.time === 'string' && event.provider_code)).toBe(true);
  });

  it.skipIf(!process.env.SAMEDAY_UNKNOWN_NUMBER)('reports a number no country knows as not found', async () => {
    await expect(new SamedayTracker().fetch(process.env.SAMEDAY_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
