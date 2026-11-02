import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { ZoomTracker } from './adapter.js';

const ready = Boolean(process.env.FLARESOLVERR_URL && process.env.ZOOM_VE_TRACKING_NUMBER);
describe('Zoom native retrieval', () => {
  it.skipIf(!ready)('reads the same bound history on successive browser lookups', async () => {
    const tracker = new ZoomTracker({ trawl: TrawlClient.fromEnvironment() });
    const first = await tracker.fetch(process.env.ZOOM_VE_TRACKING_NUMBER!);
    const second = await tracker.fetch(process.env.ZOOM_VE_TRACKING_NUMBER!);
    expect(first.events!.length).toBeGreaterThan(0);
    expect(first.events!.every(event => event.description && event.local_time)).toBe(true);
    expect(second).toEqual(first);
  }, 180_000);

  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.ZOOM_VE_UNKNOWN_NUMBER)('reads the completed bound missing-tracking notice', async () => {
    await expect(new ZoomTracker({ trawl: TrawlClient.fromEnvironment() })
      .fetch(process.env.ZOOM_VE_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 90_000);
});
