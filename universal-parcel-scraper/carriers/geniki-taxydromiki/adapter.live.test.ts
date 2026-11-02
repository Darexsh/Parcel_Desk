import { describe, expect, it } from 'vitest';
import { GenikiTracker } from './adapter.js';

describe('Geniki Taxydromiki live tracking', () => {
  it.skipIf(!process.env.GENIKI_TAXYDROMIKI_TRACKING_NUMBER)('returns identity-bound history', async () => {
    const result = await new GenikiTracker().fetch(process.env.GENIKI_TAXYDROMIKI_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => typeof event.provider_code === 'string' && !('point' in event))).toBe(true);
  });

  it.skipIf(!process.env.GENIKI_TAXYDROMIKI_UNKNOWN_NUMBER)('reports an unknown voucher as not found', async () => {
    await expect(new GenikiTracker().fetch(process.env.GENIKI_TAXYDROMIKI_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
