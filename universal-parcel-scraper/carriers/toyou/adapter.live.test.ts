import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { ToyouTracker } from './adapter.js';

const ready = Boolean(process.env.FLARESOLVERR_URL && process.env.TOYOU_TRACKING_NUMBER);
describe('toyou native retrieval', () => {
  it.skipIf(!ready)('reads the same bound customer history with fresh guest tokens', async () => {
    const tracker = new ToyouTracker({ trawl: TrawlClient.fromEnvironment() });
    const first = await tracker.fetch(process.env.TOYOU_TRACKING_NUMBER!);
    const second = await tracker.fetch(process.env.TOYOU_TRACKING_NUMBER!);
    expect(first.events!.length).toBeGreaterThan(0);
    expect(first.events!.every(event => event.description && event.local_time)).toBe(true);
    expect(second).toEqual(first);
  }, 180_000);

  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.TOYOU_UNKNOWN_NUMBER)('reads an explicit same-id negative', async () => {
    await expect(new ToyouTracker({ trawl: TrawlClient.fromEnvironment() })
      .fetch(process.env.TOYOU_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 90_000);
});
