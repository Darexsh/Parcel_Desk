import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';

const instance = (trawl: TrawlClient | null = null) => adapter({ trawl, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('DHL eCommerce Poland live tracking', () => {
  it('identifies an absent parcel', async () => {
    await expect(instance().track({ number: '29999999990' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.DHL_ECOMMERCE_PL_TRACKING_NUMBER)('returns the identity-bound current status', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.DHL_ECOMMERCE_PL_TRACKING_NUMBER! }));
    expect(result.current_stage).toBeDefined();
    expect(result.summary_only).toBe(true);
    expect(result.events).toEqual([]);
  });
  it.skipIf(!process.env.DHL_ECOMMERCE_PL_TRACKING_NUMBER || !process.env.FLARESOLVERR_URL)('retrieves full history through the browser service', async () => {
    const result = await instance(new TrawlClient(process.env.FLARESOLVERR_URL!)).track({ number: process.env.DHL_ECOMMERCE_PL_TRACKING_NUMBER! });
    expect(result.summary_only).toBe(false);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => typeof event.local_time === 'string')).toBe(true);
  });
});
