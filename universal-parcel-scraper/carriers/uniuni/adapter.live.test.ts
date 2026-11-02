import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('UniUni live tracking', () => {
  it.skipIf(!process.env.UNIUNI_TRACKING_NUMBER)('returns identity-bound history', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.UNIUNI_TRACKING_NUMBER! }));
    expect(result.events?.length).toBeGreaterThan(0);
  });

  it.skipIf(!process.env.UNIUNI_UNKNOWN_NUMBER)('identifies explicit absence', async () => {
    await expect(instance().track({ number: process.env.UNIUNI_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.UNIUNI_ESTIMATE_TRACKING_NUMBER)('adds an enabled estimate to active history', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.UNIUNI_ESTIMATE_TRACKING_NUMBER! }));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.current_stage).not.toBe('delivered');
    expect(result.current_stage).not.toBe('returned');
    expect(result.expected_delivery).toBeTruthy();
  });
});
