import { describe, expect, it } from 'vitest';
import { PurolatorTracker } from './adapter.js';

describe('Purolator live tracking', () => {
  it.skipIf(!process.env.PUROLATOR_TRACKING_NUMBER)('returns matching real history', async () => {
    const result = await new PurolatorTracker().fetch(process.env.PUROLATOR_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
  });

  it.skipIf(!process.env.PUROLATOR_UNKNOWN_NUMBER)('reports an unknown PIN as inconclusive with its not-found reason', async () => {
    await expect(new PurolatorTracker().fetch(process.env.PUROLATOR_UNKNOWN_NUMBER!))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });
});
