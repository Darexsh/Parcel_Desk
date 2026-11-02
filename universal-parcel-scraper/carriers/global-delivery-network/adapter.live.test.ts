import { describe, expect, it } from 'vitest';
import { GdnTracker } from './adapter.js';

describe('Global Delivery Network live tracking', () => {
  it('recognizes the page for a number it does not know', async () => {
    await expect(new GdnTracker().fetch('999999999999')).rejects.toMatchObject({ kind: 'not_found' });
  });
  it.skipIf(!process.env.GDN_TRACKING_NUMBER)('returns matching real scans', async () => {
    expect((await new GdnTracker().fetch(process.env.GDN_TRACKING_NUMBER!)).events?.length).toBeGreaterThan(0);
  });
});
