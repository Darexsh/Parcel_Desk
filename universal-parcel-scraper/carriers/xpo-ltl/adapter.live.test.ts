import { describe, expect, it } from 'vitest';
import { XpoLtlTracker } from './adapter.js';
import { TrawlClient } from '../../core/transport/trawl.js';

describe('XPO live direct retrieval', () => {
  it.skipIf(!process.env.XPO_LTL_TRACKING_NUMBER)('retrieves the shipment history', async () => {
    const trawl = process.env.FLARESOLVERR_URL ? new TrawlClient(process.env.FLARESOLVERR_URL) : null;
    const result = await new XpoLtlTracker({ trawl }).fetch(process.env.XPO_LTL_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.local_time || event.time)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
    expect(result.provider_code).toMatch(/^\d{1,3}$/);
  });
  it.skipIf(!process.env.XPO_LTL_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new XpoLtlTracker().fetch(process.env.XPO_LTL_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
