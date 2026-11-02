import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('DHL eCommerce UK live tracking', () => {
  it('identifies an absent shipment', async () => {
    await expect(instance().track({ number: '99990000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.DHL_ECOMMERCE_UK_TRACKING_NUMBER)('returns identity-bound public history', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.DHL_ECOMMERCE_UK_TRACKING_NUMBER! }));
    expect(result.events?.length).toBeGreaterThan(0);
  });
});
