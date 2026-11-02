import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { KolayGelsinTracker } from './adapter.js';

const ready = Boolean(process.env.FLARESOLVERR_URL && process.env.KOLAY_GELSIN_TRACKING_NUMBER);
describe('Kolay Gelsin guest retrieval', () => {
  it.skipIf(!ready)('reads the same public milestones in successive fresh guest sessions', async () => {
    const tracker = new KolayGelsinTracker({ trawl: TrawlClient.fromEnvironment() });
    const first = await tracker.fetch(process.env.KOLAY_GELSIN_TRACKING_NUMBER!);
    const second = await tracker.fetch(process.env.KOLAY_GELSIN_TRACKING_NUMBER!);
    expect(first.events!.length).toBeGreaterThan(0);
    expect(first.history_truncated).toBe(true);
    expect(first.events!.every(event => event.description && (event.time || event.local_time))).toBe(true);
    expect(second).toEqual(first);
  }, 180_000);

  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.KOLAY_GELSIN_UNKNOWN_NUMBER)('does not claim absence after refused or inconclusive verification', async () => {
    const lookup = new KolayGelsinTracker({ trawl: TrawlClient.fromEnvironment() }).fetch(process.env.KOLAY_GELSIN_UNKNOWN_NUMBER!);
    await expect(lookup).rejects.toHaveProperty('kind', expect.stringMatching(/^(challenge|indeterminate)$/));
  }, 90_000);
});
