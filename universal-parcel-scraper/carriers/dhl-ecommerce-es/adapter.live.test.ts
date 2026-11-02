import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('DHL eCommerce Iberia live tracking', () => {
  it('identifies an absent parcel', async () => {
    await expect(instance().track({ number: 'ES00000010' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.DHL_ECOMMERCE_ES_TRACKING_NUMBER)('returns identity-bound public history', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.DHL_ECOMMERCE_ES_TRACKING_NUMBER! }));
    expect(result.events?.length).toBeGreaterThan(0);
  });
});
