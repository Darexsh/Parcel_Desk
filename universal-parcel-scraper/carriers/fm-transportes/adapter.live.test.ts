import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { FmTransportesTracker } from './adapter.js';

const ready = Boolean(process.env.FLARESOLVERR_URL && process.env.FM_TRANSPORTES_TRACKING_NUMBER);
describe('FM Transportes guest retrieval', () => {
  it.skipIf(!ready)('reads the same native history in successive fresh guest sessions', async () => {
    const tracker = new FmTransportesTracker({ trawl: TrawlClient.fromEnvironment() });
    const first = await tracker.fetch(process.env.FM_TRANSPORTES_TRACKING_NUMBER!);
    const second = await tracker.fetch(process.env.FM_TRANSPORTES_TRACKING_NUMBER!);
    expect(first.events!.length).toBeGreaterThan(0);
    expect(first.events!.every(event => event.description && /Z$/.test(event.time ?? ''))).toBe(true);
    expect(second).toEqual(first);
  }, 150_000);

  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.FM_TRANSPORTES_UNKNOWN_NUMBER)('keeps an empty guest lookup inconclusive', async () => {
    await expect(new FmTransportesTracker({ trawl: TrawlClient.fromEnvironment() })
      .fetch(process.env.FM_TRANSPORTES_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 75_000);
});
