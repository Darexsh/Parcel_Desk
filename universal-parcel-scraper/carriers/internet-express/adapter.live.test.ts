import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('Internet Express live tracking', () => {
  it.skipIf(!process.env.INTERNET_EXPRESS_TRACKING_NUMBER)('returns the shipment’s history', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.INTERNET_EXPRESS_TRACKING_NUMBER! }));
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => typeof event.time === 'string')).toBe(true);
  });

  it.skipIf(!process.env.INTERNET_EXPRESS_UNKNOWN_NUMBER)('reads an unknown reference as not found', async () => {
    await expect(instance().track({ number: process.env.INTERNET_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
