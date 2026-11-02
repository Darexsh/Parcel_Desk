import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('PPL live tracking', () => {
  it.skipIf(!process.env.PPL_TRACKING_NUMBER)('returns coded, dated history over anonymous HTTP', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.PPL_TRACKING_NUMBER! }, { budgetMs: 15_000 }));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.provider_code)).toBe(true);
    expect(result.events?.some(event => event.time)).toBe(true);
  }, 35_000);

  it.skipIf(!process.env.PPL_UNKNOWN_NUMBER)('identifies an explicitly absent parcel', async () => {
    await expect(instance().track({ number: process.env.PPL_UNKNOWN_NUMBER! }, { budgetMs: 15_000 }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 35_000);
});
