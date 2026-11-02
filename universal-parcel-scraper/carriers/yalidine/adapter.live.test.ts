import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { YalidineTracker } from './adapter.js';

const ready = Boolean(process.env.FLARESOLVERR_URL && process.env.YALIDINE_TRACKING_NUMBER);
describe('Yalidine native retrieval', () => {
  it.skipIf(!ready)('reads the same bound history in successive fresh guest sessions', async () => {
    const tracker = new YalidineTracker({ trawl: TrawlClient.fromEnvironment() });
    const first = await tracker.fetch(process.env.YALIDINE_TRACKING_NUMBER!);
    const second = await tracker.fetch(process.env.YALIDINE_TRACKING_NUMBER!);
    expect(first.events!.length).toBeGreaterThan(0);
    expect(first.events!.every(event => event.description && event.provider_time_text && !event.time && !event.local_time)).toBe(true);
    expect(first.last_update).toBeNull();
    expect(second).toEqual(first);
  }, 180_000);

  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.YALIDINE_UNKNOWN_NUMBER)('reads a verified missing-parcel notice', async () => {
    await expect(new YalidineTracker({ trawl: TrawlClient.fromEnvironment() })
      .fetch(process.env.YALIDINE_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 90_000);
});
